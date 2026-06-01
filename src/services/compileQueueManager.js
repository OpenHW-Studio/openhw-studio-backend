/**
 * compileQueueManager.js  —  src/services/compileQueueManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Global Weighted Concurrency Queue for compilation tasks.
 * Prevents OOM by strictly limiting the maximum active "points" consumed by compilers.
 */

const MAX_COMPILE_POINTS = parseInt(process.env.MAX_COMPILE_POINTS || '700', 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS || '180000', 10); // 3 minutes

let activePoints = 0;
const pendingQueue = [];

/**
 * Checks if the next pending job can be started, and if so, starts it.
 */
function processQueue() {
    if (pendingQueue.length === 0) return;

    // We only check the front of the queue (strict FIFO, no starvation)
    const nextJob = pendingQueue[0];
    if (activePoints + nextJob.weight <= MAX_COMPILE_POINTS) {
        pendingQueue.shift(); // Remove from queue
        startJob(nextJob);
        // Process again in case there's room for another
        processQueue();
    }
}

/**
 * Starts a job and handles its lifecycle.
 */
function startJob(job) {
    const { weight, timeoutMs, taskFn, resolve, reject } = job;
    activePoints += weight;

    console.log(`[CompileQueue] 🟢 Started job (Weight: ${weight}). Active Points: ${activePoints}/${MAX_COMPILE_POINTS}. Pending: ${pendingQueue.length}`);

    let isDone = false;
    let timeoutId = null;

    const finalize = (error, result) => {
        if (isDone) return;
        isDone = true;
        if (timeoutId) clearTimeout(timeoutId);

        activePoints -= weight;
        console.log(`[CompileQueue] 🔴 Finished job (Weight: ${weight}). Active Points: ${activePoints}/${MAX_COMPILE_POINTS}. Pending: ${pendingQueue.length}`);

        if (error) {
            reject(error);
        } else {
            resolve(result);
        }

        // Check the queue for the next job
        processQueue();
    };

    timeoutId = setTimeout(() => {
        if (!isDone) {
            finalize(new Error(`CompileQueue timeout: Task exceeded ${timeoutMs}ms limit.`), null);
        }
    }, timeoutMs);

    // Execute the async task
    try {
        taskFn()
            .then(result => finalize(null, result))
            .catch(error => finalize(error, null));
    } catch (error) {
        finalize(error, null);
    }
}

/**
 * Enqueues a compilation task to run when enough points are available.
 * 
 * @param {number} weight The point weight of this task (e.g. 100 for Uno, 200 for Pico/ESP)
 * @param {function} taskFn An async function that returns a Promise for the compilation work
 * @param {number} timeoutMs (Optional) Maximum time in ms before forceful timeout. Defaults to 3 mins.
 * @returns {Promise<any>} Resolves with the result of taskFn, or rejects on error/timeout.
 */
export function enqueueCompile(weight, taskFn, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const job = { weight, timeoutMs, taskFn, resolve, reject };

        if (activePoints + weight <= MAX_COMPILE_POINTS) {
            startJob(job);
        } else {
            pendingQueue.push(job);
            console.log(`[CompileQueue] 🟡 Queued job (Weight: ${weight}). Active Points: ${activePoints}/${MAX_COMPILE_POINTS}. Pending: ${pendingQueue.length}`);
        }
    });
}
