/**
 * resourceManager.js  —  src/services/resourceManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified Resource Manager. Manages point pool (1 point = 1 MB RAM).
 */

import os from 'os';
import fs from 'fs';
import path from 'path';

const BUDGET_FILE = path.join('/app/data', 'calibrated_budget.json');

const DEFAULT_BUDGET = {
    uno_compile: 150, uno_sim: 50,
    pico_compile: 300, pico_sim: 100,
    esp32_compile: 800, esp32_sim: 250,
    stm32_compile: 400, stm32_sim: 150
};

export function loadCalibratedBudget() {
    if (fs.existsSync(BUDGET_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
        } catch (_) {}
    }
    return DEFAULT_BUDGET;
}

// Calculate global points pool (Total memory minus 2000MB system reserve)
const SYSTEM_RESERVE_MB = 2000;
const TOTAL_PHYSICAL_MB = Math.round(os.totalmem() / (1024 * 1024));
export const GLOBAL_POOL_LIMIT = Math.max(1000, TOTAL_PHYSICAL_MB - SYSTEM_RESERVE_MB);

let activePoints = 0;
const activeAllocations = new Map(); // key (id) -> { id, points, tag, timestamp }
const waitingQueue = [];
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
        waitingCount: waitingQueue.length,
        budget,
        allocations: Array.from(activeAllocations.values())
    };
}

/**
 * Request points from the global pool.
 * Returns a Promise that resolves with an allocation ID.
 */
export function acquirePoints(points, tag = 'unknown', timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).substring(2, 9);
        const request = { id, points, tag, resolve, reject, timeoutId: null };

        // Attempt immediate allocation
        if (activePoints + points <= GLOBAL_POOL_LIMIT) {
            activePoints += points;
            activeAllocations.set(id, { id, points, tag, timestamp: Date.now() });
            console.log(`[ResourceManager] 🟢 Points acquired: ${points} for tag "${tag}". Pool: ${activePoints}/${GLOBAL_POOL_LIMIT}`);
            return resolve(id);
        }

        // Enqueue if pool is full
        console.log(`[ResourceManager] 🟡 Resource limit reached. Queuing request for ${points} points ("${tag}"). Pool: ${activePoints}/${GLOBAL_POOL_LIMIT}`);
        
        request.timeoutId = setTimeout(() => {
            const idx = waitingQueue.findIndex(r => r.id === id);
            if (idx !== -1) {
                waitingQueue.splice(idx, 1);
                console.log(`[ResourceManager] ⏰ Request for ${points} points ("${tag}") timed out in queue.`);
                reject(new Error(`Timeout waiting for resource allocation (${points} points)`));
            }
        }, timeoutMs);

        waitingQueue.push(request);
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

    // Process waiting queue
    while (waitingQueue.length > 0) {
        const nextReq = waitingQueue[0];
        if (activePoints + nextReq.points <= GLOBAL_POOL_LIMIT) {
            waitingQueue.shift();
            if (nextReq.timeoutId) clearTimeout(nextReq.timeoutId);
            activePoints += nextReq.points;
            activeAllocations.set(nextReq.id, { id: nextReq.id, points: nextReq.points, tag: nextReq.tag, timestamp: Date.now() });
            console.log(`[ResourceManager] 🟢 Queued request allocated: ${nextReq.points} for tag "${nextReq.tag}". Pool: ${activePoints}/${GLOBAL_POOL_LIMIT}`);
            nextReq.resolve(nextReq.id);
        } else {
            break; // FIFO: block queue if next request can't be satisfied
        }
    }
}
