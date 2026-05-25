import express from 'express'
import {
  getProgress,
  recordQuiz,
  unlockComponent,
  completeProject,
  awardBadge,
  resetProgress,
  getLeaderboard,
} from '../controllers/progressController.js'
import { protectRoute } from '../middleware/authMiddleware.js'


const router = express.Router()

// ── Progress CRUD ─────────────────────────────────────────────────────────────
router.get('/',                protectRoute, getProgress)
router.post('/quiz',           protectRoute, recordQuiz)
router.post('/unlock',         protectRoute, unlockComponent)
router.post('/complete',       protectRoute, completeProject)
router.post('/badge',          protectRoute, awardBadge)
router.get('/leaderboard',     protectRoute, getLeaderboard)
router.put('/reset',           protectRoute, resetProgress)
export default router
