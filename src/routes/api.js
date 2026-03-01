import express from 'express';
const router = express.Router();
import { compileArduinoCode } from '../controllers/compileController.js';
import { searchLibrary, installLibrary, listLibraries } from '../controllers/libController.js';

// Compile Arduino code
router.post('/compile', compileArduinoCode);

// Library Management
router.get('/lib-search', searchLibrary);
router.post('/lib-install', installLibrary);
router.get('/lib-list', listLibraries);

export default router;
