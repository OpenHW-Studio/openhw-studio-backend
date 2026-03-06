import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to load from '../env' (local) or process.env directly (production/Docker)
dotenv.config({ path: path.join(__dirname, '../env') });
dotenv.config(); // Also load from root .env if it exists

import connectDB from './db/connections.js';
import apiRoutes from './routes/api.js';

// Ensure required directories exist
const tempDir = path.join(__dirname, '../temp');
const dataDir = path.join(__dirname, '../data/components');
[tempDir, dataDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
});

// Connect to MongoDB
console.log("Attempting to connect to MongoDB...");
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`OpenHW Studio Backend running on port ${PORT}`);
});
