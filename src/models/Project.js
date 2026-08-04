import mongoose from "mongoose";

const projectSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  projectId: { type: String, required: true },
  name: { type: String, default: "Untitled" },
  board: { type: String, default: "arduino_uno" },
  components: { type: Array, default: [] },
  connections: { type: Array, default: [] },
  wires: { type: Array, default: [] },
  code: { type: String, default: "" },
  blocklyXml: { type: String, default: "" },
  blocklyGeneratedCode: { type: String, default: "" },
  useBlocklyCode: { type: Boolean, default: false },
  projectFiles: { type: Array, default: [] },
  openCodeTabs: { type: Array, default: [] },
  activeCodeFileId: { type: String, default: "" },
  thumbnail: { type: String, default: "" },
  version: { type: Number, default: 1 },
  savedAt: { type: Number, default: Date.now },
}, { timestamps: true });

projectSchema.index({ userId: 1, savedAt: -1 });
projectSchema.index({ projectId: 1, userId: 1 }, { unique: true });

export default mongoose.model("Project", projectSchema);
