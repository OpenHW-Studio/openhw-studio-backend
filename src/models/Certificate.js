import mongoose from 'mongoose';

const domainSchema = new mongoose.Schema({
  domain: { type: String, required: true },
  skills: [{ type: String }],
}, { _id: false });

const certificateSchema = new mongoose.Schema({
  certId: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    index: true,
  },
  userId: {
    type: String,
    required: true,
    index: true,
  },
  recipientName: {
    type: String,
    required: true,
    trim: true,
  },
  recipientEmail: {
    type: String,
    trim: true,
    lowercase: true,
  },
  recipientSchool: {
    type: String,
    trim: true,
    default: '',
  },
  classStandard: {
    type: String,
    trim: true,
    default: '',
  },
  track: {
    type: String,
    required: true,
    enum: ['arduino', 'esp32', 'stm32', 'pico'],
    index: true,
  },
  trackCode: {
    type: String,
    required: true,
    uppercase: true,
    default: 'ARD',
  },
  trackTitle: {
    type: String,
    required: true,
  },
  domains: [domainSchema],
  competencies: [{ type: String }],
  projectsCompleted: [{ type: String }],
  totalProjectsRequired: {
    type: Number,
    required: true,
  },
  issuedAt: {
    type: Date,
    default: Date.now,
  },
  status: {
    type: String,
    enum: ['active', 'revoked'],
    default: 'active',
    index: true,
  },
}, { timestamps: true });

export default mongoose.model('Certificate', certificateSchema);
