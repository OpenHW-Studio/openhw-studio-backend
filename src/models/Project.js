const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  board: { type: String, enum: ["arduino", "esp32", "rp2040"], required: true },
  components: { type: Array, default: [] },
  connections: { type: Array, default: [] },
  code: { type: String, default: "" },
  isAssignment: { type: Boolean, default: false },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Assignment" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Project", projectSchema);
