import express from 'express';
import session from 'express-session';
import passport from '../../config/passport.js';
import apiRoutes from '../../routes/api.js';
import authRoutes from '../../routes/auth.js';

const app = express();

// Disable x-powered-by header for security (matches server.js)
app.disable('x-powered-by');

// Register parsers
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Setup sessions (required by Passport)
app.use(session({
    secret: process.env.SESSION_SECRET || 'test-session-secret-key-1234567890',
    resave: false,
    saveUninitialized: false
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Mount Route Handlers
app.use('/api', apiRoutes);
app.use('/auth', authRoutes);

// Error handling middleware to prevent stack trace leaks
app.use((err, req, res, next) => {
    console.error('[Test App Error Hook]:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

export default app;
