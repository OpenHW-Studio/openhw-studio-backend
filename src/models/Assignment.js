const mongoose = require("mongoose");

const assignmentSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
  title: { type: String, required: true },
  description: { type: String },
  templateProjectId: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
  dueDate: { type: Date },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Assignment", assignmentSchema);
