/**
 * resultCache.js — src/compiler/resultCache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Binary (firmware) cache owned by the compiler-worker. Three layers:
 *
 *   L1 in-memory Map   — fastest; TTL + LRU cap, per process.
 *   L2 disk result.json — temp/compile-results/<hash>/result.json; survives
 *                         restarts; LRU-pruned by compileCachePruner.
 *   L3 frontend IndexedDB / offlineCache — owned by the frontend, keyed by
 *                         the same payload hash (see simulatorService.js
 *                         computePayloadHash). Not touched here.
 *
 * Cache key = sha1(code + files + fqbn + builder + libraries_txt + artifacts),
 * so different artifact selections never collide.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pruneUniversalCachePool } from '../services/compileCachePruner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.resolve(__dirname, '../../temp');
const RESULT_CACHE_ROOT = path.join(TEMP_DIR, 'compile-results');

// L1 in-memory caps (env-configurable for Docker deploys):
// COMPILE_RESULT_TTL_MS  — entry age before expiry (default 30 min).
// COMPILE_RESULT_CACHE_MAX — max entries in the Map (default 120).
const RESULT_TTL_MS = Number(process.env.COMPILE_RESULT_TTL_MS || (1000 * 60 * 30));
const RESULT_CACHE_MAX = Math.max(8, Number(process.env.COMPILE_RESULT_CACHE_MAX || 120));

const memoryCache = new Map();

function pruneMemoryCache() {
    const now = Date.now();
    for (const [key, entry] of memoryCache.entries()) {
        if (!entry || (now - entry.createdAt) > RESULT_TTL_MS) {
            memoryCache.delete(key);
        }
    }

    while (memoryCache.size > RESULT_CACHE_MAX) {
        const oldestKey = memoryCache.keys().next().value;
        if (!oldestKey) break;
        memoryCache.delete(oldestKey);
    }
}

export function getCompileResultFromCache(requestHash) {
    if (!requestHash) return null;

    // L1: in-memory
    pruneMemoryCache();
    const hit = memoryCache.get(requestHash);
    if (hit) {
        // Touch for simple LRU behavior.
        memoryCache.delete(requestHash);
        memoryCache.set(requestHash, hit);
        return hit;
    }

    // L2: on-disk result.json
    const cacheFile = path.join(RESULT_CACHE_ROOT, requestHash, 'result.json');
    if (fs.existsSync(cacheFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            // Touch mtime to mark it as recently used
            const now = new Date();
            fs.utimesSync(cacheFile, now, now);
            fs.utimesSync(path.dirname(cacheFile), now, now);

            // Populate L1
            memoryCache.set(requestHash, data);
            return data;
        } catch {
            return null;
        }
    }

    return null;
}

export function setCompileResultCache(requestHash, payload) {
    if (!requestHash || !payload || !payload.hex) return;

    const data = {
        createdAt: Date.now(),
        hex: payload.hex,
        artifactType: payload.artifactType || null,
        artifactName: payload.artifactName || null,
        elf: payload.elf || '',
        elfName: payload.elfName || null,
        gdb: payload.gdb || null,
        stdout: payload.stdout || '',
        diagnostics: payload.diagnostics || null,
        artifacts: payload.artifacts || {},
        requestedArtifacts: payload.requestedArtifacts || [],
    };

    memoryCache.set(requestHash, data);
    pruneMemoryCache();

    // Persist L2 to disk and prune
    try {
        const cacheDir = path.join(RESULT_CACHE_ROOT, requestHash);
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, 'result.json'), JSON.stringify(data, null, 2), 'utf8');
        pruneUniversalCachePool();
    } catch (e) {
        console.error('[Compile Cache] Failed to write result cache to disk:', e.message);
    }
}
