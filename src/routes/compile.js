import express from 'express';
import { Router } from 'express';
import { compileArduinoCode, flashFirmware, listSerialPorts } from '../controllers/compileController.js';
import { searchLibrary, installLibrary, listLibraries } from '../controllers/libController.js';

const router = Router();

// Compile Arduino code
router.post('/', compileArduinoCode);
router.post('/flash', flashFirmware);
router.get('/ports', listSerialPorts);

// Library Management
router.get('/lib-search', searchLibrary);
router.post('/lib-install', installLibrary);
router.get('/lib-list', listLibraries);

export default router;
