import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');

// OpenHW backend expects 'env' file historically, but we also support '.env'
const envFileExists = fs.existsSync(path.join(rootDir, 'env'));
if (envFileExists) {
  dotenv.config({ path: path.join(rootDir, 'env') });
} else {
  // Load standard .env from root
  dotenv.config({ path: path.join(rootDir, '.env') });
}

console.log('✅ Environment variables loaded');
