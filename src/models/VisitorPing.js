import mongoose from "mongoose";

const visitorPingSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    ip: { type: String },
    lat: { type: Number },
    lng: { type: Number },
    lastSeen: { 
      type: Date, 
      default: Date.now,
      expires: 900 // TTL index: Automatically deletes document 15 minutes after lastSeen
    },
  },
  { timestamps: true }
);

export default mongoose.model("VisitorPing", visitorPingSchema);
