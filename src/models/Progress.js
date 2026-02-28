import mongoose from "mongoose";

const progressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  unlockedComponents: [String],
  badges: [String]
});

export default mongoose.model("Progress", progressSchema);
