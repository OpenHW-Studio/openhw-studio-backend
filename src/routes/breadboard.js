import express from 'express';
import { simulateBreadboardController } from '../controllers/breadboardController.js';

const router = express.Router();

router.post('/simulate', simulateBreadboardController);

export default router;
