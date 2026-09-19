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
import { initCompilerBoot } from './compiler/libraryBoot.js';
import { initCompilerModule, isCompilerRole, isMainRole } from './compiler/index.js';
import { startAccountPurgeWorker } from './workers/accountPurgeWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');

const resolveConfiguredPath = (rawPath, fallbackCandidates = []) => {
  const candidates = rawPath ? [rawPath, ...fallbackCandidates] : fallbackCandidates;

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

const PORT = process.env.PORT || 5001;
const ROLE = process.env.ROLE || 'single';
console.log(`
=============================================================
  OPENHW STUDIO BACKEND - ROLE: ${ROLE.toUpperCase()}
  Port: ${PORT}
=============================================================
`);

// Library pool + compile cache boot — owned by the compiler process
// (ROLE=compiler, or single-service local dev). ROLE=main skips it.
await initCompilerBoot();

let isDbConnected = false;
if (isCompilerRole()) {
  console.log("ℹ️ Compiler role: MongoDB database connection bypassed.");
} else {
  console.log("Attempting to connect to MongoDB...");
  isDbConnected = await connectDB();

  if (!isDbConnected) {
    console.warn("⚠️  Running in DEGRADED MODE: Database-backed features (Auth, Profiles) will be unavailable.");
  }
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

    const maxLimit = typeof limit === 'function' ? limit(req) : limit;
    if (existing.count >= maxLimit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - existing.windowStart)) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    existing.count += 1;
    return next();
  };
};

// Rate limits (env-configurable for Docker deploys):
// COMPILE_RATE_LIMIT_PER_MIN — per-IP cap on POST /api/compile[/diagnostics]
//   (default 20/min: humans click Run rarely, bots hammer it).
// AUTH_RATE_LIMIT_PER_MIN — per-IP cap on auth POSTs (signin/signup/OTP/
//   password-reset, default 10/min) to slow credential stuffing + OTP spam.
// General traffic keeps the old 300/min (600 for /admin polling).
const COMPILE_RATE_LIMIT = Math.max(1, Number(process.env.COMPILE_RATE_LIMIT_PER_MIN || 20));
const AUTH_RATE_LIMIT = Math.max(1, Number(process.env.AUTH_RATE_LIMIT_PER_MIN || 10));
const AUTH_POST_PATHS = new Set([
  '/api/user/signin', '/api/user/signup', '/api/user/send-otp',
  '/api/user/verify-otp', '/api/user/google', '/api/user/forgot-password',
  '/api/user/forgot-password/init', '/api/user/forgot-password/verify',
  '/auth/google', '/auth/google/signup',
]);
app.use(createInMemoryRateLimiter({
  windowMs: 60 * 1000,
  limit: (req) => {
    const p = req.path || req.originalUrl || '';
    if (p.includes('/admin')) return 600;
    if (req.method === 'POST' && (p === '/api/compile' || p.endsWith('/compile') || p.endsWith('/compile/diagnostics'))) {
      return COMPILE_RATE_LIMIT;
    }
    if (req.method === 'POST') {
      const full = p.startsWith('/api') || p.startsWith('/auth') ? p : (req.originalUrl || p);
      for (const prefix of AUTH_POST_PATHS) {
        if (full === prefix || full.startsWith(`${prefix}/`) || full.startsWith(`${prefix}?`)) return AUTH_RATE_LIMIT;
      }
    }
    return 300;
  },
  keyResolver: (req) => `${req.ip}:${req.path}`,
}));
// Body cap: auth/compile JSON never legitimately exceeds ~1 MB
// (firmware comes back OUT, source goes IN capped at 512 KB by
// checkCompileInputSize). Classroom file uploads ride on multipart with
// their own multer limits, so a 1 MB JSON cap breaks nothing.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', role: ROLE }));

if (isCompilerRole()) {
  // Compiler-worker: ONLY compile execution paths. No auth routes, no DB
  // routes, no static assets — the main backend owns everything else.
  initCompilerModule(app);
} else {
  app.use('/api', apiRoutes);
  app.use('/auth', authRoutes);
}

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', role: ROLE, timestamp: new Date().toISOString() });
});

// Compiler-worker serves nothing below: no examples, avatars, or uploads.
if (isCompilerRole()) {
  // PORT is defined at startup
  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`OpenHW Studio Compiler Worker running on port ${PORT}`);
  });
} else {

// Serve demo/guide files from openhw-studio-examples repo.
//
// Resolution order (first existing path wins):
//   1. EXAMPLES_DIR  — set by docker-compose/production env (e.g. /app/openhw-studio-examples/examples)
//   2. EXAMPLES_PATH — typically ../openhw-studio-examples/examples for local dev
//   3. ./openhw-studio-examples/examples  (relative to backend root)
//   4. ../openhw-studio-examples/examples (relative to backend root, sibling dir)
//
// NOTE: Both env vars are passed as separate candidates so a non-existent EXAMPLES_DIR
// (e.g. the Docker path when running locally) does not block EXAMPLES_PATH from being tried.
const examplesDir = resolveConfiguredPath(null, [
  process.env.EXAMPLES_DIR,
  process.env.EXAMPLES_PATH,
  './openhw-studio-examples/examples',
  '../openhw-studio-examples/examples',
].filter(Boolean));

if (fs.existsSync(examplesDir)) {
  console.log(`[Examples] Serving static files from: ${examplesDir}`);
} else {
  console.warn(`[Examples] ⚠️  Directory not found: ${examplesDir}`);
  console.warn('[Examples]    Guided-project images will return 404.');
  console.warn('[Examples]    Set EXAMPLES_DIR or EXAMPLES_PATH in your environment.');
}
app.use('/api/examples', express.static(examplesDir));
app.use('/examples', express.static(examplesDir));

// Proxy endpoint for DiceBear avatars (serves SVG same-origin to prevent COEP/CORS browser blocks)
app.get('/api/avatar', async (req, res) => {
  const { style = 'bottts', seed = 'alpha' } = req.query;
  const bgColors = 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf,c084fc,38bdf8,818cf8,10b981';
  const url = `https://api.dicebear.com/9.x/${encodeURIComponent(style)}/svg?seed=${encodeURIComponent(seed)}&backgroundColor=${bgColors}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Dicebear returned status ${response.status}`);
    const svg = await response.text();
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(svg);
  } catch (err) {
    console.error('Failed to proxy avatar:', err.message);
    res.status(500).send('Error fetching avatar');
  }
});

// Serve classroom uploads from persistent volume
const classroomAssetsDir = process.env.CLASSROOM_UPLOADS_DIR
  ? path.resolve(backendRoot, process.env.CLASSROOM_UPLOADS_DIR)
  : path.resolve(backendRoot, 'data/classroom');
app.use('/api/assets/classroom', express.static(classroomAssetsDir));
// PORT is defined at startup
const server = http.createServer(app);
await registerLiveSimulationWebSocket(server);

server.listen(PORT, async () => {
  console.log(`OpenHW Studio Backend running on port ${PORT}`);

  // Account purge worker — runs daily to permanently wipe expired accounts
  startAccountPurgeWorker();
});
} // end non-compiler boot
// Nodemon trigger change for --port 0 fix
