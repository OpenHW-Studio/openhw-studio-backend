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

                // Use binary size if exists, otherwise folder stats
                const entrySize = binaryStat ? binaryStat.size : 1024; // fallback
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

        // If cache exceeds 900 MB (943,718,400 bytes), prune down to 800 MB (838,860,800 bytes)
        const limitBytes = 900 * 1024 * 1024;
        const targetBytes = 800 * 1024 * 1024;

        if (totalSize > limitBytes) {
            console.log(`[Compile Cache Pool] ⚠️ Storage limit exceeded (${sizeInMb.toFixed(2)} MB > 900 MB). Starting LRU eviction...`);
            
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
