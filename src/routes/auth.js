import express from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';
import { protectRoute } from '../middleware/authMiddleware.js';

const router = express.Router();

// 1. Initiate Google Login (redirects the browser to Google)
router.get(
    '/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

// 2. Google OAuth Callback (Google redirects back here after user consents)
router.get(
    '/google/callback',
    passport.authenticate('google', { failureRedirect: process.env.FRONTEND_URL || 'http://localhost:5173' }),
    (req, res) => {
        // Generate a JWT for our application
        const token = jwt.sign(
            { id: req.user._id, role: req.user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

        // Redirect to the frontend and pass the token as a URL parameter
        // Your frontend should read this from the URL, save it, and then clear the URL
        res.redirect(`${frontendUrl}?token=${token}`);
    }
);

// 3. Get current authenticated user
// Frontend hits this with "Authorization: Bearer <token>" to get profile
router.get('/me', protectRoute, (req, res) => {
    res.json({ success: true, user: req.user });
});

export default router;
