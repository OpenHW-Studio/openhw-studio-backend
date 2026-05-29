import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const maskedUri = process.env.MONGO_URI
  ? process.env.MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")
  : "undefined";

const maskEmail = (email) => {
  if (!email || !email.includes("@")) return "****";
  return email.charAt(0) + "****" + email.substring(email.indexOf("@"));
};

const User = mongoose.model(
  "User",
  new mongoose.Schema({
    email: String,
    role: String,
  }),
);

async function check() {
  try {
    console.log("Connecting to:", maskedUri);
    await mongoose.connect(process.env.MONGO_URI);
    const targetId = "69ba8ea8e6a1d4c7b140761b";
    const user = await User.findById(targetId);
    if (user) {
      console.log(
        "Found target user:",
        maskEmail(user.email),
        "Role:",
        user.role,
      );
    } else {
      console.log("Target user NOT FOUND in database:", targetId);
      const all = await User.find({}).limit(5);
      console.log(
        "Other users in DB:",
        all.map((u) => maskEmail(u.email)),
      );
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
