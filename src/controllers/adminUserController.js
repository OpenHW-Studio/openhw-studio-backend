import User from '../models/User.js';
import BlockedEmail from '../models/BlockedEmail.js';
import AuditLog from '../models/AuditLog.js';
import Class from '../models/Class.js';
import UserProgress from '../models/UserProgress.js';
import Otp from '../models/Otp.js';
import sendEmail from '../utils/sendEmail.js';
import {
  buildRoleChangeEmail,
  buildSuspensionEmail,
  buildUnsuspensionEmail,
  buildBlockEmail,
  buildUnblockEmail,
  buildPermanentDeletionEmail,
} from '../utils/userEmailTemplates.js';

/**
 * Helper: record an audit log safely without interrupting response flow
 */
const logAudit = async (adminEmail, action, details, metadata = {}, ip = '') => {
  try {
    await AuditLog.create({
      adminEmail,
      action,
      details,
      metadata,
      ip,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('[AdminUserController:AuditLog] Error logging:', err.message);
  }
};

/**
 * Helper: Send email safely with fallback logging
 */
const safeSendEmail = async (emailOptions) => {
  try {
    await sendEmail(emailOptions);
    return { success: true };
  } catch (err) {
    console.error('[AdminUserController:Email] Failed to send email to', emailOptions.email, err.message);
    return { success: false, error: err.message };
  }
};

// ─── 1. Get Users List with Search, Filters & Stats ──────────────────────────
export const getUsers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const { search, role, status, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const filter = {};

    // Search query: matches name, email, or username
    if (search && search.trim().length > 0) {
      const term = search.trim();
      const regex = new RegExp(term, 'i');
      filter.$or = [
        { name: regex },
        { email: regex },
        { username: regex },
      ];
    }

    // Role filter
    if (role && role !== 'all') {
      filter.role = role;
    }

    // Status filter
    if (status && status !== 'all') {
      if (status === 'blocked') {
        filter.$or = [{ status: 'blocked' }, { isBlocked: true }];
      } else {
        filter.status = status;
      }
    }

    const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const [users, totalCount, statsCounts, blockedEmailCount] = await Promise.all([
      User.find(filter)
        .select('-password -resetPasswordToken -resetPasswordExpires')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
      User.aggregate([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            studentCount: { $sum: { $cond: [{ $eq: ['$role', 'student'] }, 1, 0] } },
            teacherCount: { $sum: { $cond: [{ $eq: ['$role', 'teacher'] }, 1, 0] } },
            adminCount: { $sum: { $cond: [{ $eq: ['$role', 'admin'] }, 1, 0] } },
            userCount: { $sum: { $cond: [{ $eq: ['$role', 'user'] }, 1, 0] } },
            suspendedCount: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } },
            blockedUsersCount: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'blocked'] }, { $eq: ['$isBlocked', true] }] }, 1, 0] } },
          },
        },
      ]),
      BlockedEmail.countDocuments(),
    ]);

    const statsRaw = statsCounts[0] || {
      totalUsers: 0,
      studentCount: 0,
      teacherCount: 0,
      adminCount: 0,
      userCount: 0,
      suspendedCount: 0,
      blockedUsersCount: 0,
    };

    // Total blocked includes any user flagged blocked or entries in BlockedEmail
    const totalBlocked = Math.max(statsRaw.blockedUsersCount, blockedEmailCount);

    return res.status(200).json({
      success: true,
      users,
      pagination: {
        total: totalCount,
        page,
        limit,
        pages: Math.ceil(totalCount / limit) || 1,
      },
      stats: {
        total: statsRaw.totalUsers,
        students: statsRaw.studentCount,
        teachers: statsRaw.teacherCount,
        admins: statsRaw.adminCount,
        generalUsers: statsRaw.userCount,
        suspended: statsRaw.suspendedCount,
        blocked: totalBlocked,
      },
    });
  } catch (err) {
    console.error('[getUsers] Error:', err);
    return res.status(500).json({ error: 'Failed to retrieve users.' });
  }
};

// ─── 2. Get Single User Details ──────────────────────────────────────────────
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id)
      .select('-password -resetPasswordToken -resetPasswordExpires')
      .populate('classes', 'name joinCode')
      .lean();

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const blockedEntry = await BlockedEmail.findOne({ email: user.email?.toLowerCase() }).lean();

    return res.status(200).json({
      success: true,
      user: {
        ...user,
        blockedEmailRecord: blockedEntry || null,
      },
    });
  } catch (err) {
    console.error('[getUserById] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch user details.' });
  }
};

