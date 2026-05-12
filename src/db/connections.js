import mongoose from "mongoose";

// Disable command buffering so requests fail fast if the database is down
mongoose.set('bufferCommands', false);

const connectDB = async () => {
  try {
    if (process.env.MONGO_URI) {
      try {
        const url = new URL(process.env.MONGO_URI);
        console.log(`Connecting to MongoDB at: ${url.hostname}`, "ANOD");
      } catch (e) {
        console.log("Connecting to MongoDB...", "ANOD");
      }
    } else {
      console.log("Connecting to MongoDB...", "ANOD");
    }
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
  } catch (err) {
    console.error("MongoDB connection failed. Continuing without database-backed features.");
    console.error(err);
    return false;
  }

  return true;
};

export default connectDB;
