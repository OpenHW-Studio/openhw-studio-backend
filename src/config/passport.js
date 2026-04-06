import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import User from '../models/User.js';

const googleClientId = process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (googleClientId && googleClientSecret &&
    !googleClientId.includes('YOUR_') && !googleClientSecret.includes('YOUR_')) {
    passport.use(
        new GoogleStrategy(
            {
                clientID: googleClientId,
                clientSecret: googleClientSecret,
                callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5001/auth/google/callback',
                // Pass the request object to the verify callback so we can read oauthState
                passReqToCallback: true,
            },
            async (req, accessToken, refreshToken, profile, done) => {
                try {
                    const email = profile.emails[0].value;

                    // Find existing user by Google ID or by email
                    let user = await User.findOne({
                        $or: [
                            { googleId: profile.id },
                            { email },
                        ]
                    });

                    if (user) {
                        // Existing user — link their Google ID if not already linked
                        if (!user.googleId) {
                            user.googleId = profile.id;
                            await user.save();
                        }
                        // Never overwrite an existing user's role on login
                        return done(null, user);
                    }

                    // ── New user ──────────────────────────────────────────────
                    // Read the state that was attached in the callback route
                    const state = req.oauthState || {};
                    const allowedRoles = ['student', 'teacher'];
                    const role = allowedRoles.includes(state.role) ? state.role : 'student';

                    // Google provides name, email, and picture — use picture as default image
                    const picture = profile.photos?.[0]?.value || '';

                    user = await User.create({
                        googleId: profile.id,
                        name: profile.displayName,
                        email,
                        role,
                        image: picture,
                        // Optional fields from state (student-specific)
                        ...(state.school && { school: state.school }),
                        ...(state.classStandard && { classStandard: state.classStandard }),
                    });

                    return done(null, user);
                } catch (err) {
                    return done(err, null);
                }
            }
        )
    );
    console.log('✅ Google OAuth strategy registered');
} else {
    console.warn('⚠️  Google OAuth credentials not configured — /auth/google routes will be unavailable');
    console.warn('   Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your env file');
}

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

export default passport;
