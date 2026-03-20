import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import connectDB from './db/connections.js';
import apiRoutes from './routes/api.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import passport from './config/passport.js';
import authRoutes from './routes/auth.js';

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
connectDB();

const app = express();

app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecretcatsession',
    resave: false,
    saveUninitialized: true,
}));

app.use(passport.initialize());
app.use(passport.session());

app.use(cors());
app.use(express.json());

app.use('/api', apiRoutes);
app.use('/auth', authRoutes);

// Serve demo/guide files from openhw-studio-examples repo
const examplesDir = resolveConfiguredPath(process.env.EXAMPLES_PATH, [
  '../openhw-studio-examples-danish/examples',
  '../openhw-studio-examples/examples',
]);
app.use('/examples', express.static(examplesDir));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`OpenHW Studio Backend running on port ${PORT}`);
});