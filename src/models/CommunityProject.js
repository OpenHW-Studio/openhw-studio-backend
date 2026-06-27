import mongoose from "mongoose";

const communityProjectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: "" },
  board: { type: String, default: "arduino_uno" },
  components: { type: Array, default: [] },
  connections: { type: Array, default: [] },
  code: { type: String, default: "" },
  thumbnail: { type: String, default: "" },
  publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  publishedByName: { type: String, default: "" },
}, { timestamps: true });

communityProjectSchema.index({ createdAt: -1 });

export default mongoose.model("CommunityProject", communityProjectSchema);
