import express from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';

import { protectRoute } from '../middleware/authMiddleware.js';

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ALLOWED_ROLES = ['student', 'teacher', 'user'];

function getResolvedFrontendUrl(origin) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : ['http://localhost:5173'];
    if (origin && allowedOrigins.includes(origin)) {
        return origin;
    }
    return process.env.FRONTEND_URL || 'http://localhost:5173';
}

function getPortalPath(role) {
    if (role === 'user') return '/login';
    if (role === 'teacher') return '/classroom/signin?role=teacher';
    return '/classroom/signin?role=student';
}

function getPortalName(role) {
    if (role === 'user') return 'User Node portal (/login)';
    if (role === 'teacher') return 'Classroom portal as Teacher';
    return 'Classroom portal as Student';
}

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

// 1. Google Login — accepts role and origin in query params
router.get(
    '/google',
    (req, res, next) => {
        const origin = req.query.origin;
        const role = req.query.role; // e.g. 'user', 'student', 'teacher'
        const statePayload = {
            intent: 'login',
            origin,
            ...(role && ALLOWED_ROLES.includes(role) && { role }),
        };
        passport.authenticate('google', {
            scope: ['profile', 'email'],
            state: encodeState(statePayload),
        })(req, res, next);
    }
);

/**
 * 2. Google Sign-Up with role selection
 */
router.get('/google/signup', (req, res, next) => {
    const { role, school, classStandard, origin } = req.query;

    if (role && !ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({
            error: `Invalid role. Must be one of: ${ALLOWED_ROLES.join(', ')}`,
        });
    }

    const statePayload = {
        intent: 'signup',
        role: role || 'student',
        origin,
        ...(school && { school }),
        ...(classStandard && { classStandard }),
    };

    passport.authenticate('google', {
        scope: ['profile', 'email'],
        state: encodeState(statePayload),
    })(req, res, next);
});

// 3. Google OAuth Callback — handles both login and signup with strict role enforcement
router.get(
    '/google/callback',
    (req, res, next) => {
        const raw = req.query.state;
        const state = raw ? decodeState(raw) : {};
        req.oauthState = state;
        const origin = state?.origin;
        const frontendUrl = getResolvedFrontendUrl(origin);
        const requestedRole = state?.role;
        const defaultFailureRedirect = requestedRole ? `${frontendUrl}${getPortalPath(requestedRole)}` : `${frontendUrl}/login`;

        passport.authenticate('google', { session: false }, (err, user, info) => {
            // Handle OAuth or network failures gracefully (NO 500 crashes)
            if (err || !user) {
                console.error('[Google OAuth] Authentication error:', err || info);
                const errorMsg = err?.message || 'Google authentication failed. Please try again.';
                const redirectTarget = `${defaultFailureRedirect}${defaultFailureRedirect.includes('?') ? '&' : '?'}error=${encodeURIComponent(errorMsg)}`;
                return res.redirect(redirectTarget);
            }

            // Strict Role Conflict Enforcement
            if (user.role !== 'admin' && requestedRole && user.role !== requestedRole) {
                console.warn(`[Google OAuth] Role mismatch: User DB role is "${user.role}", but attempted login from "${requestedRole}" portal.`);
                const errorMsg = `This account is registered as a ${user.role}. Please sign in via the ${getPortalName(user.role)}.`;
                const redirectTarget = `${defaultFailureRedirect}${defaultFailureRedirect.includes('?') ? '&' : '?'}error=${encodeURIComponent(errorMsg)}&registeredRole=${user.role}`;
                return res.redirect(redirectTarget);
            }

            // Issue token (admins can log into any portal)
            let roleForToken = user.role;
            if (user.role === 'admin' && requestedRole && ALLOWED_ROLES.includes(requestedRole)) {
                roleForToken = requestedRole;
            }

            const token = jwt.sign(
                { id: user._id, role: roleForToken },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
            );

            return res.redirect(`${frontendUrl}/login-success#token=${encodeURIComponent(token)}`);
        })(req, res, next);
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
            email: req.user.email,
            role: req.user.role,
            school: req.user.school,
            classStandard: req.user.classStandard,
            bio: req.user.bio,
            image: req.user.image,
            points: req.user.points,
            coins: req.user.coins,
            level: req.user.level,
            badges: req.user.badges,
            status: req.user.status || 'active',
            deletionRequestedAt: req.user.deletionRequestedAt || null,
            permanentDeleteAt: req.user.permanentDeleteAt || null,
        }
    });
});

export default router;
