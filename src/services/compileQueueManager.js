import { acquirePoints, releasePoints } from './resourceManager.js';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS || '180000', 10); // 3 minutes

/**
 * Runs a compilation task if the resource pool has room right now.
 * Fail-fast: when the pool is full, the POOL_FULL rejection propagates to
 * the controller, which answers HTTP 503 "compile server is full" — the
 * request is never queued. (timeoutMs kept for signature compat; unused.)
 *
 * @param {number} weight The point weight of this task (in MB)
 * @param {function} taskFn An async function that returns a Promise for the compilation work
 * @param {number} timeoutMs (Optional, unused) Kept for backward compat.
 * @returns {Promise<any>} Resolves with the result of taskFn, or rejects with POOL_FULL.
 */
export async function enqueueCompile(weight, taskFn, timeoutMs = DEFAULT_TIMEOUT_MS, tag = 'compiler') {
    console.log(`[CompileQueue] Requesting ${weight} points for "${tag}" from Resource Manager (fail-fast, no queue)...`);
    const allocId = await acquirePoints(weight, tag, timeoutMs);
    try {
        return await taskFn();
    } finally {
        releasePoints(allocId);
    }
}

