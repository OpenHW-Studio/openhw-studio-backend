import mongoose from "mongoose";

const commentSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "Class", required: true },
  postId: { type: mongoose.Schema.Types.ObjectId, required: true },
  postType: { type: String, enum: ["assignment", "notice"], required: true },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true });

commentSchema.index({ classId: 1, postId: 1, postType: 1 });

export default mongoose.model("Comment", commentSchema);
