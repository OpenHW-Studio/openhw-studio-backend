/**
 * src/stm32/index.js  —  Backend STM32 module barrel
 * ─────────────────────────────────────────────────────────────────────────────
 * Exports:
 *   initSTM32Module(httpServer)  — called once in server.js to attach the
 *                                   STM32 WebSocket bridge to the HTTP server.
 *
 *   handleSTM32Compile           — POST /api/compile  (target=stm32)
 *                                   called from src/controllers/compileController.js
 *
 *   handleSTM32Stop              — POST /api/compile/stm32/stop/:buildId
 *                                   registered in src/routes/compile.js
 */

import wsManager from './utils/websocketManager.js';
import {
    compileArduinoCode,
    compileStart,
    compileStatus,
    stopSession,
} from './controller/compileController.js';

/**
 * Attach the STM32 WebSocket bridge to the already-created HTTP server.
 * Must be called AFTER express is wired up but BEFORE server.listen().
 *
 * @param {import('http').Server} httpServer
 */
export function initSTM32Module(httpServer) {
    try {
        wsManager.init(httpServer);
        console.log('✅ STM32 WebSocket bridge initialised on ws://…/');
    } catch (err) {
        console.warn(
            '⚠️  STM32 WebSocket bridge failed to initialise:',
            err?.message || err,
        );
    }
}

/** Express route handler: compile Arduino/STM32 code and launch Renode. */
export const handleSTM32Compile = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const workerUrl = process.env.STM32_WORKER_HTTP_URL || 'http://stm32-worker:5002';
        try {
            const response = await fetch(`${workerUrl}/api/compile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
            });
            const data = await response.json();
            if (response.ok && data.success && data.buildId) {
                wsManager.setTarget(data.buildId, 'stm32');
            }
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[STM32 Proxy] Compile proxy failed:`, err);
            return res.status(502).json({ error: 'STM32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return compileArduinoCode(req, res);
};

/** Express route handler: start compilation (polling mode). */
export const handleSTM32CompileStart = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const workerUrl = process.env.STM32_WORKER_HTTP_URL || 'http://stm32-worker:5002';
        try {
            const response = await fetch(`${workerUrl}/api/compile/stm32/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
            });
            const data = await response.json();
            if (response.ok && data.success && data.buildId) {
                wsManager.setTarget(data.buildId, 'stm32');
            }
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[STM32 Proxy] Compile Start proxy failed:`, err);
            return res.status(502).json({ error: 'STM32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return compileStart(req, res);
};

/** Express route handler: get compilation status. */
export const handleSTM32CompileStatus = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const { jobId } = req.params;
        const workerUrl = process.env.STM32_WORKER_HTTP_URL || 'http://stm32-worker:5002';
        try {
            const response = await fetch(`${workerUrl}/api/compile/stm32/status/${jobId}`);
            const data = await response.json();
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[STM32 Proxy] Compile Status proxy failed:`, err);
            return res.status(502).json({ error: 'STM32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return compileStatus(req, res);
};

/** Express route handler: stop a running Renode session by buildId. */
export const handleSTM32Stop = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const { buildId } = req.params;
        const workerUrl = process.env.STM32_WORKER_HTTP_URL || 'http://stm32-worker:5002';
        try {
            const response = await fetch(`${workerUrl}/api/compile/stm32/stop/${buildId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
            });
            const data = await response.json();
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[STM32 Proxy] Stop proxy failed:`, err);
            return res.status(502).json({ error: 'STM32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return stopSession(req, res);
};
