import express from 'express';
const router = express.Router();
import { compileArduinoCode } from '../controllers/compileController.js';
import { searchLibrary, installLibrary, listLibraries, uninstallLibrary } from '../controllers/libController.js';
import { protectRoute } from '../middleware/authMiddleware.js';
import userRoutes from './user.js';
import compileRoutes from './compile.js';
import classroomRoutes from './classroom.js';
import progressRouter from './progress.js'

import { requireAdmin } from '../middleware/authorization.js';
import { createSharedSimulation, getSharedSimulation } from '../controllers/sharedSimulationController.js';
import { createLiveSimulation, getLiveSimulation } from '../controllers/liveSimulationController.js';

// Library Management
router.get('/lib-search', searchLibrary);
router.post('/lib-install', protectRoute, requireAdmin, installLibrary);
router.post('/lib-uninstall', protectRoute, requireAdmin, uninstallLibrary);
router.get('/lib-list', listLibraries);

import { approveComponent, getPendingComponents, submitComponent, rejectComponent, getInstalledComponents, deleteInstalledComponent, backupInstalledComponents } from '../controllers/componentController.js';
router.post('/components/submit', protectRoute, submitComponent);
router.get('/admin/components/pending', protectRoute, requireAdmin, getPendingComponents);
router.post('/admin/components/approve', protectRoute, requireAdmin, approveComponent);
router.delete('/admin/components/reject/:submissionId', protectRoute, requireAdmin, rejectComponent);
router.get('/admin/components/installed', protectRoute, requireAdmin, getInstalledComponents);
router.delete('/admin/components/installed/:id', protectRoute, requireAdmin, deleteInstalledComponent);
router.get('/admin/components/backup', backupInstalledComponents);

import { getPendingDeployments, approveDeployment, rollbackDeployment } from '../controllers/deploymentController.js';
router.get('/admin/deployments/pending', protectRoute, requireAdmin, getPendingDeployments);
router.post('/admin/deployments/approve', protectRoute, requireAdmin, approveDeployment);
router.post('/admin/deployments/rollback', protectRoute, requireAdmin, rollbackDeployment);

router.post('/simulations/share', protectRoute, createSharedSimulation);
router.get('/simulations/share/:shareId', getSharedSimulation);
router.post('/live-simulations', protectRoute, createLiveSimulation);
router.get('/live-simulations/:sessionCode', protectRoute, getLiveSimulation);

// User routes for authentication and management
router.use('/user', userRoutes);
router.use('/compile', compileRoutes);
router.use('/classroom', classroomRoutes);
router.use('/progress', progressRouter)

export default router;
