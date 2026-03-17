import mongoose from "mongoose";

const assignmentSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
  title: { type: String, required: true },
  description: { type: String },
  templateProjectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
  dueDate: { type: Date },
  attachments: [{ type: String, trim: true }],
  files: [{ type: String, trim: true }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

export default mongoose.model("Assignment", assignmentSchema);