// ─── 3. Update User Role ─────────────────────────────────────────────────────
export const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body || {};

    const allowedRoles = ['student', 'teacher', 'admin', 'user'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed roles: ${allowedRoles.join(', ')}` });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Safety guardrail: Admin cannot demote their own account
    if (String(user._id) === String(req.user._id) && role !== 'admin') {
      return res.status(403).json({ error: 'You cannot remove admin privileges from your own account.' });
    }

    const oldRole = user.role;
    if (oldRole === role) {
      return res.status(200).json({ message: `User already has the role: ${role}`, user });
    }

    user.role = role;
    await user.save();

    // Log to AuditLog
    await logAudit(
      req.user.email,
      'update_user_role',
      `Changed role of ${user.email} from ${oldRole} to ${role}`,
      { targetUserId: user._id, oldRole, newRole: role, email: user.email },
      req.ip
    );

    // Send role notification email
    const emailData = buildRoleChangeEmail(user.name || user.username || 'there', role, oldRole);
    const emailResult = await safeSendEmail({
      email: user.email,
      subject: emailData.subject,
      message: emailData.message,
      html: emailData.html,
    });

    return res.status(200).json({
      success: true,
      message: `User role successfully updated to ${role}.`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
      },
      emailSent: emailResult.success,
    });
  } catch (err) {
    console.error('[updateUserRole] Error:', err);
    return res.status(500).json({ error: 'Failed to update user role.' });
  }
};

// ─── 4. Suspend User ─────────────────────────────────────────────────────────
export const suspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { durationHours, untilDate, reason = 'Administrative review' } = req.body || {};

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Safety: Admin cannot suspend self
    if (String(user._id) === String(req.user._id)) {
      return res.status(403).json({ error: 'You cannot suspend your own account.' });
    }

    let calculatedUntil = null;
    let durationText = 'Indefinite';

    if (durationHours && Number(durationHours) > 0) {
      calculatedUntil = new Date(Date.now() + Number(durationHours) * 3600 * 1000);
      durationText = `${durationHours} hour(s)`;
    } else if (untilDate) {
      calculatedUntil = new Date(untilDate);
      if (isNaN(calculatedUntil.getTime()) || calculatedUntil <= new Date()) {
        return res.status(400).json({ error: 'Invalid suspension date. Date must be in the future.' });
      }
      durationText = `Until ${calculatedUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    }

    user.status = 'suspended';
    user.suspendedUntil = calculatedUntil;
    user.suspensionReason = reason.trim();
    user.suspendedAt = new Date();
    await user.save();

    await logAudit(
      req.user.email,
      'suspend_user',
      `Suspended user ${user.email} (${durationText}). Reason: ${reason}`,
      { targetUserId: user._id, email: user.email, suspendedUntil: calculatedUntil, reason },
      req.ip
    );

    // Send suspension email
    const resumeDateStr = calculatedUntil ? calculatedUntil.toUTCString() : null;
    const emailData = buildSuspensionEmail(user.name || 'there', durationText, reason, resumeDateStr);
    const emailResult = await safeSendEmail({
      email: user.email,
      subject: emailData.subject,
      message: emailData.message,
      html: emailData.html,
    });

    return res.status(200).json({
      success: true,
      message: `User account suspended successfully.`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        status: user.status,
        suspendedUntil: user.suspendedUntil,
        suspensionReason: user.suspensionReason,
      },
      emailSent: emailResult.success,
    });
  } catch (err) {
    console.error('[suspendUser] Error:', err);
    return res.status(500).json({ error: 'Failed to suspend user.' });
  }
};

