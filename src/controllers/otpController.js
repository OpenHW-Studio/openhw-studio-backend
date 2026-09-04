/**
 * OTP Controller
 * Handles email-based signup verification via 6-digit OTP.
 *
 * Flow:
 *   1. POST /api/user/send-otp     — Generate & email OTP, hold signup data temporarily
 *   2. POST /api/user/verify-otp   — Validate OTP, create user account, return JWT
 */

import crypto from 'crypto';
import argon2 from 'argon2';
import User from '../models/User.js';
import Otp from '../models/Otp.js';
import BlockedEmail from '../models/BlockedEmail.js';
import generateToken from '../utils/helper/token.js';
import sendEmail from '../utils/sendEmail.js';
import { buildOtpEmail } from '../utils/otpEmail.js';
import { buildWelcomeOnboardingEmail } from '../utils/userEmailTemplates.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const normalizeEmail = (raw = '') => raw.trim().toLowerCase();

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

const isValidEmailFormat = (v = '') =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const isStrongPassword = (pw = '') =>
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@#$!%*?&]).{8,}$/.test(pw);

const serializeUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  school: user.school,
  classStandard: user.classStandard,
  bio: user.bio,
  image: user.image,
  points: user.points,
  coins: user.coins,
  level: user.level,
  badges: user.badges,
});

/** Generate a cryptographically secure 6-digit OTP */
const generateOtp = () =>
  String(crypto.randomInt(100000, 999999));

// ─── Rate-limit helper (max 3 sends per email per 10 min window) ─────────────
const MAX_OTP_ATTEMPTS = 3;

// ─── Send OTP ─────────────────────────────────────────────────────────────────
/**
 * POST /api/user/send-otp
 * Body: { name, email, password, role?, college?, semester?, bio?, image? }
 *
 * Validates the signup data first. If valid, generates an OTP,
 * stores the hashed OTP + pending userData in the Otp collection,
 * and sends the code to the supplied email address.
 */
export const sendOtp = async (req, res) => {
  try {
    const {
      name, email, password,
      role, college, semester, bio, image,
    } = req.body || {};

    // ── 1. Basic validation ──────────────────────────────────────────────────
    if (!isNonEmptyString(name) || !isNonEmptyString(email) || !isNonEmptyString(password)) {
      return res.status(400).json({
        error: 'Name, email, and password must be non-empty strings.',
      });
    }

    const sanitizedEmail = normalizeEmail(email);
    if (!isValidEmailFormat(sanitizedEmail)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error:
          'Password must be at least 8 characters and include an uppercase letter, ' +
          'a lowercase letter, a number, and a special symbol (@#$!%*?&).',
      });
    }

    // ── 2. Check email is not blocked on the platform ───────────────────────
    const isBlocked = await BlockedEmail.findOne({ email: sanitizedEmail }).select('_id').lean();
    if (isBlocked) {
      return res.status(403).json({
        error: 'This email address has been blocked from registering on this platform. Please contact support if you believe this is an error.',
      });
    }

    // ── 3. Check email is not already registered ─────────────────────────────
    const existingUser = await User.findOne({ email: sanitizedEmail }).select('_id').lean();
    if (existingUser) {
      return res.status(409).json({
        error: 'An account with this email already exists. Please sign in instead.',
      });
    }

    // ── 3. Rate-limit: delete any existing OTP record first ──────────────────
    //    Count how many OTPs were sent in last 10 min (they auto-expire anyway).
    //    If the existing record still exists it means the user is retrying quickly.
    await Otp.deleteMany({ email: sanitizedEmail, purpose: 'signup' });

    // ── 4. Generate OTP & hash it for storage ────────────────────────────────
    const otp = generateOtp();
    const hashedOtp = await argon2.hash(otp);

    // ── 5. Hash the password so it's ready to save after verification ────────
    const hashedPassword = await argon2.hash(password);

    const allowedRoles = ['student', 'teacher', 'user'];
    const selectedRole = allowedRoles.includes(role) ? role : 'user';

    // Store the pre-hashed user data so verify-otp can create the user atomically
    await Otp.create({
      email: sanitizedEmail,
      otp: hashedOtp,
      purpose: 'signup',
      userData: {
        name: name.trim(),
        email: sanitizedEmail,
        password: hashedPassword,
        role: selectedRole,
        school: isNonEmptyString(college) ? college.trim() : undefined,
        classStandard: isNonEmptyString(semester) ? semester.trim() : undefined,
        bio: isNonEmptyString(bio) ? bio.trim() : undefined,
        image: isNonEmptyString(image) ? image.trim() : undefined,
      },
    });

    // ── 6. Send the email ────────────────────────────────────────────────────
    const { subject, message, html } = buildOtpEmail(otp, name.trim().split(' ')[0]);
    await sendEmail({ email: sanitizedEmail, subject, message, html });

    return res.status(200).json({
      message: `A 6-digit verification code has been sent to ${sanitizedEmail}. It expires in 10 minutes.`,
    });
  } catch (err) {
    console.error('[sendOtp] Error:', err);
    return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
};

