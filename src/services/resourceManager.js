/**
 * resourceManager.js  —  src/services/resourceManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified Resource Manager. Manages point pool (1 point = 1 MB RAM).
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { getDataRoot } from '../compiler/paths.js';

const BUDGET_FILE = path.join(getDataRoot(), 'calibrated_budget.json');

const DEFAULT_BUDGET = {
    uno_compile: 150, uno_sim: 50,
    pico_compile: 300, pico_sim: 100
};

export function loadCalibratedBudget() {
    if (fs.existsSync(BUDGET_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
        } catch (_) {}
    }
    return DEFAULT_BUDGET;
}

// Pool size: this process's own share of the box, NOT host RAM.
// On a 4 CPU / 16 GB host the compiler-worker container gets 8 GB, so the
// pool is (8 GB − reserve). Overridable via COMPILE_POOL_MB for testing or
// differently-sized workers. The old code read host RAM (os.totalmem),
// which over-admits compiles when the container limit is much smaller.
const WORKER_MEM_MB = Math.max(
    512,
    Number(process.env.COMPILE_POOL_MB || 8192),
);
const COMPILER_RESERVE_MB = Math.max(
    0,
    Number(process.env.COMPILE_RESERVE_MB || 1024),
);
export const GLOBAL_POOL_LIMIT = Math.max(500, WORKER_MEM_MB - COMPILER_RESERVE_MB);

let activePoints = 0;
const activeAllocations = new Map(); // key (id) -> { id, points, tag, timestamp }
let budget = loadCalibratedBudget();

/**
 * Reloads the budget mapping from calibration configuration.
 */
export function reloadBudget() {
    budget = loadCalibratedBudget();
}

/**
 * Returns point cost for a given operation.
 */
export function getCost(target, type) {
    const key = `${target.toLowerCase()}_${type.toLowerCase()}`;
    return budget[key] || 150; // default fallback
}

/**
 * Returns the current status of the resource pool.
 */
export function getStatus() {
    return {
        totalPoints: GLOBAL_POOL_LIMIT,
        activePoints,
        availablePoints: GLOBAL_POOL_LIMIT - activePoints,
        waitingCount: 0, // no queue: full pool rejects immediately (see acquirePoints)
        budget,
        allocations: Array.from(activeAllocations.values())
    };
}

/**
 * Request points from the pool.
 * Policy (per user decision): NO waiting queue for compiles — if the pool
 * can't fit the request right now, reject immediately so the caller gets
 * HTTP 503 "compile server is full". This keeps fail-fast behavior under
 * exam-spike load instead of piling up 3-minute timeouts.
 * Returns a Promise that resolves with an allocation ID.
 */
export function acquirePoints(points, tag = 'unknown', timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).substring(2, 9);

        // Attempt immediate allocation
        if (activePoints + points <= GLOBAL_POOL_LIMIT) {
            activePoints += points;
            activeAllocations.set(id, { id, points, tag, timestamp: Date.now() });
            console.log(`[ResourceManager] 🟢 Points acquired: ${points} for tag "${tag}". Pool: ${activePoints}/${GLOBAL_POOL_LIMIT}`);
            return resolve(id);
        }

        // Pool full → reject immediately (no queue).
        const err = new Error('Compile server is full for now. Please try again in a moment.');
        err.code = 'POOL_FULL';
        err.retryAfterSec = 30;
        console.log(`[ResourceManager] 🔴 Pool full (${activePoints}/${GLOBAL_POOL_LIMIT}), rejecting ${points} pts for "${tag}".`);
        return reject(err);
    });
}

/**
 * Releases points back to the global pool.
 * Can be called with either an allocation ID (string) or raw points (number, for backward compatibility).
 */
export function releasePoints(allocationKey) {
    let pointsToRelease = 0;

    if (typeof allocationKey === 'string') {
        const alloc = activeAllocations.get(allocationKey);
        if (alloc) {
            pointsToRelease = alloc.points;
            activeAllocations.delete(allocationKey);
            console.log(`[ResourceManager] 🔴 Releasing allocation "${alloc.id}" (${pointsToRelease} pts, tag: "${alloc.tag}")`);
        }
    } else if (typeof allocationKey === 'number') {
        pointsToRelease = allocationKey;
    }

    if (pointsToRelease > 0) {
        activePoints = Math.max(0, activePoints - pointsToRelease);
        console.log(`[ResourceManager] Pool status after release: ${activePoints}/${GLOBAL_POOL_LIMIT}`);
    }

    // No waiting queue (fail-fast policy) — nothing to drain here.
}
