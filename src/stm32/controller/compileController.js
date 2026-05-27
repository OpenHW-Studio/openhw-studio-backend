/**
 * compileController.js  —  src/stm32/controller/compileController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express route handlers for the STM32 Renode simulation pipeline:
 *
 *   POST /api/compile          (target=stm32)  → compileArduinoCode
 *   POST /api/compile/stm32/stop/:buildId       → stopSession
 *
 * Compile pipeline:
 *   1. Validate request & check session capacity.
 *   2. Create an isolated build directory, write the .ino file with the
 *      STM32SimulatorBridge.h header injected at the top.
 *   3. Copy all simulator shim headers into the sketch directory.
 *   4. Respond immediately with { success, buildId } — compilation runs async.
 *   5. arduino-cli compiles the sketch to ELF artifacts.
 *   6. RenodeRunner starts Renode with the .elf file.
 *   7. All build events (success/error/serial/GPIO) flow via WebSocketManager.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

import wsManager  from '../utils/websocketManager.js';
import RenodeRunner from '../utils/renodeRunner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Path constants ────────────────────────────────────────────────────────────

const ARDUINO_CLI_PATH = process.env.ARDUINO_CLI_PATH || 'arduino-cli';
const TEMP_DIR    = path.resolve(__dirname, '../../../temp');
const BUILDS_DIR  = path.resolve(__dirname, '../../../builds');

// Simulator shim headers injected into every STM32 sketch build directory
const SHIM_HEADERS = Object.freeze([
    { src: path.resolve(__dirname, '../utils/STM32SimulatorBridge.h'),  dst: 'SimulatorBridge.h' },
    { src: path.resolve(__dirname, '../utils/STM32SimulatorBridge.cpp'),dst: 'SimulatorBridge.cpp' },
    { src: path.resolve(__dirname, '../utils/STM32SimulatorWire.h'),    dst: 'Wire.h'            },
    { src: path.resolve(__dirname, '../utils/STM32SimulatorWire.cpp'),  dst: 'Wire.cpp'          },
    { src: path.resolve(__dirname, '../utils/STM32SimulatorSPI.h'),     dst: 'SPI.h'             },
    { src: path.resolve(__dirname, '../utils/STM32SimulatorSPI.cpp'),   dst: 'SPI.cpp'           },
]);

// ─── Configuration constants ───────────────────────────────────────────────────

const MAX_SESSIONS = parseInt(process.env.STM32_MAX_SESSIONS || process.env.MAX_SESSIONS || '5', 10);

const SESSION_TIMEOUT_MS = parseInt(
    process.env.STM32_SESSION_TIMEOUT_MS || String(300 * 1000),
    10,
);

const COMPILE_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS || '180000', 10);

const CLEANUP_GRACE_MS = parseInt(process.env.CLEANUP_GRACE_MS || '8000', 10);

/**
 * FQBN for the STM32 Blue Pill target board.
 * The STM32 Arduino core uses: STM32:stm32:GenF1:pnum=BLUEPILL_F103C8
 */
const STM32_FQBN = process.env.STM32_FQBN || 'STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8';

/**
 * Number of lines in the injected preamble (before user code starts).
 * Used to shift compiler error line numbers back to the user's original lines.
 */
const INJECTED_LINE_COUNT = 13;

// ─── Active Renode sessions ───────────────────────────────────────────────────

/** @type {Map<string, RenodeRunner>} buildId → runner */
const _activeRunners = new Map();

// ─── Session GC ───────────────────────────────────────────────────────────────

