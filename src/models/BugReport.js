import mongoose from "mongoose";

const bugReportSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["bug", "feature", "review"],
      default: "bug",
    },
    rating: { type: Number, min: 1, max: 5, default: 5 },
    userRole: { type: String, default: "Maker" },
    category: {
      type: String,
      enum: ["component", "simulator_ui", "compiler_backend", "general"],
      default: "general",
    },
    componentType: { type: String, trim: true, default: "" },
    componentLabel: { type: String, trim: true, default: "" },
    failingFeatures: [{ type: String, trim: true }],
    codeSnippet: { type: String, default: "" },
    stepsToReproduce: { type: String, default: "" },
    expectedBehavior: { type: String, default: "" },
    attachmentUrl: { type: String, default: "" },
    browserInfo: { type: String, default: "" },
    osInfo: { type: String, default: "" },
    reporterEmail: { type: String, trim: true, default: "" },
    reporterName: { type: String, trim: true, default: "Anonymous" },
    status: {
      type: String,
      enum: [
        "under_review",
        "in_progress",
        "fixed_in_dev",
        "resolved",
        "closed",
      ],
      default: "under_review",
    },
    targetRepo: {
      type: String,
      enum: ["emulator", "frontend", "backend"],
      default: "frontend",
    },
    upvotes: { type: Number, default: 0 },
    upvotedIps: [{ type: String }],
    downvotes: { type: Number, default: 0 },
    downvotedIps: [{ type: String }],
    comments: [
      {
        authorName: { type: String, default: "Anonymous" },
        authorEmail: { type: String, default: "" },
        text: { type: String, required: true, trim: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    githubIssueUrl: { type: String, default: "" },
    adminNotes: { type: String, default: "" },
  },
  { timestamps: true }
);

// Index for fast text and status searches
bugReportSchema.index({ status: 1, type: 1, createdAt: -1 });

export default mongoose.model("BugReport", bugReportSchema);
