import jwt from "jsonwebtoken";
import User from "../models/User.js";

const parseCookieToken = (cookieHeader = "") => {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";");
  const jwtCookie = cookies.find((cookie) => cookie.trim().startsWith("jwt="));
  if (!jwtCookie) return null;

  return jwtCookie.split("=")[1] || null;
};

export const protectRoute = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;
    const cookieToken = parseCookieToken(req.headers.cookie || "");

    const token = bearerToken || cookieToken;
    if (!token) {
      return res.status(401).json({ message: "Unauthorized: No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(401).json({ message: "Unauthorized: User not found" });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized: Invalid token" });
  }
};