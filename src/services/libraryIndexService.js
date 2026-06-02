import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data directory paths
const DATA_DIR = path.resolve(__dirname, '../../../data/libraries');
const LOCAL_INDEX_PATH = path.join(DATA_DIR, 'library_index.json');
const LOCAL_PYTHON_PATH = path.join(DATA_DIR, 'python_bundle_index.json');

// AppData Candidates for fast local copying on first boot (prevents large downloads)
const APPDATA_CANDIDATES = [
  process.env.ARDUINO_DATA_DIR,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Arduino15') : null,
  process.env.APPDATA ? path.join(process.env.APPDATA, 'Arduino15') : null,
  path.join(os.homedir(), '.arduino15'),
  '/root/.arduino15',
  '/home/user/.arduino15'
].filter(Boolean);

const ARDUINO_INDEX_URL = 'https://downloads.arduino.cc/libraries/library_index.json';
const PYTHON_INDEX_URL = 'https://micropython.org/pi/v2/index.json';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let libraryIndex = [];
let libraryMap = new Map(); // name.toLowerCase() -> Array of releases
let pythonIndex = null;     // MicroPython mip packages/index

/**
 * Compare two SemVer-like version strings.
 * Returns > 0 if v1 > v2, < 0 if v1 < v2, 0 if equal.
 */
function compareVersions(v1, v2) {
  if (!v1) return -1;
  if (!v2) return 1;
  const p1 = String(v1).split('.').map(Number);
  const p2 = String(v2).split('.').map(Number);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const n1 = isNaN(p1[i]) ? 0 : p1[i];
    const n2 = isNaN(p2[i]) ? 0 : p2[i];
    if (n1 !== n2) return n1 - n2;
  }
  return 0;
}

/**
 * Load index files from disk into memory.
 */
function loadIndexesFromDisk() {
  // 1. Arduino index
  if (fs.existsSync(LOCAL_INDEX_PATH)) {
    try {
      console.log(`[LibraryIndex] Loading Arduino library index from ${LOCAL_INDEX_PATH}...`);
      const start = Date.now();
      const content = fs.readFileSync(LOCAL_INDEX_PATH, 'utf8');
      const data = JSON.parse(content);
      libraryIndex = data.libraries || [];
      
      // Group by name for O(1) retrieval
      libraryMap = new Map();
      for (const lib of libraryIndex) {
        if (!lib.name) continue;
        const key = lib.name.toLowerCase();
        if (!libraryMap.has(key)) {
          libraryMap.set(key, []);
        }
        libraryMap.get(key).push(lib);
      }
      console.log(`[LibraryIndex] Loaded ${libraryIndex.length} Arduino library releases in ${Date.now() - start}ms.`);
    } catch (err) {
      console.error(`[LibraryIndex] Failed to parse local Arduino index:`, err.message);
    }
  }

  // 2. Python bundle index
  if (fs.existsSync(LOCAL_PYTHON_PATH)) {
    try {
      console.log(`[LibraryIndex] Loading Python bundle index from ${LOCAL_PYTHON_PATH}...`);
      const content = fs.readFileSync(LOCAL_PYTHON_PATH, 'utf8');
      pythonIndex = JSON.parse(content);
      console.log(`[LibraryIndex] Loaded Python bundle index successfully.`);
    } catch (err) {
      console.error(`[LibraryIndex] Failed to parse local Python index:`, err.message);
    }
  }
}

/**
 * Background downloading helper
 */
