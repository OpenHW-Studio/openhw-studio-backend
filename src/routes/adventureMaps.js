import { Router } from 'express';
import {
  getAdventureMaps,
  getAdventureMapBySlugOrId,
  createAdventureMap,
  updateAdventureMap,
  deleteAdventureMap,
  completeAdventureMission,
  claimAdventureCertificate
} from '../controllers/adventureMapController.js';
import { protectRoute, optionalAuth, requireRole } from '../middleware/authMiddleware.js';

const router = Router();

// CREATORS ALLOWED: teacher, user, admin (students are play-only)
const canCreate = requireRole('teacher', 'user', 'admin');

// Publicly readable lists & details
router.get('/', optionalAuth, getAdventureMaps);
router.get('/:slugOrId', optionalAuth, getAdventureMapBySlugOrId);

// Creation, Modification & Progress (Authenticated + Creator role only)
router.post('/', protectRoute, canCreate, createAdventureMap);
router.put('/:id', protectRoute, canCreate, updateAdventureMap);
router.delete('/:id', protectRoute, canCreate, deleteAdventureMap);

// Progress tracking — all logged-in users (students too) can complete missions
router.post('/:id/complete-mission', protectRoute, completeAdventureMission);
router.post('/:id/claim-cert', protectRoute, claimAdventureCertificate);

export default router;
