import fs from 'fs';
import path from 'path';
import { getBackendRoot } from '../compiler/paths.js';

const TEMP_DIR = path.join(getBackendRoot(), 'temp');

// ─── Cache storage limits (env-configurable for Docker deploys) ─────────────
// RESULT_CACHE_MAX_MB:    hard cap for temp/compile-results (default 500 MB).
// RESULT_CACHE_TARGET_MB: prune down to this after exceeding the cap (default 400 MB).
const parseMb = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const RESULT_MAX_MB = parseMb(process.env.RESULT_CACHE_MAX_MB, 500);
const RESULT_TARGET_MB = Math.min(parseMb(process.env.RESULT_CACHE_TARGET_MB, 400), RESULT_MAX_MB);

const CACHE_DIRS = [
    { target: 'compile-results', path: path.join(TEMP_DIR, 'compile-results'), binary: 'result.json' },
    // Legacy dir from before the compiler-worker refactor; pruned if present,
    // ignored once empty. Safe to remove this entry after one release cycle.
    { target: 'pico-uno-legacy', path: path.join(TEMP_DIR, 'pico-uno-compile-cache'), binary: 'result.json' }
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
 * Calculates total size of the firmware result cache pool (L2 disk,
 * temp/compile-results) and evicts least recently used entries when total
 * usage exceeds 500 MB, down to 400 MB.
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

        // The compiler-worker container owns /app/temp, so this limit applies
        // to that one service. This leaves headroom on the worker for active builds.
        const limitBytes  = RESULT_MAX_MB * 1024 * 1024;
        const targetBytes = RESULT_TARGET_MB * 1024 * 1024;

        if (totalSize > limitBytes) {
            console.log(`[Compile Cache Pool] ⚠️ Storage limit exceeded (${sizeInMb.toFixed(2)} MB > ${RESULT_MAX_MB} MB). Starting LRU eviction...`);
            
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
