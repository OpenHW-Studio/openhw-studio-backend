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

import { approveComponent, getPendingComponents, submitComponent, rejectComponent, getInstalledComponents, deleteInstalledComponent, backupInstalledComponents, getComponentsVersion } from '../controllers/componentController.js';
router.post('/components/submit', protectRoute, submitComponent);
router.get('/admin/components/pending', protectRoute, requireAdmin, getPendingComponents);
router.post('/admin/components/approve', protectRoute, requireAdmin, approveComponent);
router.delete('/admin/components/reject/:submissionId', protectRoute, requireAdmin, rejectComponent);
router.get('/admin/components/installed', protectRoute, requireAdmin, getInstalledComponents);
router.delete('/admin/components/installed/:id', protectRoute, requireAdmin, deleteInstalledComponent);
router.get('/admin/components/backup', backupInstalledComponents);

// Public routes for the frontend to check/fetch custom components at runtime
router.get('/components/version', getComponentsVersion);        // tiny hash — no auth needed
router.get('/components/public-installed', backupInstalledComponents);


import { getPendingDeployments, approveDeployment, rollbackDeployment, notifyChange, getNotifications, triggerBuild, getWorkflowLogs } from '../controllers/deploymentController.js';
import { getInfrastructureStatus, getSystemLogs, restartService, getUsageAnalytics, getAuditHistory, getPublicSystemStatus, toggleMaintenanceMode, getMaintenanceStatus } from '../controllers/adminController.js';

router.get('/admin/deployments/pending', protectRoute, requireAdmin, getPendingDeployments);
router.post('/admin/deployments/approve', protectRoute, requireAdmin, approveDeployment);
router.post('/admin/deployments/rollback', protectRoute, requireAdmin, rollbackDeployment);
router.get('/admin/deployments/logs', protectRoute, requireAdmin, getWorkflowLogs);

// Infrastructure & Logs
router.get('/admin/infrastructure/status', protectRoute, requireAdmin, getInfrastructureStatus);
router.post('/admin/infrastructure/restart', protectRoute, requireAdmin, restartService);
router.get('/admin/system-logs', protectRoute, requireAdmin, getSystemLogs);
router.get('/admin/usage-analytics', protectRoute, requireAdmin, getUsageAnalytics);
router.get('/admin/audit-history', protectRoute, requireAdmin, getAuditHistory);
router.post('/admin/maintenance/toggle', protectRoute, requireAdmin, toggleMaintenanceMode);

// Sub-repo webhooks and notifications
router.post('/deploy/notify', notifyChange); // Webhook endpoint (no auth required for GitHub Actions)
router.get('/admin/deployments/notifications', protectRoute, requireAdmin, getNotifications);
router.post('/admin/deployments/trigger', protectRoute, requireAdmin, triggerBuild);

router.post('/simulations/share', protectRoute, createSharedSimulation);
router.get('/simulations/share/:shareId', getSharedSimulation);
router.post('/live-simulations', protectRoute, createLiveSimulation);
router.get('/live-simulations/:sessionCode', protectRoute, getLiveSimulation);

import { runAutofixController } from '../controllers/autofixController.js';
router.post('/autofix', protectRoute, runAutofixController);

// User routes for authentication and management
router.use('/user', userRoutes);
router.use('/compile', compileRoutes);
router.use('/classroom', classroomRoutes);
router.use('/progress', progressRouter)

// Public System Status (for landing page)
router.get('/public/system-status', getPublicSystemStatus);
router.get('/public/maintenance-status', getMaintenanceStatus);

export default router;
