import jwt from "jsonwebtoken";

const generateToken = (user) => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured.");
  }

  if (!user?._id) {
    throw new Error("Valid user with _id is required.");
  }

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: "1d",
  });

  return token;
};

export default generateToken;
