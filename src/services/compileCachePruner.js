import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUILDS_DIR = path.resolve(__dirname, '../../builds');
const TEMP_DIR = path.resolve(__dirname, '../../temp');

const CACHE_DIRS = [
    { target: 'esp32',    path: path.join(BUILDS_DIR, 'esp32-compile-cache'),     binary: 'merged-flash.bin' },
    { target: 'stm32',    path: path.join(BUILDS_DIR, 'stm32-compile-cache'),     binary: 'firmware.elf' },
    { target: 'pico-uno', path: path.join(TEMP_DIR, 'pico-uno-compile-cache'),    binary: 'result.json' }
];

/**
 * Recursively sum the byte size of all files in a directory.
 * This gives the real on-disk cost of a cache entry, not just the binary.
 */
function _folderSize(dirPath) {
    let total = 0;
    try {
        for (const name of fs.readdirSync(dirPath)) {
            const fullPath = path.join(dirPath, name);
            const st = fs.statSync(fullPath);
            if (st.isDirectory()) {
                total += _folderSize(fullPath);
            } else {
                total += st.size;
            }
        }
    } catch { /* ignore unreadable entries */ }
    return total;
}

/**
 * Calculates total size of the compilation cache pool and evicts least recently
 * used entries if total usage exceeds 900 MB, down to 800 MB.
 * Runs asynchronously to prevent blocking request threads.
 */
export async function pruneUniversalCachePool() {
    try {
        const allCachedEntries = [];
        let totalSize = 0;

        // Ensure all folders exist
        for (const dir of CACHE_DIRS) {
            if (!fs.existsSync(dir.path)) {
                try { fs.mkdirSync(dir.path, { recursive: true }); } catch {}
                continue;
            }

            const entries = fs.readdirSync(dir.path);
            for (const entryHash of entries) {
                const folderPath = path.join(dir.path, entryHash);
                const binaryPath = path.join(folderPath, dir.binary);

                let folderStat = null;
                let binaryStat = null;

                try {
                    folderStat = fs.statSync(folderPath);
                    if (fs.existsSync(binaryPath)) {
                        binaryStat = fs.statSync(binaryPath);
                    }
                } catch {
                    continue;
                }

                if (!folderStat || !folderStat.isDirectory()) continue;

                // Walk the entire folder so we count .elf, .map, .bin etc — not just the binary.
                // Previously only the binary file (~4 MB) was counted, causing severe undercounting
                // and the pruner threshold was never reached even when the filesystem was full.
                const entrySize = _folderSize(folderPath);
                totalSize += entrySize;

                allCachedEntries.push({
                    folderPath,
                    size: entrySize,
                    // Use last modified/access time representing the last compile/run
                    mtimeMs: binaryStat ? binaryStat.mtimeMs : folderStat.mtimeMs
                });
            }
        }

        const sizeInMb = totalSize / (1024 * 1024);
        console.log(`[Compile Cache Pool] Current total storage usage: ${sizeInMb.toFixed(2)} MB`);

        // Each Docker container has its own isolated /app/builds tmpfs, so this
        // limit applies per-container (esp32-worker and stm32-worker independently).
        // Cap cache at 500 MB; prune down to 400 MB when exceeded.
        // This leaves ≥1.5 GB headroom on esp32-worker (2 GB tmpfs)
        // and ≥500 MB headroom on stm32-worker (1 GB tmpfs) for active builds.
        const limitBytes  = 500 * 1024 * 1024; // 500 MB
        const targetBytes = 400 * 1024 * 1024; // 400 MB

        if (totalSize > limitBytes) {
            console.log(`[Compile Cache Pool] ⚠️ Storage limit exceeded (${sizeInMb.toFixed(2)} MB > 500 MB). Starting LRU eviction...`);
            
            // Sort entries ascending (oldest first)
            allCachedEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);

            let bytesDeleted = 0;
            for (const entry of allCachedEntries) {
                if (totalSize - bytesDeleted <= targetBytes) break;

                try {
                    fs.rmSync(entry.folderPath, { recursive: true, force: true });
                    bytesDeleted += entry.size;
                    console.log(`[Compile Cache Pool] 🧹 Evicted least-used build: ${path.basename(entry.folderPath)} (${(entry.size / (1024 * 1024)).toFixed(2)} MB)`);
                } catch (e) {
                    console.error(`[Compile Cache Pool] Eviction failed for ${entry.folderPath}:`, e.message);
                }
            }

            const updatedSizeInMb = (totalSize - bytesDeleted) / (1024 * 1024);
            console.log(`[Compile Cache Pool] 🟢 Eviction complete. Storage usage reduced to: ${updatedSizeInMb.toFixed(2)} MB`);
        }
    } catch (err) {
        console.error('[Compile Cache Pool] Universal cache pruning failed:', err.message);
    }
}
