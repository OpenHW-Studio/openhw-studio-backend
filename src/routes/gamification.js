import { Router } from 'express'
import { getUserUnlocks, updateUserUnlocks } from '../controllers/gamificationController.js'
import { protectRoute } from '../middleware/authMiddleware.js'

const router = Router()

router.get('/unlocks/:userId', protectRoute, getUserUnlocks)
router.put('/unlocks/:userId', protectRoute, updateUserUnlocks)

export default router