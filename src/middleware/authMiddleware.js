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
      console.log("[Auth] No token provided");
      return res.status(401).json({ message: "Unauthorized: No token provided" });
    }
    if (!process.env.JWT_SECRET) {
      console.error("[Auth] CRITICAL: JWT_SECRET is not defined in environment!");
    }
    console.log("[Auth] Verifying token (prefix):", token.substring(0, 10) + "...");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("[Auth] Decoded token:", decoded);
    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      console.log("[Auth] User not found for ID:", decoded.id);
      return res.status(401).json({ message: "Unauthorized: User not found" });
    }

    // Use the role from the JWT token (which may differ from stored role for admins logging in as teachers/students)
    if (decoded.role) {
      user.role = decoded.role;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("[Auth] JWT Verification Error:", error.message);
    return res.status(401).json({ message: `Unauthorized: ${error.message}` });
  }
}
 