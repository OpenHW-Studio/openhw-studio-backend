import jwt from "jsonwebtoken";

const generateToken = (user, overrideRole = null) => {
  // Use overrideRole if provided (for admin logging in as teacher/student)
  // Otherwise use the user's stored role
  const roleToUse = overrideRole || user.role;
  
  const token = jwt.sign({ id: user._id, role: roleToUse }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "1d",
  });

  return token;
};

export default generateToken;