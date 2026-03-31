import { Router } from 'express';
import {
	signupUser,
	signinUser,
	logoutController,
	updateUserProfile,
	googleLogin,
	forgotPassword,
	resetPassword,
} from '../controllers/userController.js';

import { protectRoute } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/signup', signupUser);
router.post('/signin', signinUser);
router.post('/google', googleLogin);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.post('/logout', protectRoute, logoutController);
router.put('/profile', protectRoute, updateUserProfile);


export default router;
