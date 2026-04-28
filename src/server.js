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

app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecretcatsession',
    resave: false,
    saveUninitialized: true,
}));

app.use(passport.initialize());
app.use(passport.session());

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', apiRoutes);
app.use('/auth', authRoutes);


const defaultExamplesPath = path.resolve(__dirname, '../../openhw-studio-examples/examples');
const examplesDir = process.env.EXAMPLES_DIR || defaultExamplesPath;
app.use('/examples', express.static(examplesDir));

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
await registerLiveSimulationWebSocket(server);
server.listen(PORT, () => {
  console.log(`OpenHW Studio Backend running on port ${PORT}`);
});
