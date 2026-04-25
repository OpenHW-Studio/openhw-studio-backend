import mongoose from "mongoose";

const assignmentSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
  title: { type: String, required: true },
  description: { type: String },
  templateProjectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
  templateShareId: { type: String, trim: true },
  templateUrl: { type: String, trim: true },
  dueDate: { type: Date },
  links: [{ type: String, trim: true }],
  attachments: [{ type: String, trim: true }],
  files: [{ type: String, trim: true }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

export default mongoose.model("Assignment", assignmentSchema);
