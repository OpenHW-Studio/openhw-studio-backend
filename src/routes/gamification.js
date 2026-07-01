import { Router } from 'express'
import { getUserUnlocks, updateUserUnlocks, getUserGamificationState, updateUserGamificationState } from '../controllers/gamificationController.js'
import { protectRoute } from '../middleware/authMiddleware.js'

const router = Router()

router.get('/unlocks/:userId', protectRoute, getUserUnlocks)
router.put('/unlocks/:userId', protectRoute, updateUserUnlocks)

router.get('/state/:userId', protectRoute, getUserGamificationState)
router.put('/state/:userId', protectRoute, updateUserGamificationState)

export default router