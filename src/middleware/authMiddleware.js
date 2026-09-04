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
    const queryToken = req.query?.token || null;

    const token = bearerToken || cookieToken || queryToken;
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

    // ── Block Guard ──────────────────────────────────────────────────────
    if (user.isBlocked || user.status === 'blocked') {
      return res.status(403).json({
        status: 'blocked',
        message: 'This account has been blocked by an administrator. Please contact support.',
      });
    }

    // ── Suspension Guard ─────────────────────────────────────────────────
    if (user.status === 'suspended') {
      if (user.suspendedUntil && new Date(user.suspendedUntil) > new Date()) {
        const resumeStr = new Date(user.suspendedUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        return res.status(403).json({
          status: 'suspended',
          suspendedUntil: user.suspendedUntil,
          message: `Your account is temporarily suspended until ${resumeStr}. Reason: ${user.suspensionReason || 'Administrative review'}`,
        });
      } else {
        user.status = 'active';
        user.suspendedUntil = null;
        user.suspensionReason = '';
        await user.save();
      }
    }

    // ── Soft-deletion guard ────────────────────────────────────────────────
    // Allow /auth/me, /logout, and cancel-deletion routes through so the user can retrieve their profile,
    // view the Reactivation page, reactivate their account, or log out. Block other operational routes.
    const path = req.path || '';
    const origUrl = req.originalUrl || '';
    const isAllowedPendingRoute =
      path.endsWith('/delete-account/cancel') ||
      path.endsWith('/delete-account/request-reactivate-otp') ||
      path.endsWith('/logout') ||
      path === '/me' ||
      origUrl.includes('/auth/me') ||
      origUrl.includes('/user/logout');

    if (user.status === 'pending_deletion' && !isAllowedPendingRoute) {
      return res.status(403).json({
        status: 'pending_deletion',
        permanentDeleteAt: user.permanentDeleteAt,
        message: 'Your account is scheduled for deletion. Log in to cancel and reactivate.',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("[Auth] JWT Verification Error:", error.message);
    return res.status(401).json({ message: `Unauthorized: ${error.message}` });
  }
};

export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;
    const cookieToken = parseCookieToken(req.headers.cookie || "");
    const queryToken = req.query?.token || null;

    const token = bearerToken || cookieToken || queryToken;
    if (token && process.env.JWT_SECRET) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select("-password");
      if (user) {
        if (decoded.role) user.role = decoded.role;
        req.user = user;
      }
    }
  } catch (error) {
    // Ignore invalid token for optional auth
  }
  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  const adminEmails = (process.env.VITE_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase());

  if (
    req.user.role === "admin" ||
    (req.user.email && adminEmails.includes(req.user.email.toLowerCase()))
  ) {
    return next();
  }
  return res.status(403).json({ message: "Admin access required" });
};