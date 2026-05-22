import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import http from 'http';
import connectDB from './db/connections.js';
import apiRoutes from './routes/api.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import passport from './config/passport.js';
import authRoutes from './routes/auth.js';
import { registerLiveSimulationWebSocket } from './services/liveSimulationService.js';
import { initESP32Module } from './esp32/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');

const resolveConfiguredPath = (rawPath, fallbackCandidates = []) => {
  const candidates = rawPath ? [rawPath] : fallbackCandidates;

  for (const candidate of candidates) {
    const resolvedCandidate = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(backendRoot, candidate);

    if (fs.existsSync(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }

  return path.isAbsolute(fallbackCandidates[0] || '')
    ? (fallbackCandidates[0] || backendRoot)
    : path.resolve(backendRoot, fallbackCandidates[0] || '.');
};

// Ensure required directories and files exist
const tempDir = path.join(__dirname, '../temp');
const dataDir = path.join(__dirname, '../data/components');
const indexFile = path.join(dataDir, 'index.ts');

[tempDir, dataDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
});

if (!fs.existsSync(indexFile)) {
  fs.writeFileSync(indexFile, '\n');
  console.log(`Initialized: ${indexFile}`);
}

console.log("Attempting to connect to MongoDB...");
const isDbConnected = await connectDB();

if (!isDbConnected) {
  console.warn("⚠️  Running in DEGRADED MODE: Database-backed features (Auth, Profiles) will be unavailable.");
}

const app = express();
app.disable('x-powered-by');
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('Missing required SESSION_SECRET. Set SESSION_SECRET in openhw-studio-backend/.env or your runtime environment.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const allowedOrigins = new Set(
  [
    ...(process.env.ALLOWED_ORIGINS || '').split(','),
    ...(process.env.FRONTEND_URLS || '').split(','),
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]
    .map(origin => origin.trim())
    .filter(Boolean)
);

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
}));

app.use(passport.initialize());
app.use(passport.session());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const createInMemoryRateLimiter = ({ windowMs, limit, keyResolver }) => {
  const buckets = new Map();
  const cleanupIntervalMs = Math.max(1000, Math.floor(windowMs));
  let lastCleanupAt = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if ((now - lastCleanupAt) >= cleanupIntervalMs) {
      for (const [bucketKey, bucketValue] of buckets.entries()) {
        if ((now - bucketValue.windowStart) >= windowMs) {
          buckets.delete(bucketKey);
        }
      }
      lastCleanupAt = now;
    }

    const key = String((keyResolver?.(req) || req.ip || 'unknown')).trim() || 'unknown';
    const existing = buckets.get(key);

    if (!existing || (now - existing.windowStart) >= windowMs) {
      buckets.set(key, { windowStart: now, count: 1 });
      return next();
    }

    if (existing.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - existing.windowStart)) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    existing.count += 1;
    return next();
  };
};

app.use(createInMemoryRateLimiter({
  windowMs: 60 * 1000,
  limit: 120,
  keyResolver: (req) => `${req.ip}:${req.path}`,
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.use('/api', apiRoutes);
app.use('/auth', authRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve demo/guide files from openhw-studio-examples repo
const examplesDir = resolveConfiguredPath(process.env.EXAMPLES_DIR || process.env.EXAMPLES_PATH, [
  './openhw-studio-examples/examples',
  '../openhw-studio-examples/examples',
]);
app.use('/examples', express.static(examplesDir));

// Serve classroom uploads from persistent volume
const classroomAssetsDir = process.env.CLASSROOM_UPLOADS_DIR
  ? path.resolve(backendRoot, process.env.CLASSROOM_UPLOADS_DIR)
  : path.resolve(backendRoot, 'data/classroom');
app.use('/api/assets/classroom', express.static(classroomAssetsDir));
const PORT = process.env.PORT || 5001;
const server = http.createServer(app);
await registerLiveSimulationWebSocket(server);
initESP32Module(server);
server.listen(PORT, () => {
  console.log(`OpenHW Studio Backend running on port ${PORT}`);
});
