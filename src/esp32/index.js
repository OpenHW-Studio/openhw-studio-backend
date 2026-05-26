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

/** Express route handler: compile Arduino/ESP32 code and launch QEMU. */
export const handleESP32Compile = compileArduinoCode;

/** Express route handler: stop a running QEMU session by buildId. */
export const handleESP32Stop = stopSession;

/** Express route handler: boot QEMU directly from a pre-compiled .bin. */
export const handleESP32DirectBoot = directBoot;

/** Express route handler: boot QEMU directly from a dynamic base64-encoded .bin. */
export const handleESP32RunBinary = runBinary;
