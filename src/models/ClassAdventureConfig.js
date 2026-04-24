import mongoose from "mongoose";

const adventureWorldSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    theme: { type: String, trim: true, maxlength: 60 },
    color: { type: String, trim: true, maxlength: 40 },
    icon: { type: String, trim: true, maxlength: 16 },
    order: { type: Number, default: 0 },
  },
  { _id: false },
);

const adventureNodeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    type: { type: String, default: "step", trim: true, maxlength: 40 },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    order: { type: Number, default: 0 },
    content: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const adventureQuizQuestionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    question: { type: String, required: true, trim: true, maxlength: 800 },
    options: { type: [String], default: [] },
    correctAnswer: { type: Number, default: 0, min: 0 },
    explanation: { type: String, trim: true, maxlength: 800 },
  },
  { _id: false },
);

const adventureProjectSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true },
    worldId: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    subtitle: { type: String, trim: true, maxlength: 220 },
    description: { type: String, trim: true, maxlength: 2000 },
    prerequisite: { type: String, default: null },
    xpReward: { type: Number, default: 0, min: 0 },
    rewardComponents: { type: [mongoose.Schema.Types.Mixed], default: [] },
    theory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    quizQuestions: { type: [adventureQuizQuestionSchema], default: [] },
    nodes: { type: [adventureNodeSchema], default: [] },
  },
  { _id: false },
);

const adventureContentSchema = new mongoose.Schema(
  {
    worlds: { type: [adventureWorldSchema], default: [] },
    projects: { type: [adventureProjectSchema], default: [] },
    version: { type: Number, default: 1, min: 1 },
  },
  { _id: false },
);

const classAdventureConfigSchema = new mongoose.Schema(
  {
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: true,
      unique: true,
      index: true,
    },
    content: { type: adventureContentSchema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

export default mongoose.model("ClassAdventureConfig", classAdventureConfigSchema);
