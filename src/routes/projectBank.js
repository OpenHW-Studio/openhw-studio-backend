import { Router } from "express";
import { protectRoute } from "../middleware/authMiddleware.js";
import {
  getMyProjectBank,
  getSharedProjectBank,
  createProjectBankEntry,
  importToProjectBank,
  duplicateProjectBankEntry,
  updateProjectBankEntry,
  deleteProjectBankEntry,
  publishProjectBankEntry,
  unpublishProjectBankEntry,
  getProjectById,
  getProjectBySlug,
} from "../controllers/projectBankController.js";

const router = Router();

router.get("/", protectRoute, getMyProjectBank);
router.get("/shared", protectRoute, getSharedProjectBank);
router.get("/slug/:slug", protectRoute, getProjectBySlug);
router.get("/:projectId", protectRoute, getProjectById);
router.post("/", protectRoute, createProjectBankEntry);
router.post("/import", protectRoute, importToProjectBank);
router.post("/:projectId/duplicate", protectRoute, duplicateProjectBankEntry);
router.put("/:projectId", protectRoute, updateProjectBankEntry);
router.delete("/:projectId", protectRoute, deleteProjectBankEntry);
router.put("/:projectId/publish", protectRoute, publishProjectBankEntry);
router.put("/:projectId/unpublish", protectRoute, unpublishProjectBankEntry);

export default router;
