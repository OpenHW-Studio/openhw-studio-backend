import { Router } from "express";
import {
  createBugReport,
  getPublicBugReports,
  toggleUpvote,
  toggleDownvote,
  addAdminComment,
  updateBugReportAdmin,
  deleteBugReportAdmin,
} from "../controllers/bugReportController.js";
import { protectRoute, requireAdmin, optionalAuth } from "../middleware/authMiddleware.js";

const router = Router();

// Public & User endpoints
router.post("/", optionalAuth, createBugReport);
router.get("/", getPublicBugReports);
router.post("/:id/upvote", optionalAuth, toggleUpvote);
router.post("/:id/downvote", optionalAuth, toggleDownvote);

// Admin-only triage & staff comment endpoints
router.post("/:id/comments", protectRoute, requireAdmin, addAdminComment);
router.patch("/:id", protectRoute, requireAdmin, updateBugReportAdmin);
router.delete("/:id", protectRoute, requireAdmin, deleteBugReportAdmin);

export default router;
