import express from 'express';
const router = express.Router();
import { compileArduinoCode } from '../controllers/compileController.js';

// Compile Arduino code
router.post('/compile', compileArduinoCode);

export default router;
