import { Router } from "express";
import { protectRoute } from "../middleware/authMiddleware.js";
import { publishProject, listCommunityProjects, updateProjectName, unpublishProject } from "../controllers/communityController.js";

const router = Router();

router.get("/projects", listCommunityProjects);
router.post("/publish", protectRoute, publishProject);
router.patch("/project/:id", protectRoute, updateProjectName);
router.delete("/project/:id", protectRoute, unpublishProject);

export default router;
