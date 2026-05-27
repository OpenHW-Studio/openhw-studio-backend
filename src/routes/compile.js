import express from 'express';
import { Router } from 'express';
import {
	compileArduinoCode,
	flashFirmware,
	listSerialPorts,
	getDefaultPicoMicroPythonUf2,
	getDefaultPicoMicroPythonHex,
	getDefaultPicoCircuitPythonUf2,
} from '../controllers/compileController.js';
import { searchLibrary, installLibrary, listLibraries } from '../controllers/libController.js';
import { protectRoute } from '../middleware/authMiddleware.js';
import { requireAdmin } from '../middleware/authorization.js';
import { handleESP32Stop, handleESP32DirectBoot, handleESP32RunBinary } from '../esp32/index.js';

const router = Router();

// Compile Arduino code
router.post('/', compileArduinoCode);
router.post('/diagnostics', compileArduinoCode);
router.post('/flash', flashFirmware);
router.get('/ports', listSerialPorts);
router.get('/pico/micropython-uf2', getDefaultPicoMicroPythonUf2);
router.get('/pico/micropython-hex', getDefaultPicoMicroPythonHex);
router.get('/pico/circuitpython-uf2', getDefaultPicoCircuitPythonUf2);

// ESP32 QEMU routes
router.post('/esp32/stop/:buildId', handleESP32Stop);
router.post('/esp32/direct-boot', handleESP32DirectBoot);
router.post('/esp32/run-binary', handleESP32RunBinary);

// Library Management
router.get('/lib-search', searchLibrary);
router.post('/lib-install', protectRoute, requireAdmin, installLibrary);
router.get('/lib-list', listLibraries);

export default router;
