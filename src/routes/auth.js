import express from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';

import { protectRoute } from '../middleware/authMiddleware.js';

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ALLOWED_ROLES = ['student', 'teacher'];

/**
 * Encode arbitrary data into a base64 string to use as OAuth `state`.
 * We also embed a random nonce so the state can't be replayed.
 */
function encodeState(data) {
    return Buffer.from(JSON.stringify({
        ...data,
        _nonce: Math.random().toString(36).slice(2),
    })).toString('base64url');
}

function decodeState(raw) {
    try {
        return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// 1. Simple Google Login (no role — for returning users)
//    The Passport strategy will keep the user's existing role.
router.get(
    '/google',
    passport.authenticate('google', {
        scope: ['profile', 'email'],
        state: encodeState({ intent: 'login' }),
    })
);

/**
 * 2. Google Sign-Up with role selection
 *
 *    Frontend should redirect the user to:
 *      GET /auth/google/signup?role=student      (student sign-up)
 *      GET /auth/google/signup?role=teacher      (teacher sign-up)
 *
 *    Optional for students (include in query params to pre-fill):
 *      &school=Springfield+High+School
 *
 *    The role (and optional fields) are encoded in the OAuth `state`
 *    parameter so Google passes them back unchanged in the callback.
 */
router.get('/google/signup', (req, res, next) => {
    const { role, school, classStandard } = req.query;

    if (!ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({
            error: `Invalid role. Must be one of: ${ALLOWED_ROLES.join(', ')}`,
        });
    }

    const statePayload = {
        intent: 'signup',
        role,
        // Optional fields — only attached if provided
        ...(school && { school }),
        ...((classStandard) && {
            classStandard: classStandard
        }),
    };

    passport.authenticate('google', {
        scope: ['profile', 'email'],
        state: encodeState(statePayload),
    })(req, res, next);
});


// 3. Google OAuth Callback — handles both login and signup
router.get(
    '/google/callback',
    (req, res, next) => {
        // Decode and attach state to request BEFORE passport processes it
        const raw = req.query.state;
        if (raw) req.oauthState = decodeState(raw);
        next();
    },
    passport.authenticate('google', {
        failureRedirect: process.env.FRONTEND_URL || 'http://localhost:5173',
        session: false,
    }),
    (req, res) => {
        const token = jwt.sign(
            { id: req.user._id, role: req.user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        res.redirect(`${frontendUrl}#token=${encodeURIComponent(token)}`);
    }
);

// 4. Get current authenticated user
//    Frontend hits this with "Authorization: Bearer <token>" to get profile
router.get('/me', protectRoute, (req, res) => {
    res.json({
        success: true,
        user: {
            id: req.user._id,
            name: req.user.name,
            role: req.user.role,
            school: req.user.school,
            classStandard: req.user.classStandard,
            bio: req.user.bio,
            image: req.user.image,
            points: req.user.points,
            coins: req.user.coins,
            level: req.user.level,
            badges: req.user.badges,
        }
    });
});

export default router;
