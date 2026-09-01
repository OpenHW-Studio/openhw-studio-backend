/**
 * Account Purge & Reminder Worker
 *
 * Runs scheduled checks to:
 *   1. Send a 1-day (24 hours) final reminder to accounts nearing their permanent deletion date.
 *   2. Permanently purge expired accounts (after 30-day grace period), anonymizing academic records
 *      and sending a final deletion confirmation email.
 */

import cron from 'node-cron';
import User from '../models/User.js';
import UserProgress from '../models/UserProgress.js';
import Otp from '../models/Otp.js';
import Submission from '../models/Submission.js';
import Class from '../models/Class.js';
import AuditLog from '../models/AuditLog.js';
import sendEmail from '../utils/sendEmail.js';
import { buildDeletionReminderEmail, buildDeletionCompletedEmail } from '../utils/otpEmail.js';

const formatDate = (date) =>
  date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Send 1-day reminder emails to users with <= 24 hours left in grace period.
 */
async function send1DayReminders() {
  try {
    const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const usersNeedingReminder = await User.find({
      status: 'pending_deletion',
      deletionReminderSent: { $ne: true },
      permanentDeleteAt: { $lte: oneDayFromNow, $gt: new Date() },
    });

    for (const user of usersNeedingReminder) {
      const firstName = user.name?.split(' ')[0] || 'there';
      const formattedDate = formatDate(new Date(user.permanentDeleteAt));
      const emailContent = buildDeletionReminderEmail(firstName, formattedDate);

      try {
        await sendEmail({
          email: user.email,
          subject: emailContent.subject,
          message: emailContent.message,
          html: emailContent.html,
        });

        user.deletionReminderSent = true;
        await user.save();
        console.log(`[AccountPurge] Sent 1-day deletion reminder to ${user.email}`);
      } catch (emailErr) {
        console.error(`[AccountPurge] Failed to send reminder email to ${user.email}:`, emailErr.message);
      }
    }
  } catch (err) {
    console.error('[AccountPurge] Error during 1-day reminder check:', err.message);
  }
}

/**
 * Permanently purge a single expired user account.
 * Anonymizes academic records, removes PII, notifies user, and deletes the user document.
 */
async function purgeExpiredAccount(user) {
  const userId = user._id;
  const userEmail = user.email;
  const userRole = user.role;
  const firstName = user.name?.split(' ')[0] || 'there';

  console.log(`[AccountPurge] Purging account: ${userEmail} (role: ${userRole})`);

  try {
    // ── 1. Send final deletion completed confirmation email ───────────────────
    try {
      const emailContent = buildDeletionCompletedEmail(firstName);
      await sendEmail({
        email: userEmail,
        subject: emailContent.subject,
        message: emailContent.message,
        html: emailContent.html,
      });
      console.log(`[AccountPurge] Sent deletion completed email to ${userEmail}`);
    } catch (emailErr) {
      console.error(`[AccountPurge] Failed to send deletion completed email to ${userEmail}:`, emailErr.message);
    }

    // ── 2. Anonymize classroom submissions (if student) ───────────────────────
    if (userRole === 'student') {
      const subResult = await Submission.updateMany(
        { studentId: userId },
        { $set: { studentId: null } }
      );
      console.log(`[AccountPurge] Anonymized ${subResult.modifiedCount} submission(s).`);

      // Remove student from class rosters
      const classResult = await Class.updateMany(
        { students: userId },
        { $pull: { students: userId } }
      );
      console.log(`[AccountPurge] Removed from ${classResult.modifiedCount} class(es).`);
    }

    // ── 3. Anonymize teacher's classes (if teacher) ───────────────────────────
    if (userRole === 'teacher') {
      const classResult = await Class.updateMany(
        { teacher: userId },
        { $set: { teacher: null } }
      );
      console.log(`[AccountPurge] Anonymized ${classResult.modifiedCount} class(es) (teacher field nulled).`);
    }

    // ── 4. Delete UserProgress ────────────────────────────────────────────────
    await UserProgress.deleteOne({ userId: String(userId) });
    console.log(`[AccountPurge] UserProgress deleted.`);

    // ── 5. Delete any pending OTPs for this email ─────────────────────────────
    await Otp.deleteMany({ email: userEmail });

    // ── 6. Write compliance audit log BEFORE deleting the user ───────────────
    await AuditLog.create({
      action: 'account_permanently_deleted',
      targetId: String(userId),
      targetType: 'User',
      performedBy: 'system:purge-worker',
      metadata: {
        email: userEmail,
        role: userRole,
        deletionRequestedAt: user.deletionRequestedAt,
        permanentDeleteAt: user.permanentDeleteAt,
        deletionReason: user.deletionReason || 'not_provided',
        deletionFeedback: user.deletionFeedback || '',
        purgedAt: new Date(),
      },
    });

    // ── 7. Permanently delete the User document ───────────────────────────────
    await User.deleteOne({ _id: userId });
    console.log(`[AccountPurge] User document permanently deleted.`);
  } catch (err) {
    console.error(`[AccountPurge] Failed to purge ${userEmail}:`, err.message);
  }
}

/**
 * Main worker routine — runs 1-day reminder checks and purges expired accounts.
 */
async function runPurgeJob() {
  console.log('[AccountPurge] Running scheduled account purge and reminder check...');
  try {
    // 1. Process 1-day reminders
    await send1DayReminders();

    // 2. Find and purge expired accounts
    const expiredUsers = await User.find({
      status: 'pending_deletion',
      permanentDeleteAt: { $lte: new Date() },
    }).lean(false);

    if (expiredUsers.length === 0) {
      console.log('[AccountPurge] No accounts pending permanent purge.');
      return;
    }

    console.log(`[AccountPurge] Found ${expiredUsers.length} account(s) to purge.`);
    for (const user of expiredUsers) {
      await purgeExpiredAccount(user);
    }
    console.log('[AccountPurge] Purge job completed.');
  } catch (err) {
    console.error('[AccountPurge] Purge job failed:', err.message);
  }
}

/**
 * Start the account purge & reminder worker.
 * Checks every hour to ensure reminders and purges are processed in a timely manner.
 */
export function startAccountPurgeWorker() {
  // Run on startup
  runPurgeJob();

  // Run at minute 5 of every hour
  cron.schedule('5 * * * *', runPurgeJob, {
    timezone: 'UTC',
  });

  console.log('[AccountPurge] Account purge & reminder worker scheduled (hourly).');
}
