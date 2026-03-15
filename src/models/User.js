import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  googleId: { type: String },
  password: { type: String }, // Optional for Google Auth users
  role: { type: String, enum: ["student", "teacher", "admin"], default: "student" },
  classes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Class" }],
  points: { type: Number, default: 0 },
  coins: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  badges: [String],
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("User", userSchema);
