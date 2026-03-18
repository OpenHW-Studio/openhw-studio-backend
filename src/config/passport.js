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
                callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/auth/google/callback',
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    // Find existing user by Google ID or by the email they registered with previously
                    let user = await User.findOne({
                        $or: [
                            { googleId: profile.id },
                            { email: profile.emails[0].value }
                        ]
                    });

                    if (user) {
                        // If user exists but doesn't have a googleId (they registered manually first)
                        if (!user.googleId) {
                            user.googleId = profile.id;
                            await user.save();
                        }
                        return done(null, user);
                    }

                    // If not found, create a new user
                    user = await User.create({
                        googleId: profile.id,
                        name: profile.displayName,
                        email: profile.emails[0].value,
                    });

                    done(null, user);
                } catch (err) {
                    done(err, null);
                }
            }
        )
    );
    console.log('✅ Google OAuth strategy registered');
} else {
    console.warn('⚠️  Google OAuth credentials not configured — /auth/google routes will be unavailable');
    console.warn('   Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file');
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