// ─── 5. Unsuspend User ───────────────────────────────────────────────────────
export const unsuspendUser = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    user.status = 'active';
    user.suspendedUntil = null;
    user.suspensionReason = '';
    user.suspendedAt = null;
    await user.save();

    await logAudit(
      req.user.email,
      'unsuspend_user',
      `Lifted suspension for user ${user.email}`,
      { targetUserId: user._id, email: user.email },
      req.ip
    );

    const emailData = buildUnsuspensionEmail(user.name || 'there');
    const emailResult = await safeSendEmail({
      email: user.email,
      subject: emailData.subject,
      message: emailData.message,
      html: emailData.html,
    });

    return res.status(200).json({
      success: true,
      message: `User suspension lifted. Account is now active.`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        status: user.status,
      },
      emailSent: emailResult.success,
    });
  } catch (err) {
    console.error('[unsuspendUser] Error:', err);
    return res.status(500).json({ error: 'Failed to unsuspend user.' });
  }
};

// ─── 6. Block User & Email ───────────────────────────────────────────────────
/**
 * Blocks a user's account and permanently records their email in BlockedEmail.
 * Note: Blocking does NOT delete the user account.
 * If the user account is deleted in the future, BlockedEmail preserves the block.
 */
export const blockUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'Violation of platform terms of service' } = req.body || {};

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Safety: Admin cannot block self
    if (String(user._id) === String(req.user._id)) {
      return res.status(403).json({ error: 'You cannot block your own admin account.' });
    }

    const cleanEmail = (user.email || '').trim().toLowerCase();
    if (!cleanEmail) {
      return res.status(400).json({ error: 'User has no registered email to block.' });
    }

    // 1. Create or update BlockedEmail record
    await BlockedEmail.findOneAndUpdate(
      { email: cleanEmail },
      {
        email: cleanEmail,
        reason: reason.trim(),
        blockedBy: req.user._id,
        blockedByName: req.user.name || req.user.email || 'Administrator',
        originalUserId: user._id,
        originalUserName: user.name || user.username || '',
        blockedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // 2. Mark user document as blocked (does NOT delete user)
    user.status = 'blocked';
    user.isBlocked = true;
    user.blockReason = reason.trim();
    user.blockedAt = new Date();
    await user.save();

    await logAudit(
      req.user.email,
      'block_user_and_email',
      `Blocked user ${user.email}. Reason: ${reason}`,
      { targetUserId: user._id, email: user.email, reason },
      req.ip
    );

    // 3. Send block notice email
    const emailData = buildBlockEmail(user.name || 'there', user.email, reason);
    const emailResult = await safeSendEmail({
      email: user.email,
      subject: emailData.subject,
      message: emailData.message,
      html: emailData.html,
    });

    return res.status(200).json({
      success: true,
      message: `User ${user.email} has been blocked. They cannot log in or re-register.`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        status: user.status,
        isBlocked: user.isBlocked,
        blockReason: user.blockReason,
      },
      emailSent: emailResult.success,
    });
  } catch (err) {
    console.error('[blockUser] Error:', err);
    return res.status(500).json({ error: 'Failed to block user.' });
  }
};

// ─── 7. Unblock Email / User ─────────────────────────────────────────────────
/**
 * Unblocks an email address.
 * Accepts either { email } or { userId }.
 * Removes entry from BlockedEmail, and restores User record if it exists.
 */
export const unblockUser = async (req, res) => {
  try {
    const { email, userId } = req.body || {};

    let targetEmail = (email || '').trim().toLowerCase();
    let targetUser = null;

    if (userId) {
      targetUser = await User.findById(userId);
      if (targetUser && targetUser.email) {
        targetEmail = targetUser.email.trim().toLowerCase();
      }
    }

    if (!targetEmail && !targetUser) {
      return res.status(400).json({ error: 'Please provide either an email or userId to unblock.' });
    }

    if (!targetUser && targetEmail) {
      targetUser = await User.findOne({ email: targetEmail });
    }

    // 1. Remove from BlockedEmail collection
    const deleteResult = await BlockedEmail.deleteOne({ email: targetEmail });

    // 2. If user document exists, restore active state
    if (targetUser) {
      targetUser.isBlocked = false;
      if (targetUser.status === 'blocked') {
        targetUser.status = 'active';
      }
      targetUser.blockReason = '';
      targetUser.blockedAt = null;
      await targetUser.save();
    }

    await logAudit(
      req.user.email,
      'unblock_user_and_email',
      `Unblocked email ${targetEmail}`,
      { targetEmail, userId: targetUser ? targetUser._id : null },
      req.ip
    );

    // 3. Send unblock email notification
    const recipientName = targetUser ? targetUser.name : 'there';
    const emailData = buildUnblockEmail(recipientName, targetEmail);
    const emailResult = await safeSendEmail({
      email: targetEmail,
      subject: emailData.subject,
      message: emailData.message,
      html: emailData.html,
    });

    return res.status(200).json({
      success: true,
      message: `Email ${targetEmail} has been unblocked.`,
      email: targetEmail,
      userRestored: Boolean(targetUser),
      emailSent: emailResult.success,
    });
  } catch (err) {
    console.error('[unblockUser] Error:', err);
    return res.status(500).json({ error: 'Failed to unblock email.' });
  }
};

