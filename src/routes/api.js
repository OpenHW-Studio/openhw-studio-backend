import express from 'express';
const router = express.Router();
import { compileArduinoCode } from '../controllers/compileController.js';
import { searchLibrary, installLibrary, listLibraries } from '../controllers/libController.js';
import { signupUser, loginUser } from '../controllers/authController.js';

// Compile Arduino code
router.post('/compile', compileArduinoCode);

// Library Management
router.get('/lib-search', searchLibrary);
router.post('/lib-install', installLibrary);
router.get('/lib-list', listLibraries);

// Authentication
router.post('/signup', signupUser);
router.post('/login', loginUser);

export default router;
