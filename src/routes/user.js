import { Router } from 'express';
import {
	signupUser,
	signinUser,
	logoutController,
	updateUserProfile,
} from '../controllers/userController.js';
import { protectRoute } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/signup', signupUser);
router.post('/signin', signinUser);
router.post('/logout', protectRoute, logoutController);
router.put('/profile', protectRoute, updateUserProfile);

export default router;
