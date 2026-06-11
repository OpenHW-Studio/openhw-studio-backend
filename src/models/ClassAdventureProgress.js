import mongoose from "mongoose";

const quizAttemptSchema = new mongoose.Schema(
  {
    projectSlug: { type: String, required: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    passed: { type: Boolean, required: true },
    attemptedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const completedProjectSchema = new mongoose.Schema(
  {
    projectSlug: { type: String, required: true },
    xpEarned: { type: Number, default: 0, min: 0 },
    completedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const classAdventureProgressSchema = new mongoose.Schema(
  {
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    xp: { type: Number, default: 0, min: 0 },
    coins: { type: Number, default: 0, min: 0 },
    level: { type: Number, default: 1, min: 1 },
    unlockedComponents: { type: [String], default: [] },
    quizAttempts: { type: [quizAttemptSchema], default: [] },
    completedProjects: { type: [completedProjectSchema], default: [] },
    earnedBadges: { type: [String], default: [] },
    stepProgressByProject: { type: Map, of: Number, default: {} },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

classAdventureProgressSchema.index({ classId: 1, studentId: 1 }, { unique: true });

export default mongoose.model("ClassAdventureProgress", classAdventureProgressSchema);
