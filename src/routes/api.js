import express from 'express';
const router = express.Router();
import { compileArduinoCode } from '../controllers/compileController.js';
import { searchLibrary, installLibrary, listLibraries, uninstallLibrary } from '../controllers/libController.js';
import { protectRoute } from '../middleware/authMiddleware.js';
import userRoutes from './user.js';
import compileRoutes from './compile.js';
import classroomRoutes from './classroom.js';
import progressRouter from './progress.js'
import { createSharedSimulation, getSharedSimulation } from '../controllers/sharedSimulationController.js';
import { createLiveSimulation, getLiveSimulation } from '../controllers/liveSimulationController.js';

// Library Management
router.get('/lib-search', searchLibrary);
router.post('/lib-install', installLibrary);
router.post('/lib-uninstall', uninstallLibrary);
router.get('/lib-list', listLibraries);

import { approveComponent, getPendingComponents, submitComponent, rejectComponent, getInstalledComponents, deleteInstalledComponent, backupInstalledComponents } from '../controllers/componentController.js';
router.post('/components/submit', submitComponent);
router.get('/admin/components/pending', getPendingComponents);
router.post('/admin/components/approve', approveComponent);
router.delete('/admin/components/reject/:submissionId', rejectComponent);
router.get('/admin/components/installed', getInstalledComponents);
router.delete('/admin/components/installed/:id', deleteInstalledComponent);
router.get('/admin/components/backup', backupInstalledComponents);
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