async function downloadIndexFile(url, destPath, label) {
  try {
    console.log(`[LibraryIndex] Downloading latest ${label} index from ${url}...`);
    const start = Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    
    const buffer = Buffer.from(await res.arrayBuffer());
    
    // Ensure parent dir exists
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    
    // Write atomically
    const tempPath = destPath + '.tmp';
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, destPath);
    
    console.log(`[LibraryIndex] Downloaded ${label} index in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
    return true;
  } catch (err) {
    console.error(`[LibraryIndex] Failed to download ${label} index:`, err.message);
    return false;
  }
}

/**
 * Check if a file is older than 24 hours
 */
function isFileExpired(filePath) {
  if (!fs.existsSync(filePath)) return true;
  try {
    const stats = fs.statSync(filePath);
    const ageMs = Date.now() - stats.mtimeMs;
    return ageMs > REFRESH_INTERVAL_MS;
  } catch {
    return true;
  }
}

/**
 * Attempt to copy local files from AppData candidates on first boot
 */
function copyIndexFromLocalSystem() {
  if (fs.existsSync(LOCAL_INDEX_PATH)) return;

  for (const dir of APPDATA_CANDIDATES) {
    const candidatePath = path.join(dir, 'library_index.json');
    if (fs.existsSync(candidatePath)) {
      try {
        console.log(`[LibraryIndex] Found local library_index.json at ${candidatePath}. Copying to server cache...`);
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.copyFileSync(candidatePath, LOCAL_INDEX_PATH);
        console.log(`[LibraryIndex] Successfully copied library_index.json.`);
        return;
      } catch (err) {
        console.warn(`[LibraryIndex] Failed to copy index from ${candidatePath}:`, err.message);
      }
    }
  }
}

/**
 * Public function to search libraries locally in-memory
 */
export function searchLibrariesLocal(query, limit = 50) {
  const term = query.toLowerCase().trim();
  if (!term) return [];

  const nameToLatest = new Map();

  for (const lib of libraryIndex) {
    if (!lib.name) continue;
    const nameLower = lib.name.toLowerCase();
    
    const matches = nameLower.includes(term) || 
                    (lib.sentence && lib.sentence.toLowerCase().includes(term)) ||
                    (lib.author && lib.author.toLowerCase().includes(term));
    
    if (matches) {
      const existing = nameToLatest.get(nameLower);
      if (!existing || compareVersions(lib.version, existing.version) > 0) {
        nameToLatest.set(nameLower, lib);
      }
    }
  }

  return Array.from(nameToLatest.values()).slice(0, limit);
}

/**
 * Public function to retrieve library details by name
 */
export function getLibraryMetadata(name) {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  const releases = libraryMap.get(key);
  if (!releases || releases.length === 0) return null;

  // Find the latest release
  const sorted = [...releases].sort((a, b) => compareVersions(b.version, a.version));
  const latest = sorted[0];

  // Map release versions
  const releasesMap = {};
  for (const rel of releases) {
    releasesMap[rel.version] = {
      version: rel.version,
      resources: {
        url: rel.url,
        size: rel.size,
        checksum: rel.checksum
      }
    };
  }

  return {
    name: latest.name,
    author: latest.author,
    maintainer: latest.maintainer,
    sentence: latest.sentence,
    paragraph: latest.paragraph,
    website: latest.website,
    category: latest.category,
    latest: {
      version: latest.version,
      resources: {
        url: latest.url,
        size: latest.size,
        checksum: latest.checksum
      }
    },
    releases: releasesMap
  };
}

/**
 * Perform background index refresh checks
 */
export async function refreshIndexesBackground() {
  let needsReload = false;

  // 1. Arduino Library Index
  if (isFileExpired(LOCAL_INDEX_PATH)) {
    const ok = await downloadIndexFile(ARDUINO_INDEX_URL, LOCAL_INDEX_PATH, 'Arduino');
    if (ok) needsReload = true;
  }

  // 2. Python Bundle Index
  if (isFileExpired(LOCAL_PYTHON_PATH)) {
    const ok = await downloadIndexFile(PYTHON_INDEX_URL, LOCAL_PYTHON_PATH, 'Python Bundle');
    if (ok) needsReload = true;
  }

  if (needsReload) {
    loadIndexesFromDisk();
  }
}

/**
 * Initialize library index service on server startup
 */
export function initLibraryIndexService() {
  try {
    // Ensure cache dir exists
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Step A: Attempt fast local copy if cache is empty
    copyIndexFromLocalSystem();

    // Step B: Load existing indexes from disk
    loadIndexesFromDisk();

    // Step C: Trigger asynchronous background download check immediately
    refreshIndexesBackground().catch(err => {
      console.error('[LibraryIndex] Background initialization error:', err.message);
    });

    // Step D: Schedule periodic refresh checks every 1 hour
    setInterval(() => {
      refreshIndexesBackground().catch(err => {
        console.error('[LibraryIndex] Background interval error:', err.message);
      });
    }, 60 * 60 * 1000); // 1 hour checks

  } catch (err) {
    console.error('[LibraryIndex] Initialization failed:', err);
  }
}