const _gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [buildId, runner] of _activeRunners.entries()) {
        const isConnected = wsManager.hasLiveSession(buildId);

        if (isConnected) {
            runner.disconnectedAt = null;
        } else if (runner.disconnectedAt == null) {
            runner.disconnectedAt = now;
        }

        const disconnectedTime = runner.disconnectedAt ? (now - runner.disconnectedAt) : 0;

        if (now - runner.lastActivity > SESSION_TIMEOUT_MS || disconnectedTime > SESSION_TIMEOUT_MS) {
            console.log(`[STM32:Compile] 🧹  Session ${buildId} timed out — killing Renode`);
            runner.kill();
            _cleanup(buildId);
        }
    }
}, 5_000);
_gcTimer.unref();

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _cleanup(buildId) {
    _activeRunners.delete(buildId);

    const buildFolder = path.join(BUILDS_DIR, buildId);
    try {
        if (fs.existsSync(buildFolder)) {
            fs.rmSync(buildFolder, { recursive: true, force: true });
        }
    } catch (e) {
        console.error(`[STM32:Compile] Failed to delete build folder ${buildFolder}:`, e.message);
    }
}

function _deferredCleanup(buildId) {
    setTimeout(() => {
        wsManager.unregisterSession(buildId);
        _cleanup(buildId);
    }, CLEANUP_GRACE_MS);
}

function _sendErrorAndCleanup(buildId, output) {
    wsManager.sendToSession(buildId, {
        type:    'COMPILE_ERROR',
        buildId,
        output:  (output || 'Unknown compilation error').slice(0, 8192),
    });
    _deferredCleanup(buildId);
}

