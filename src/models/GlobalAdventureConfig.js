import mongoose from "mongoose";
import ClassAdventureConfig from "./ClassAdventureConfig.js";

const globalAdventureConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: "global",
      trim: true,
    },
    content: { type: ClassAdventureConfig.schema.path("content").schema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

export default mongoose.model("GlobalAdventureConfig", globalAdventureConfigSchema);
