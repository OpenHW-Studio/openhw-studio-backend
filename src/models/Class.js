import mongoose from "mongoose";

const classSchema = new mongoose.Schema({
  name: { type: String, required: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  joinCode: { type: String, required: true, unique: true },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  assignments: [{ type: mongoose.Schema.Types.ObjectId, ref: "Assignment" }]
}, { timestamps: true });

export default mongoose.model("Class", classSchema);
