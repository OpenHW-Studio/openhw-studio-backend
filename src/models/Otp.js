import mongoose from 'mongoose';

/**
 * OTP Collection — stores pending email-verification codes.
 * Each document auto-expires (TTL index) after 10 minutes so
 * MongoDB cleans them up automatically without any cron job.
 */
const otpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  otp: {
    type: String,    // Stored as a bcrypt hash so plain code never sits in DB
    required: true,
  },
  purpose: {
    type: String,
    enum: ['signup', 'login', 'account_deletion', 'account_reactivation', 'password_reset'],
    default: 'signup',
  },
  userData: {
    type: mongoose.Schema.Types.Mixed,  // Stores pending signup payload
    default: null,
  },
  attempts: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 600,   // 10 minutes — MongoDB TTL auto-deletes the document
  },
});

// Compound index to allow only one pending OTP per email+purpose
otpSchema.index({ email: 1, purpose: 1 }, { unique: false });

export default mongoose.model('Otp', otpSchema);
