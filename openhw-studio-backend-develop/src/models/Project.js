import mongoose from "mongoose";

const projectSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  board: { type: String, enum: ["arduino", "esp32", "rp2040"], required: true },
  components: { type: Array, default: [] },
  connections: { type: Array, default: [] },
  code: { type: String, default: "" },
  isAssignment: { type: Boolean, default: false },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment" }
}, { timestamps: true });

export default mongoose.model("Project", projectSchema);
