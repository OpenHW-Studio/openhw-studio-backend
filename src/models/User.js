import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["student", "teacher", "admin"], default: "student" },
  college: { type: String, trim: true },
  branch: { type: String, trim: true },
  semester: { type: Number, min: 1, max: 12 },
  bio: { type: String, trim: true, maxlength: 500 },
  classes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Class" }],
  points: { type: Number, default: 0 },
  coins: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  badges: [String]
}, { timestamps: true });

export default mongoose.model("User", userSchema);