// ─── Verify OTP & create account ─────────────────────────────────────────────
/**
 * POST /api/user/verify-otp
 * Body: { email, otp }
 *
 * Verifies the submitted OTP against the stored hash.
 * On success: creates the user account and returns a JWT (same as /signup).
 * On failure: increments attempt counter; after 3 wrong guesses the OTP is voided.
 */
export const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body || {};

    if (!isNonEmptyString(email) || !isNonEmptyString(otp)) {
      return res.status(400).json({ error: 'Email and OTP are required.' });
    }

    const sanitizedEmail = normalizeEmail(email);

    // ── 1. Find the pending OTP record ───────────────────────────────────────
    const record = await Otp.findOne({ email: sanitizedEmail, purpose: 'signup' });

    if (!record) {
      return res.status(400).json({
        error: 'No verification code found for this email. Please request a new one.',
      });
    }

    // ── 2. Brute-force guard ─────────────────────────────────────────────────
    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(429).json({
        error:
          'Too many incorrect attempts. Your verification code has been invalidated. ' +
          'Please request a new one.',
      });
    }

    // ── 3. Verify OTP ────────────────────────────────────────────────────────
    const isMatch = await argon2.verify(record.otp, otp.trim());
    if (!isMatch) {
      record.attempts += 1;
      await record.save();
      const remaining = MAX_OTP_ATTEMPTS - record.attempts;
      return res.status(400).json({
        error: `Incorrect verification code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
      });
    }

    // ── 4. OTP valid — double-check email not blocked or registered in the meantime ─────
    const isBlocked = await BlockedEmail.findOne({ email: sanitizedEmail }).select('_id').lean();
    if (isBlocked) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(403).json({
        error: 'This email address has been blocked from registering on this platform.',
      });
    }

    const existingUser = await User.findOne({ email: sanitizedEmail }).select('_id').lean();
    if (existingUser) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(409).json({
        error: 'An account with this email already exists. Please sign in.',
      });
    }

    // ── 5. Create the user ───────────────────────────────────────────────────
    const { userData } = record;
    const user = await User.create(userData);

    // ── Send Onboarding Welcome Email in background ──────────────────────────
    try {
      const emailContent = buildWelcomeOnboardingEmail(user.name || 'there');
      sendEmail({
        email: user.email,
        subject: emailContent.subject,
        message: emailContent.message,
        html: emailContent.html,
      }).catch((emailErr) => {
        console.error('[verifyOtp:WelcomeEmail] Failed to send welcome email:', emailErr.message);
      });
    } catch (err) {
      console.error('[verifyOtp:WelcomeEmail] Template build error:', err.message);
    }

    // ── 6. Clean up OTP record ───────────────────────────────────────────────
    await Otp.deleteOne({ _id: record._id });

    // ── 7. Issue JWT ─────────────────────────────────────────────────────────
    const token = generateToken(user, user.role);
    res.cookie('jwt', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      message: 'Email verified! Your account has been created successfully.',
      token,
      user: serializeUser(user),
    });
  } catch (err) {
    console.error('[verifyOtp] Error:', err);
    return res.status(500).json({ error: 'Failed to verify code. Please try again.' });
  }
};
