/**
 * Account Deletion Controller
 *
 * Flow:
 *   1. POST /api/user/delete-account/request-otp  — Send OTP to user's email
 *   2. POST /api/user/delete-account/confirm       — Verify OTP → soft-delete
 *   3. POST /api/user/delete-account/cancel        — Cancel within grace period
 */

import crypto from 'crypto';
import argon2 from 'argon2';
import User from '../models/User.js';
import Otp from '../models/Otp.js';
import sendEmail from '../utils/sendEmail.js';
import { buildDeletionOtpEmail, buildDeletionScheduledEmail } from '../utils/otpEmail.js';

const DELETION_GRACE_DAYS = 30;
const MAX_OTP_ATTEMPTS = 3;

/** Format a Date as "1 October 2026" */
const formatDate = (date) =>
  date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** Generate a cryptographically secure 6-digit OTP */
const generateOtp = () => String(crypto.randomInt(100000, 999999));

// ─── 1. Request Deletion OTP ──────────────────────────────────────────────────
/**
 * POST /api/user/delete-account/request-otp
 * Requires: authenticated user (protectRoute)
 *
 * Sends a 6-digit OTP to the user's registered email to confirm deletion.
 */
export const requestDeletionOtp = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.status === 'pending_deletion') {
      return res.status(400).json({
        error: 'Your account is already scheduled for deletion. Log in to cancel instead.',
      });
    }

    // Clean up any existing deletion OTPs for this email
    await Otp.deleteMany({ email: user.email, purpose: 'account_deletion' });

    // Generate and hash OTP
    const otp = generateOtp();
    const hashedOtp = await argon2.hash(otp);

    await Otp.create({
      email: user.email,
      otp: hashedOtp,
      purpose: 'account_deletion',
      userData: {}, // not needed for deletion
    });

    // Calculate the permanent deletion date
    const deletionDate = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const firstName = user.name?.split(' ')[0] || 'there';
    const { subject, message, html } = buildDeletionOtpEmail(otp, firstName, formatDate(deletionDate));

    await sendEmail({ email: user.email, subject, message, html });

    return res.status(200).json({
      message: `A confirmation code has been sent to ${user.email}. It expires in 10 minutes.`,
    });
  } catch (err) {
    console.error('[requestDeletionOtp] Error:', err);
    return res.status(500).json({ error: 'Failed to send confirmation code. Please try again.' });
  }
};

// ─── 2. Confirm Deletion ──────────────────────────────────────────────────────
/**
 * POST /api/user/delete-account/confirm
 * Body: { otp }
 * Requires: authenticated user (protectRoute)
 *
 * Verifies OTP → sets status to pending_deletion → logs user out immediately.
 */
export const confirmDeletion = async (req, res) => {
  try {
    const { otp } = req.body || {};
    if (!otp || String(otp).trim().length === 0) {
      return res.status(400).json({ error: 'OTP code is required.' });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Find pending OTP record
    const record = await Otp.findOne({ email: user.email, purpose: 'account_deletion' });
    if (!record) {
      return res.status(400).json({
        error: 'No confirmation code found. Please request a new one.',
      });
    }

    // Brute-force guard
    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(429).json({
        error: 'Too many incorrect attempts. Please request a new confirmation code.',
      });
    }

    // Verify OTP
    const isMatch = await argon2.verify(record.otp, String(otp).trim());
    if (!isMatch) {
      record.attempts += 1;
      await record.save();
      const remaining = MAX_OTP_ATTEMPTS - record.attempts;
      return res.status(400).json({
        error: remaining > 0
          ? `Incorrect code. ${remaining} attempt(s) remaining.`
          : 'Too many incorrect attempts. Please request a new confirmation code.',
      });
    }

    // OTP verified — soft-delete the account
    const permanentDeleteAt = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
    user.status = 'pending_deletion';
    user.deletionRequestedAt = new Date();
    user.permanentDeleteAt = permanentDeleteAt;
    user.deletionReminderSent = false;
    await user.save();

    // Clean up OTP record
    await Otp.deleteOne({ _id: record._id });

    // Send confirmation email detailing the 30-day grace period
    try {
      const firstName = user.name?.split(' ')[0] || 'there';
      const formattedDate = formatDate(permanentDeleteAt);
      const emailContent = buildDeletionScheduledEmail(firstName, formattedDate);
      await sendEmail({
        email: user.email,
        subject: emailContent.subject,
        message: emailContent.message,
        html: emailContent.html,
      });
    } catch (emailErr) {
      console.error('[confirmDeletion] Failed to send scheduled deletion email:', emailErr.message);
    }

    // Log the user out
    res.clearCookie('jwt', { httpOnly: true, sameSite: 'strict' });
    if (req.session) req.session.destroy?.();

    return res.status(200).json({
      message: `Your account has been deactivated. It will be permanently deleted on ${formatDate(permanentDeleteAt)}.`,
      permanentDeleteAt,
    });
  } catch (err) {
    console.error('[confirmDeletion] Error:', err);
    return res.status(500).json({ error: 'Failed to process deletion. Please try again.' });
  }
};

// ─── 3. Cancel Deletion ───────────────────────────────────────────────────────
/**
 * POST /api/user/delete-account/cancel
 * Requires: authenticated user (protectRoute), status must be pending_deletion
 *
 * Restores the account to active within the 30-day grace period.
 */
export const cancelDeletion = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.status !== 'pending_deletion') {
      return res.status(400).json({ error: 'Your account is not scheduled for deletion.' });
    }

    // Reactivate
    user.status = 'active';
    user.deletionRequestedAt = null;
    user.permanentDeleteAt = null;
    user.deletionReminderSent = false;
    await user.save();

    return res.status(200).json({
      message: 'Your account deletion has been cancelled. Welcome back!',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
      },
    });
  } catch (err) {
    console.error('[cancelDeletion] Error:', err);
    return res.status(500).json({ error: 'Failed to cancel deletion. Please try again.' });
  }
};