// ─── 8. Get All Blocked Emails (Independent Blocklist) ────────────────────────
export const getBlockedEmails = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const { search } = req.query;
    const filter = {};

    if (search && search.trim().length > 0) {
      const term = search.trim();
      filter.$or = [
        { email: new RegExp(term, 'i') },
        { reason: new RegExp(term, 'i') },
        { originalUserName: new RegExp(term, 'i') },
      ];
    }

    const [blockedList, totalCount] = await Promise.all([
      BlockedEmail.find(filter)
        .sort({ blockedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      BlockedEmail.countDocuments(filter),
    ]);

    // Check if user accounts still exist for each blocked email
    const emails = blockedList.map(b => b.email);
    const existingUsers = await User.find({ email: { $in: emails } }).select('_id email status').lean();
    const existingUserMap = new Map(existingUsers.map(u => [u.email.toLowerCase(), u]));

    const enrichedList = blockedList.map(item => ({
      ...item,
      accountExists: existingUserMap.has(item.email.toLowerCase()),
      currentUserId: existingUserMap.get(item.email.toLowerCase())?._id || null,
      currentStatus: existingUserMap.get(item.email.toLowerCase())?.status || 'account_deleted',
    }));

    return res.status(200).json({
      success: true,
      blockedEmails: enrichedList,
      pagination: {
        total: totalCount,
        page,
        limit,
        pages: Math.ceil(totalCount / limit) || 1,
      },
    });
  } catch (err) {
    console.error('[getBlockedEmails] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch blocked emails list.' });
  }
};

// ─── 9. Permanently Delete User ──────────────────────────────────────────────
/**
 * Permanently purges user data, progress, classroom enrollments.
 * If user was blocked, their email remains in BlockedEmail so they cannot re-register.
 */
export const deleteUserPermanently = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Safety: Admin cannot delete self
    if (String(user._id) === String(req.user._id)) {
      return res.status(403).json({ error: 'You cannot delete your own admin account.' });
    }

    const userEmail = user.email;
    const userId = user._id;
    const userRole = user.role;
    const wasBlocked = user.isBlocked || user.status === 'blocked';

    // 1. Remove from enrolled classes
    await Class.updateMany(
      { students: userId },
      { $pull: { students: userId } }
    );

    // 2. Anonymize classes if teacher
    if (userRole === 'teacher') {
      await Class.updateMany(
        { teacher: userId },
        { $set: { teacher: null } }
      );
    }

    // 3. Purge UserProgress
    await UserProgress.deleteOne({ userId: String(userId) });

    // 4. Delete OTP records
    if (userEmail) {
      await Otp.deleteMany({ email: userEmail });
    }

    // 5. Send permanent deletion notice email
    if (userEmail) {
      const emailData = buildPermanentDeletionEmail(user.name || 'there');
      await safeSendEmail({
        email: userEmail,
        subject: emailData.subject,
        message: emailData.message,
        html: emailData.html,
      });
    }

    // 6. Delete User document
    // NOTE: BlockedEmail is NOT touched. If user was blocked, their blocklist entry remains!
    await User.deleteOne({ _id: userId });

    // 7. Audit Log
    await logAudit(
      req.user.email,
      'delete_user_permanently',
      `Permanently deleted user ${userEmail} (${userRole}). BlockedEmail preserved: ${wasBlocked}`,
      { targetUserId: userId, email: userEmail, role: userRole, wasBlocked },
      req.ip
    );

    return res.status(200).json({
      success: true,
      message: `User ${userEmail} and associated data were permanently deleted.`,
      emailRemainsBlocked: wasBlocked,
    });
  } catch (err) {
    console.error('[deleteUserPermanently] Error:', err);
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
};
