import express from 'express';
const router = express.Router();
import { compileArduinoCode } from '../controllers/compileController.js';
import { loginUser } from '../controllers/authController.js';


// Compile Arduino code
router.post('/compile', compileArduinoCode);
// User login
router.post('/login', loginUser);

export default router;
