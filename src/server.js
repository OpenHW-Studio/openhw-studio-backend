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

const examplesDir = path.resolve(__dirname, '../../openhw-studio-examples/examples');
app.use('/examples', express.static(examplesDir));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`OpenHW Studio Backend running on port ${PORT}`);
});