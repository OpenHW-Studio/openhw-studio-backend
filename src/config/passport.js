import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import User from '../models/User.js';

passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: 'https://openhw-studio-backend-oew2.onrender.com/auth/google/callback',
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
