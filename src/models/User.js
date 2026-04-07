import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
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
  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date }
}, { timestamps: true });

export default mongoose.model("User", userSchema);
