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
import { sendOtp, verifyOtp } from '../controllers/otpController.js';
import {
  requestDeletionOtp,
  confirmDeletion,
  cancelDeletion,
} from '../controllers/accountDeletionController.js';

import { protectRoute } from '../middleware/authMiddleware.js';

const router = Router();

// Direct signup is now routed to OTP verification — no user is created without OTP
router.post('/signup', sendOtp);
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
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

// ── Account Deletion (OTP-verified, 30-day grace period) ──────────────────
router.post('/delete-account/request-otp', protectRoute, requestDeletionOtp);
router.post('/delete-account/confirm',     protectRoute, confirmDeletion);
router.post('/delete-account/cancel',      protectRoute, cancelDeletion);


export default router;
