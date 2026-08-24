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
import { initSTM32Module } from './stm32/index.js';
import { syncPermanentLibraries } from './services/dynamicLibraryManager.js';
import { initPools, shutdown as shutdownHotPool } from './services/hotPoolManager.js';
import { initLibraryIndexService } from './services/libraryIndexService.js';
import { reloadBudget } from './services/resourceManager.js';

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
const role = process.env.ROLE || 'all-in-one';
console.log(`
=============================================================
  OPENHW STUDIO BACKEND - ROLE: ${role.toUpperCase()}
  Port: ${PORT}
=============================================================
`);

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

// --- Boot Synchronization for Shared Library Pool ---
const officialLibsVolume = path.join(__dirname, '../data/libraries/permanent');
const cacheLibsVolume = path.join(__dirname, '../data/libraries/cache');

[officialLibsVolume, cacheLibsVolume].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Initialize Library Index Service (loads / updates library_index.json)
initLibraryIndexService();

// Synchronize libraries listed in data/libraries.json
console.log('Boot Sync: Checking permanent libraries pool...');
await syncPermanentLibraries();

if (!fs.existsSync(indexFile)) {
  fs.writeFileSync(indexFile, '\n');
  console.log(`Initialized: ${indexFile}`);
}

let isDbConnected = false;
if (!process.env.ROLE || process.env.ROLE === 'main') {
  console.log("Attempting to connect to MongoDB...");
  isDbConnected = await connectDB();

  if (!isDbConnected) {
    console.warn("⚠️  Running in DEGRADED MODE: Database-backed features (Auth, Profiles) will be unavailable.");
  }
} else {
  console.log("ℹ️ Worker role: MongoDB database connection bypassed.");
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', apiRoutes);
app.use('/auth', authRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/network-gateway/pcap', (req, res) => {
  const clientId = req.query.clientId;
  if (!clientId) {
    return res.status(400).send('Missing clientId query parameter.');
  }

  const pcapPath = path.resolve(backendRoot, `data/qemu_${clientId}.pcap`);
  if (fs.existsSync(pcapPath)) {
    res.download(pcapPath, `qemu_${clientId}.pcap`);
  } else {
    res.status(404).send('No network traffic captured for this session yet.');
  }
});

// Serve demo/guide files from openhw-studio-examples repo
const examplesDir = resolveConfiguredPath(process.env.EXAMPLES_DIR || process.env.EXAMPLES_PATH, [
  './openhw-studio-examples/examples',
  '../openhw-studio-examples/examples',
]);
app.use('/api/examples', express.static(examplesDir));

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
initESP32Module(server);
initSTM32Module(server);

server.listen(PORT, async () => {
  console.log(`OpenHW Studio Backend running on port ${PORT}`);

  const budgetFile = path.resolve(backendRoot, 'data/calibrated_budget.json');
  if (!fs.existsSync(budgetFile)) {
    console.log('[Boot] Calibrated budget file missing. Triggering calibration via Health Agent...');
    try {
      fetch('http://openhw-health-agent:8080/api/calibrate', { method: 'POST' })
        .then(() => console.log('[Boot] Calibration triggered successfully.'))
        .catch(err => console.error('[Boot] Failed to trigger calibration:', err.message));
    } catch (err) {
      console.error('[Boot] Calibration fetch failed:', err);
    }
  }

  // Hot Pool: pre-warm one idle QEMU (ESP32) and one Renode (STM32) VM.
  // Set HOT_POOL_ENABLED=false in .env to disable (e.g. very low-RAM machines).
  const hotPoolEnabled = (process.env.HOT_POOL_ENABLED ?? 'true') !== 'false';
  if (hotPoolEnabled) {
    initPools().catch(err => console.error('[HotPool] Init error (server unaffected):', err.message));
  } else {
    console.log('[HotPool] Disabled via HOT_POOL_ENABLED=false');
  }
});

// Graceful shutdown — kill idle pool VMs cleanly
process.on('SIGTERM', () => { shutdownHotPool(); process.exit(0); });
process.on('SIGINT',  () => { shutdownHotPool(); process.exit(0); });
// Nodemon trigger change for --port 0 fix
