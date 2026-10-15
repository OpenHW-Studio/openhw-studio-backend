import express from 'express';
import { Router } from 'express';
import {
	compileArduinoCode,
	flashFirmware,
	listSerialPorts,
} from '../controllers/compileController.js';
import { searchLibrary, installLibrary, listLibraries } from '../controllers/libController.js';
import { protectRoute } from '../middleware/authMiddleware.js';
import { requireAdmin } from '../middleware/authorization.js';
import { compileTelemetryMiddleware } from '../services/telemetryService.js';

const router = Router();

// Track compile durations and successes automatically
router.use(compileTelemetryMiddleware);

// Compile Arduino code (Uno) — public: guest simulator needs it.
// Heavily guarded downstream: per-IP rate limit (server.js), resource
// pool + compile queue (resourceManager/compileQueueManager), result cache,
// and strict input caps (MAX_SOURCE_BYTES etc. in compileController).
router.post('/', compileArduinoCode);
router.post('/diagnostics', compileArduinoCode);
// Physical-device paths — authenticated only: they touch server USB/serial
// and arduino-cli upload, which must never be anonymous.
router.post('/flash', protectRoute, flashFirmware);
router.get('/ports', protectRoute, listSerialPorts);

// Library Management
router.get('/lib-search', searchLibrary);
router.post('/lib-install', protectRoute, requireAdmin, installLibrary);
router.get('/lib-list', listLibraries);

export default router;
