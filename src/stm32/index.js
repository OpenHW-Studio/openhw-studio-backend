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
export const handleSTM32Compile = compileArduinoCode;

/** Express route handler: stop a running Renode session by buildId. */
export const handleSTM32Stop = stopSession;
