import mongoose from "mongoose";

const submissionSchema = new mongoose.Schema({
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment", required: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
  simulationShareId: { type: String, trim: true },
  simulationUrl: { type: String, trim: true },
  notes: { type: String, trim: true },
  links: [{ type: String, trim: true }],
  attachments: [{ type: String, trim: true }],
  files: [{ type: String, trim: true }],
  score: { type: Number },
  feedback: { type: String },
  screenshotUrl: { type: String, trim: true, default: "" }, // Image captured from emulator
  autoGrade: {
    score: { type: Number, min: 0, max: 100, default: null },
    summary: { type: String, default: "" },
    errors: [{ component: String, description: String }],
    suggestions: [{ area: String, tip: String }],
    gradedAt: { type: Date },
    rawResponse: { type: String }
  }
}, { timestamps: true });

submissionSchema.index({ assignmentId: 1, studentId: 1 }, { unique: true });

export default mongoose.model("Submission", submissionSchema);