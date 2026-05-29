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
  getProjectBySlug,
} from "../controllers/projectBankController.js";

const router = Router();

router.get("/", protectRoute, getMyProjectBank);
router.get("/shared", protectRoute, getSharedProjectBank);
router.post("/", protectRoute, createProjectBankEntry);
router.post("/import", protectRoute, importToProjectBank);
router.post("/:projectId/duplicate", protectRoute, duplicateProjectBankEntry);
router.put("/:projectId", protectRoute, updateProjectBankEntry);
router.delete("/:projectId", protectRoute, deleteProjectBankEntry);
router.put("/:projectId/publish", protectRoute, publishProjectBankEntry);
router.put("/:projectId/unpublish", protectRoute, unpublishProjectBankEntry);
router.get("/slug/:slug", getProjectBySlug);

export default router;