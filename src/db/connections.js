import mongoose from "mongoose";

const connectDB = async () => {
  try {
    console.log(process.env.MONGO_URI, "ANOD");
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
