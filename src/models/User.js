import mongoose from "mongoose";

const sharedProjectSchema = new mongoose.Schema({
  shareId: { type: String, required: true },
  name: { type: String, default: "Untitled" },
  isPublic: { type: Boolean, default: true },
  board: { type: String, default: "arduino_uno" },
  components: { type: Array, default: [] },
  connections: { type: Array, default: [] },
  code: { type: String, default: "" },
  projectFiles: { type: Array, default: [] },
  openCodeTabs: { type: Array, default: [] },
  activeCodeFileId: { type: String, default: "" },
}, { _id: false, timestamps: true });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, sparse: true },
  username: { type: String, unique: true, sparse: true },
  unique_id: { type: String },
  dob_day: { type: String },
  dob_month: { type: String },
  dob_year: { type: String },
  is_first_login: { type: Boolean, default: true },
  failed_attempts: { type: Number, default: 0 },
  account_locked_until: { type: Date },
  googleId: { type: String },
  password: { type: String }, // Optional for Google Auth users
  role: { type: String, enum: ["student", "teacher", "admin", "user"], default: "student" },
  school: { type: String, trim: true },
  classStandard: { type: String, trim: true },
  bio: { type: String, trim: true, maxlength: 500 },
  image: { type: String, trim: true },
  classes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Class" }],
  points: { type: Number, default: 0 },
  coins: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  badges: [String],
  projects: { type: [sharedProjectSchema], default: [] },
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },
  // ── Account Deletion, Suspension & Blocking ───────────────────────────
  status: {
    type: String,
    enum: ['active', 'pending_deletion', 'suspended', 'blocked'],
    default: 'active',
    index: true,
  },
  deletionRequestedAt: { type: Date, default: null },
  permanentDeleteAt:   { type: Date, default: null },
  deletionReminderSent: { type: Boolean, default: false },
  deletionReason:      { type: String, trim: true, default: '' },
  deletionFeedback:    { type: String, trim: true, default: '' },
  // Suspension
  suspendedUntil:      { type: Date, default: null },
  suspensionReason:    { type: String, trim: true, default: '' },
  suspendedAt:         { type: Date, default: null },
  // Blocking
  isBlocked:           { type: Boolean, default: false, index: true },
  blockReason:         { type: String, trim: true, default: '' },
  blockedAt:           { type: Date, default: null },
}, { timestamps: true });

export default mongoose.model("User", userSchema);
