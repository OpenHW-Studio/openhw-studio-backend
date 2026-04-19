import jwt from "jsonwebtoken";

const generateToken = (user) => {
  if (!process.env.JWT_SECRET) {
    throw new Error(
      "JWT_SECRET environment variable is not configured. Please set it in your .env file."
    );
  }

  if (!user) {
    throw new Error("User object is required.");
  }

  if (!user._id) {
    throw new Error("User must have an _id property.");
  }

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "1d",
  });

  return token;
};

export { generateToken };
export default generateToken;
