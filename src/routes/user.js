import { Router } from 'express';
import {
	signupUser,
	loginUser,
	logoutController,
	updateUserProfile,
} from '../controllers/authController.js';
import { protectRoute } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/signup', signupUser);
router.post('/login', loginUser);
router.post('/logout', protectRoute, logoutController);
router.put('/profile', protectRoute, updateUserProfile);

export default router;
