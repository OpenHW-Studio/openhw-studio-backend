import mongoose from "mongoose";

const liveEditRequestSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    userName: { type: String, required: true },
    requestedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const liveParticipantSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    userName: { type: String, required: true },
  },
  { _id: false },
);

const liveSimulationSessionSchema = new mongoose.Schema(
  {
    sessionCode: { type: String, required: true, unique: true, index: true },
    classId: { type: String, required: true, index: true },
    className: { type: String, trim: true, default: "Live Class" },
    teacherId: { type: String, required: true, index: true },
    teacherName: { type: String, trim: true, default: "Teacher" },
    studentIds: { type: [String], default: [] },
    studentRoster: { type: [liveParticipantSchema], default: [] },
    editorStudentIds: { type: [String], default: [] },
    pendingEditRequests: { type: [liveEditRequestSchema], default: [] },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ip: { type: String },
    lat: { type: Number },
    lng: { type: Number },
  },
  { timestamps: true },
);

export default mongoose.model("LiveSimulationSession", liveSimulationSessionSchema);
