import mongoose from "mongoose";

const systemTelemetrySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, unique: true, index: true }, // Format: YYYY-MM-DD
    compileSuccess: { type: Number, default: 0 },
    compileFail: { type: Number, default: 0 },
    totalCompileTimeMs: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("SystemTelemetry", systemTelemetrySchema);
