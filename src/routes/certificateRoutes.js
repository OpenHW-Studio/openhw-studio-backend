import express from 'express';
import {
  claimCertificate,
  verifyCertificate,
  getMyCertificates,
} from '../controllers/certificateController.js';
import { protectRoute } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public: Verify credential by certificate ID
router.get('/verify/:certId', verifyCertificate);

// Protected: Claim certificate for completed track
router.post('/claim', protectRoute, claimCertificate);

// Protected: Fetch current user's earned certificates
router.get('/mine', protectRoute, getMyCertificates);

export default router;
