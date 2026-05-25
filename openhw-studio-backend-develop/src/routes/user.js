import { Router } from 'express';
import {
	signupUser,
	signinUser,
	logoutController,
	getUserProfile,
	updateUserProfile,
	googleLogin,
	forgotPassword,
	resetPassword,
	registerStudent,
	setNewPassword,
	forgotPasswordInit,
	forgotPasswordVerify
} from '../controllers/userController.js';

import { protectRoute } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/signup', signupUser);
router.post('/register-student', protectRoute, registerStudent);
router.post('/set-password', protectRoute, setNewPassword);
router.post('/forgot-password/init', forgotPasswordInit);
router.post('/forgot-password/verify', forgotPasswordVerify);
router.post('/signin', signinUser);
router.post('/google', googleLogin);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);
router.post('/logout', protectRoute, logoutController);
router.get('/profile', protectRoute, getUserProfile);
router.put('/profile', protectRoute, updateUserProfile);


export default router;
