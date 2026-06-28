/**
 * src/esp32/index.js  —  Backend ESP32 module barrel
 * ─────────────────────────────────────────────────────────────────────────────
 * Exports:
 *   initESP32Module(httpServer)  — called once in server.js to attach the
 *                                   ESP32 WebSocket bridge to the HTTP server.
 *
 *   handleESP32Compile           — POST /api/compile  (target=esp32)
 *                                   called from src/controllers/compileController.js
 *
 *   handleESP32Stop              — POST /api/compile/esp32/stop/:buildId
 *   handleESP32DirectBoot        — POST /api/compile/esp32/direct-boot
 *                                   both registered in src/routes/compile.js
 */

import wsManager from './utils/websocketManager.js';
import {
    compileArduinoCode,
    stopSession,
    directBoot,
    runBinary,
    compileStart,
    compileStatus,
} from './controller/compileController.js';


/**
 * Attach the ESP32 WebSocket bridge to the already-created HTTP server.
 * Must be called AFTER express is wired up but BEFORE server.listen().
 *
 * @param {import('http').Server} httpServer
 */
export function initESP32Module(httpServer) {
    try {
        wsManager.init(httpServer);
        console.log('✅ ESP32 WebSocket bridge initialised on ws://…/');
    } catch (err) {
        console.warn(
            '⚠️  ESP32 WebSocket bridge failed to initialise:',
            err?.message || err,
        );
    }
}

async function proxyPost(url, req, res) {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(req.body),
        });
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (err) {
        console.error(`[ESP32 Proxy] Failed to proxy to ${url}:`, err);
        return res.status(502).json({ error: 'Failed to communicate with ESP32 worker.', details: err.message });
    }
}

/** Express route handler: compile Arduino/ESP32 code and launch QEMU. */
export const handleESP32Compile = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const workerUrl = process.env.COMPILE_SERVER_HTTP_URL || 'http://compile-server:5001';
        try {
            const response = await fetch(`${workerUrl}/api/compile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
            });
            const data = await response.json();
            if (response.ok && data.success && data.buildId) {
                wsManager.setTarget(data.buildId, 'esp32');
            }
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[ESP32 Proxy] Compile proxy failed:`, err);
            return res.status(502).json({ error: 'ESP32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return compileArduinoCode(req, res);
};

/** Express route handler: stop a running QEMU session by buildId. */
export const handleESP32Stop = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const { buildId } = req.params;
        const workerUrl = process.env.COMPILE_SERVER_HTTP_URL || 'http://compile-server:5001';
        return proxyPost(`${workerUrl}/api/compile/esp32/stop/${buildId}`, req, res);
    }
    return stopSession(req, res);
};

/** Express route handler: boot QEMU directly from a pre-compiled .bin. */
export const handleESP32DirectBoot = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const workerUrl = process.env.COMPILE_SERVER_HTTP_URL || 'http://compile-server:5001';
        try {
            const response = await fetch(`${workerUrl}/api/compile/esp32/direct-boot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
            });
            const data = await response.json();
            if (response.ok && data.success && data.buildId) {
                wsManager.setTarget(data.buildId, 'esp32');
            }
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[ESP32 Proxy] Direct-boot proxy failed:`, err);
            return res.status(502).json({ error: 'ESP32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return directBoot(req, res);
};

/** Express route handler: boot QEMU directly from a dynamic base64-encoded .bin. */
export const handleESP32RunBinary = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const workerUrl = process.env.COMPILE_SERVER_HTTP_URL || 'http://compile-server:5001';
        try {
            const response = await fetch(`${workerUrl}/api/compile/esp32/run-binary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
            });
            const data = await response.json();
            if (response.ok && data.success && data.buildId) {
                wsManager.setTarget(data.buildId, 'esp32');
            }
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[ESP32 Proxy] Run-binary proxy failed:`, err);
            return res.status(502).json({ error: 'ESP32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return runBinary(req, res);
};

/** Express route handler: compile start */
export const handleESP32CompileStart = async (req, res) => {
    if (process.env.ROLE === 'main') {
        const workerUrl = process.env.COMPILE_SERVER_HTTP_URL || 'http://compile-server:5001';
        try {
            const response = await fetch(`${workerUrl}/api/compile/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
            });
            const data = await response.json();
            if (response.ok && data.success && data.buildId) {
                wsManager.setTarget(data.buildId, 'esp32');
            }
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[ESP32 Proxy] Compile-start proxy failed:`, err);
            return res.status(502).json({ error: 'ESP32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return compileStart(req, res);
};

/** Express route handler: compile status */
export const handleESP32CompileStatus = async (req, res) => {
    const { jobId } = req.params;
    if (process.env.ROLE === 'main') {
        const workerUrl = process.env.COMPILE_SERVER_HTTP_URL || 'http://compile-server:5001';
        try {
            const response = await fetch(`${workerUrl}/api/compile/status/${jobId}`, {
                method: 'GET',
            });
            const data = await response.json();
            return res.status(response.status).json(data);
        } catch (err) {
            console.error(`[ESP32 Proxy] Compile-status proxy failed:`, err);
            return res.status(502).json({ error: 'ESP32 simulation worker is offline or unavailable.', details: err.message });
        }
    }
    return compileStatus(req, res);
};
