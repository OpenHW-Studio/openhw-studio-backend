import mongoose from 'mongoose';

const blockedEmailSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  },
  reason: {
    type: String,
    trim: true,
    default: 'Violation of platform terms of service',
  },
  blockedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  blockedByName: {
    type: String,
    trim: true,
    default: 'Administrator',
  },
  originalUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  originalUserName: {
    type: String,
    trim: true,
    default: '',
  },
  blockedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, { timestamps: true });

export default mongoose.model('BlockedEmail', blockedEmailSchema);
