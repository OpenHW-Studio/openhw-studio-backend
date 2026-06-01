import { acquirePoints, releasePoints } from './resourceManager.js';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS || '180000', 10); // 3 minutes

/**
 * Enqueues a compilation task to run when enough points are available in the unified pool.
 * 
 * @param {number} weight The point weight of this task (in MB)
 * @param {function} taskFn An async function that returns a Promise for the compilation work
 * @param {number} timeoutMs (Optional) Maximum time in ms before forceful timeout.
 * @returns {Promise<any>} Resolves with the result of taskFn, or rejects on error/timeout.
 */
export async function enqueueCompile(weight, taskFn, timeoutMs = DEFAULT_TIMEOUT_MS, tag = 'compiler') {
    console.log(`[CompileQueue] Requesting ${weight} points for "${tag}" from Unified Resource Manager...`);
    const allocId = await acquirePoints(weight, tag, timeoutMs);
    try {
        return await taskFn();
    } finally {
        releasePoints(allocId);
    }
}