function _shiftLineNumbers(output, sketchFile) {
    if (!output) return output;
    const escaped = sketchFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped}):(\\d+)(:\\d+:.*)`, 'g');
    return output.replace(re, (_, file, lineStr, rest) => {
        const shifted = Math.max(1, parseInt(lineStr, 10) - INJECTED_LINE_COUNT);
        return `${file}:${shifted}${rest}`;
    });
}

// ─── Ensure required directories exist at startup ─────────────────────────────

for (const dir of [TEMP_DIR, BUILDS_DIR, path.join(TEMP_DIR, 'arduino-cache')]) {
    fs.mkdirSync(dir, { recursive: true });
}

// ─── WebSocket message handler ────────────────────────────────────────────────

wsManager.onClientConnection((ws) => {
    ws.on('message', (rawMsg) => {
        let data;
        try { data = JSON.parse(rawMsg.toString()); } catch { return; }

        // ── REGISTER_SESSION ─────────────────────────────────────────────────
        if (data.type === 'REGISTER_SESSION' && data.buildId) {
            const buildId   = data.buildId;
            const isLive    = _activeRunners.has(buildId);
            const isPending = wsManager.hasPendingSession(buildId);
            const isActive  = wsManager.hasLiveSession(buildId);

            if (isLive || isPending || isActive) {
                wsManager.registerSession(ws, buildId);
                wsManager.sendToSession(buildId, {
                    type:    'SESSION_REGISTERED',
                    buildId,
                    ready: _activeRunners.get(buildId)?.isReady ?? false,
                });
            } else {
                try {
                    ws.send(JSON.stringify({ type: 'SESSION_NOT_FOUND', buildId }));
                } catch { /* ignore */ }
            }
        }

        // ── SET_GPIO ─────────────────────────────────────────────────────────
        if (data.type === 'SET_GPIO' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                // pin is a string like "PA5" for STM32
                const pin   = String(data.pin);
                const value = Number(data.value);
                if (pin && !isNaN(value)) {
                    runner.setVirtualPin(pin, value);
                }
            }
        }

        // ── SET_ADC ──────────────────────────────────────────────────────────
        if (data.type === 'SET_ADC' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                const pin   = String(data.pin);
                const value = parseInt(data.value, 10);
                if (pin && !isNaN(value)) {
                    runner.setAdcValue(pin, value);
                }
            }
        }

        // ── ADC_SET (alias for SET_ADC used by some frontend components) ─────
        if (data.type === 'ADC_SET' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                runner.setAdcValue(String(data.pin), Number(data.value));
            }
        }

        // ── I2C_RESP_SET ─────────────────────────────────────────────────────
        if (data.type === 'I2C_RESP_SET' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner && typeof runner.setI2cResponse === 'function') {
                runner.setI2cResponse(data.addr, data.bytes || []);
            }
        }

        // ── SERIAL_INPUT ─────────────────────────────────────────────────────
        if (data.type === 'SERIAL_INPUT' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner && Array.isArray(data.bytes) && data.bytes.length > 0) {
                const raw = Buffer.from(data.bytes);
                runner._sendToFirmware(raw.toString());
            }
        }
    });

    ws.on('close', () => {
        console.log('[STM32:Compile] 📡 Client disconnected — Renode session preserved for reconnect window');
    });
});

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/compile  { code: string, target: 'stm32' }
 */
export const compileArduinoCode = (req, res) => {
    const { code, files, target, fqbn } = req.body || {};

    const isStm32 = target === 'stm32' || String(fqbn || '').toLowerCase().includes('stm32');
    if (!isStm32) {
        return res.status(400).json({ error: 'This handler only supports target="stm32" or STM32 FQBN.' });
    }

    let mainCode = typeof code === 'string' ? code : '';
    const fileList = Array.isArray(files) ? files : [];

    if (!mainCode && fileList.length > 0) {
        const firstIno = fileList.find(f => f && typeof f.name === 'string' && f.name.toLowerCase().endsWith('.ino'));
        if (firstIno && typeof firstIno.content === 'string') {
            mainCode = firstIno.content;
        }
    }

    if (!mainCode) {
        return res.status(400).json({ error: 'Request body must include a non-empty "code" string or a main ".ino" file in the "files" array.' });
    }

    if (_activeRunners.size >= MAX_SESSIONS) {
        return res.status(503).json({
            error: `STM32 server at capacity (${_activeRunners.size}/${MAX_SESSIONS} active sessions). ` +
                   `Please try again in a moment.`,
        });
    }

    // ── Build environment setup ───────────────────────────────────────────────
    const buildId   = crypto.randomUUID();
    const sketchDir = path.join(BUILDS_DIR, buildId);
    const buildDir  = path.join(sketchDir, 'build');

    // Sketch name MUST match the directory name (Arduino IDE rule)
    const sketchName = buildId;
    const sketchFile = path.join(sketchDir, `${sketchName}.ino`);

    // Open the pending buffer BEFORE any async I/O
    wsManager.createPendingSession(buildId);

    try {
        fs.mkdirSync(sketchDir, { recursive: true });
        fs.mkdirSync(buildDir,  { recursive: true });

        // Write additional files from the files array
        for (const file of fileList) {
            if (file && typeof file.name === 'string' && typeof file.content === 'string') {
                const ext = path.extname(file.name).toLowerCase();
                if (ext === '.ino') continue;
                if (['.h', '.hpp', '.c', '.cpp', '.s', '.S'].includes(ext)) {
                    const cleanName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
                    fs.writeFileSync(path.join(sketchDir, cleanName), file.content, 'utf8');
                }
            }
        }

        // ── Build the injected sketch ─────────────────────────────────────────
        // The user's setup() / loop() are renamed via #define macros so the
        // compiler sees them as _sim_user_setup() / _sim_user_loop(), and our
        // injected setup() / loop() call them as sub-functions.
        const preamble = [
            '#define setup _sim_user_setup',
            '#define loop  _sim_user_loop',
            '',
        ].join('\n');

        const suffix = [
            '',
            '#undef setup',
            '#undef loop',
            '#include "SimulatorBridge.h"',
            '',
            'void setup() {',
            '    _simBridgeInit_Early();',
            '    _sim_user_setup();',
            '    _simBridgeInit_Late();',
            '    if (!_sim_ready_sent) sim_ready();',
            '}',
            '',
            'void loop() {',
            '    _sim_user_loop();',
            '}',
            '',
        ].join('\n');

        const finalCode = preamble + mainCode + suffix;

        console.log(`\n\n[STM32 COMPILE] Received Code:\n${mainCode}\n[END CODE]\n`);

        fs.writeFileSync(sketchFile, finalCode, 'utf8');

        // Copy shim headers into the sketch directory
        for (const { src, dst } of SHIM_HEADERS) {
            if (fs.existsSync(src)) {
                const destPath = path.join(sketchDir, dst);
                const rawBytes = fs.readFileSync(src);

                // Strip UTF-8 BOM if present
                const startIdx = (rawBytes[0] === 0xEF && rawBytes[1] === 0xBB && rawBytes[2] === 0xBF) ? 3 : 0;

                // Copy only ASCII bytes to prevent gcc "extended character" errors
                const asciiBytes = [];
                for (let i = startIdx; i < rawBytes.length; i++) {
                    if (rawBytes[i] <= 0x7F) asciiBytes.push(rawBytes[i]);
                }

                fs.writeFileSync(destPath, Buffer.from(asciiBytes));
            } else {
                console.warn(`[STM32:Compile:${buildId}] ⚠️  Shim header not found: ${src}`);
            }
        }
    } catch (err) {
        wsManager.unregisterSession(buildId);
        _cleanup(buildId);
        return res.status(500).json({
            error:  'Failed to create STM32 build environment.',
            detail: err.message,
        });
    }

    // ── Respond immediately — compilation continues async ─────────────────────
    res.json({
        success: true,
        buildId,
        message: 'STM32 compilation started. Connect via WebSocket and send REGISTER_SESSION.',
    });

    // ── Async: compile → launch Renode ────────────────────────────────────────
    const CACHE_DIR = path.join(buildDir, 'cache');
    const compileArgs = [
        'compile',
        '--clean',
        '--fqbn',             STM32_FQBN,
        '--build-cache-path', CACHE_DIR,
        '--output-dir',       buildDir,
        '--build-property',   'compiler.cpp.extra_flags=-include SimulatorBridge.h',
        sketchFile,
    ];

    console.log(`[STM32:Compile:${buildId}] 🔨 arduino-cli compile (fqbn=${STM32_FQBN})`);

    execFile(
        ARDUINO_CLI_PATH,
        compileArgs,
        { timeout: COMPILE_TIMEOUT_MS },
        (error, stdout, stderr) => {
            const rawOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
            const output    = _shiftLineNumbers(rawOutput, sketchFile);

            // Find the .elf artifact (not .bin — Renode loads .elf directly)
            const outFiles = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
            const elfFile  = outFiles.find(f => f.toLowerCase().endsWith('.elf'));

            if (!elfFile) {
                const reason = error?.killed
                    ? `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`
                    : 'No .elf binary was produced. Check that the STM32 board core is installed:\n  arduino-cli core install STM32:stm32';

                console.error(`[STM32:Compile:${buildId}] ❌ Compile failed — ${reason}\n\nOutput:\n${output}\n`);
                _sendErrorAndCleanup(buildId, output || reason);
                return;
            }

            const elfPath = path.join(buildDir, elfFile);
            console.log(`[STM32:Compile:${buildId}] ✅ Compiled → ${elfPath}`);

            // ── Notify client that compilation succeeded ───────────────────────
            wsManager.sendToSession(buildId, { type: 'COMPILE_SUCCESS', buildId });

            // ── Launch Renode ─────────────────────────────────────────────────
            const runner = new RenodeRunner(buildId, elfPath, buildDir, wsManager);
            _activeRunners.set(buildId, runner);
            runner.start();

            console.log(`[STM32:Compile:${buildId}] 🚀 Renode runner started`);
        },
    );
};

/**
 * POST /api/compile/stm32/stop/:buildId
 */
export const stopSession = (req, res) => {
    const { buildId } = req.params;

    if (!buildId || typeof buildId !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid buildId parameter.' });
    }

    const runner = _activeRunners.get(buildId);
    if (!runner) {
        return res.status(404).json({ error: 'STM32 session not found or already stopped.' });
    }

    runner.kill();
    _cleanup(buildId);
    wsManager.unregisterSession(buildId);

    console.log(`[STM32:Compile:${buildId}] 🛑 Session stopped by client`);
    return res.json({ success: true, buildId });
};
