import mongoose from "mongoose";

const visitorPingSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    ip: { type: String, index: true },
    locationStr: { type: String },
    city: { type: String },
    country: { type: String },
    countryCode: { type: String },
    lat: { type: Number },
    lng: { type: Number },
    userAgent: { type: String },
    hitCount: { type: Number, default: 1 },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { 
      type: Date, 
      default: Date.now,
      index: true,
      expires: 7776000 // 90 days retention for historical analytics
    },
  },
  { timestamps: true }
);

export default mongoose.model("VisitorPing", visitorPingSchema);

