import express from 'express';
const router = express.Router();
import { protectRoute } from '../middleware/authMiddleware.js';
import { saveProject, listProjects, getProject, deleteProject, renameProject } from '../controllers/projectController.js';

router.post('/', protectRoute, saveProject);
router.get('/', protectRoute, listProjects);
router.get('/:projectId', protectRoute, getProject);
router.delete('/:projectId', protectRoute, deleteProject);
router.patch('/:projectId', protectRoute, renameProject);

export default router;
