import mongoose from "mongoose";

const rewardComponentSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true },
    name: { type: String, trim: true, maxlength: 140 },
    icon: { type: String, trim: true, maxlength: 16 },
    description: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const componentSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
    qty: { type: Number, default: 1, min: 1 },
    attrs: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const theoryItemSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    title: { type: String, trim: true },
    content: { type: String, trim: true },
  },
  { _id: false }
);

const quizQuestionSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    question: { type: String, trim: true, maxlength: 800 },
    options: { type: [String], default: [] },
    correctAnswer: { type: Number, default: 0, min: 0 },
    explanation: { type: String, trim: true, maxlength: 800 },
  },
  { _id: false }
);

const guidedStepSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true },
    phase: { type: String, enum: ["wire", "code", "run"], default: "wire" },
    icon: { type: String, trim: true, maxlength: 16 },
    color: { type: String, trim: true, maxlength: 40 },
    title: { type: String, trim: true, maxlength: 140 },
    instruction: { type: String, trim: true, maxlength: 1000 },
    tip: { type: String, trim: true, maxlength: 800 },
    code: { type: String, trim: true, maxlength: 5000 },
  },
  { _id: false }
);

const assessmentSchema = new mongoose.Schema(
  {
    passingThreshold: { type: Number, default: 70, min: 0, max: 100 },
    evaluationCriteria: { type: mongoose.Schema.Types.Mixed, default: {} },
    scoring: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const projectBankSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    visibility: {
      type: String,
      enum: ["personal", "published", "archived"],
      default: "personal",
      index: true,
    },
    slug: { type: String, required: true, trim: true, maxlength: 140, index: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000 },
    difficulty: { type: String, trim: true, maxlength: 40 },
    tags: { type: [String], default: [] },
    estimatedTime: { type: String, trim: true, maxlength: 40 },
    board: { type: String, trim: true, maxlength: 40 },

    // Adventure content
    theory: { type: [theoryItemSchema], default: [] },
    quizQuestions: { type: [quizQuestionSchema], default: [] },
    guidedSteps: { type: [guidedStepSchema], default: [] },
    assessment: { type: assessmentSchema, default: {} },
    rewardComponents: { type: [rewardComponentSchema], default: [] },

    // Simulator content
    components: { type: [componentSchema], default: [] },
    starterCode: { type: String, default: "", maxlength: 10000 },
  },
  { timestamps: true }
);

// Compound unique index for personal projects
projectBankSchema.index({ owner: 1, slug: 1 }, { unique: true });

// Index for published projects
projectBankSchema.index({ visibility: 1, slug: 1 });

export default mongoose.model("ProjectBank", projectBankSchema);