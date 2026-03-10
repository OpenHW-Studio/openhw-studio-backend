import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import connectDB from "./db/connections.js";
import apiRoutes from "./routes/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to load from '../env' (local) or process.env directly (production/Docker)
dotenv.config({ path: path.join(__dirname, '../env') });
dotenv.config(); // Also load from root .env if it exists

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
  fs.writeFileSync(indexFile, '// OpenHW Studio Component Index\n');
  console.log(`Initialized: ${indexFile}`);
}

// Connect to MongoDB
console.log("Attempting to connect to MongoDB...");

connectDB();
const app = express();

app.use(cors()); 
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

app.use("/api", apiRoutes);

// Serve demo/guide files from openhw-studio-examples repo
const examplesDir = path.resolve(__dirname, '../../openhw-studio-examples/examples');
app.use('/examples', express.static(examplesDir));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`OpenHW Studio Backend running on port ${PORT}`);
});
