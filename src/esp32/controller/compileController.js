/**
 * compileController.js  —  src/esp32/controller/compileController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express route handlers for the ESP32 QEMU simulation pipeline:
 *
 *   POST /api/compile          (target=esp32)  → compileArduinoCode
 *   DELETE /api/compile/esp32/:buildId         → stopSession
 *   POST /api/compile/esp32/direct-boot        → directBoot  (debug/dev)
 *
 * Compile pipeline:
 *   1. Validate request & check session capacity.
 *   2. Verify esptool.py is callable.
 *   3. Create an isolated build directory, write the .ino file with the
 *      SimulatorBridge.h header injected at the top.
 *   4. Copy all simulator shim headers into the sketch directory.
 *   5. Respond immediately with { success, buildId } — compilation runs async.
 *   6. arduino-cli compiles the sketch to ELF + bin artifacts.
 *   7. esptool.py merges bootloader + partition-table + app into a flat image.
 *   8. QemuRunner starts QEMU with that image.
 *   9. All build events (success/error/serial/GPIO) flow via WebSocketManager.
 *
 * Session GC:
 *   A setInterval scans active runners every minute and kills any session that
 *   has been inactive for SESSION_TIMEOUT_MS (default 5 min). This prevents
 *   zombie QEMU processes when browsers close without sending a stop request.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import wsManager  from '../utils/websocketManager.js';
import QemuRunner from '../utils/qemuRunner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Path constants ────────────────────────────────────────────────────────────

const ARDUINO_CLI_PATH = process.env.ARDUINO_CLI_PATH || 'arduino-cli';
const ESPTOOL_PATH     = process.env.ESPTOOL_PATH     || 'esptool.py';

const TEMP_DIR    = path.resolve(__dirname, '../../../temp');
const BUILDS_DIR  = path.resolve(__dirname, '../../../builds');

// Simulator shim headers injected into every sketch build directory
const SHIM_HEADERS = Object.freeze([
    { src: path.resolve(__dirname, '../utils/SimulatorBridge.h'),            dst: 'SimulatorBridge.h'    },
    { src: path.resolve(__dirname, '../utils/SimulatorBridge.cpp'),          dst: 'SimulatorBridge.cpp'  },
    { src: path.resolve(__dirname, '../utils/SimulatorWire.h'),              dst: 'Wire.h'               },
    { src: path.resolve(__dirname, '../utils/SimulatorWire.cpp'),            dst: 'Wire.cpp'             },
    { src: path.resolve(__dirname, '../utils/SimulatorSPI.h'),               dst: 'SPI.h'                },
    { src: path.resolve(__dirname, '../utils/SimulatorSPI.cpp'),             dst: 'SPI.cpp'              },
    { src: path.resolve(__dirname, '../utils/SimulatorWiFi.h'),              dst: 'WiFi.h'               },
    { src: path.resolve(__dirname, '../utils/SimulatorWiFiClient.h'),        dst: 'WiFiClient.h'         },
    { src: path.resolve(__dirname, '../utils/SimulatorWiFiClientSecure.h'),  dst: 'WiFiClientSecure.h'   },
    { src: path.resolve(__dirname, '../utils/SimulatorWiFiServer.h'),        dst: 'WiFiServer.h'         },
]);

// ─── Configuration constants (all overridable via env) ────────────────────────

/**
 * Maximum number of concurrent QEMU sessions.
 * Prevents runaway resource exhaustion on the host machine.
 */
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '10', 10);

/**
 * Session inactivity timeout.
 * Any QEMU runner that has not emitted UART output for this many ms is killed.
 */
const SESSION_TIMEOUT_MS = parseInt(
    process.env.SESSION_TIMEOUT_MS || String(300 * 1000), // 5 minutes
    10,
);

/**
 * arduino-cli compile timeout (ms).
 * Prevents a hung compiler from blocking a slot indefinitely.
 */
const COMPILE_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS || '120000', 10);

/**
 * Grace period (ms) before cleaning up a session after a compile error.
 * Gives the client time to open the WebSocket and receive the error payload.
 */
const CLEANUP_GRACE_MS = parseInt(process.env.CLEANUP_GRACE_MS || '8000', 10);

/**
 * FQBN for the ESP32 target board.
 * dio+40m+4M matches the flash parameters we use in the esptool merge step.
 */
const ESP32_FQBN = process.env.ESP32_FQBN || 'esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M';

/**
 * Number of lines in the injected preamble (before user code starts).
 * Used to shift compiler error line numbers back to the user's original lines.
 * Preamble structure:
 *   #define setup _sim_user_setup
 *   #define loop  _sim_user_loop
 *   (blank)
 */
const INJECTED_LINE_COUNT = 3;

// ─── Active QEMU sessions ─────────────────────────────────────────────────────

/** @type {Map<string, QemuRunner>} buildId → runner */
const _activeRunners = new Map();

// ─── Session GC ───────────────────────────────────────────────────────────────

/**
 * Scan active runners every 5 seconds for idle sessions.
 * Unref'd so this timer does not prevent the process from exiting cleanly.
 */
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
            console.log(`[Compile] 🧹  Session ${buildId} timed out (disconnected or idle) — killing QEMU`);
            runner.kill();
            _cleanup(buildId);
        }
    }
}, 5_000);
_gcTimer.unref();

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Remove the active runner entry and delete the build directory on disk.
 * Safe to call if the directory was never created.
 */
function _cleanup(buildId) {
    _activeRunners.delete(buildId);

    const buildFolder = path.join(BUILDS_DIR, buildId);
    try {
        if (fs.existsSync(buildFolder)) {
            fs.rmSync(buildFolder, { recursive: true, force: true });
        }
    } catch (e) {
        console.error(`[Compile] Failed to delete build folder ${buildFolder}:`, e.message);
    }
}

/**
 * Schedule a deferred cleanup after CLEANUP_GRACE_MS.
 * Also unregisters the pending WebSocket session in the same setTimeout tick
 * so buffered error messages have time to reach the client first.
 */
function _deferredCleanup(buildId) {
    setTimeout(() => {
        wsManager.unregisterSession(buildId);
        _cleanup(buildId);
    }, CLEANUP_GRACE_MS);
}

/**
 * Send a typed error to the session's WS client, then schedule cleanup.
 * Centralises the pattern used multiple times in the compile pipeline.
 */
function _sendErrorAndCleanup(buildId, output) {
    wsManager.sendToSession(buildId, {
        type:    'COMPILE_ERROR',
        buildId,
        // Truncate to 8 KiB to avoid oversized WS frames
        output:  (output || 'Unknown compilation error').slice(0, 8192),
    });
    _deferredCleanup(buildId);
}

/**
 * Shift compiler error line numbers by INJECTED_LINE_COUNT so reported lines
 * match the user's original code (before the SimulatorBridge.h injection).
 *
 * Example:
 *   Input:  /builds/abc/abc.ino:5:3: error: ...
 *   Output: /builds/abc/abc.ino:3:3: error: ...
 */
function _shiftLineNumbers(output, sketchFile, isSharedLibraryMode = false) {
    if (!output || isSharedLibraryMode) return output;
    const escaped = sketchFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped}):(\\d+)(:\\d+:.*)`, 'g');
    return output.replace(re, (_, file, lineStr, rest) => {
        const shifted = Math.max(1, parseInt(lineStr, 10) - INJECTED_LINE_COUNT);
        return `${file}:${shifted}${rest}`;
    });
}

/**
 * Verify esptool is callable and return its execution wrapper.
 * Throws a descriptive Error if it cannot be found.
 */
function _requireEsptool() {
    const candidates = [
        { cmd: process.env.ESPTOOL_PATH || 'esptool.py', args: [] },
        { cmd: 'esptool', args: [] },
        { cmd: 'python', args: ['-m', 'esptool'] },
        { cmd: 'python3', args: ['-m', 'esptool'] }
    ];

    for (const runner of candidates) {
        try {
            execFileSync(runner.cmd, [...runner.args, 'version'], { stdio: 'pipe', timeout: 10_000 });
            return runner;
        } catch (e) {
            continue;
        }
    }

    throw new Error(
        `esptool not found.\n` +
        `Install it with:  pip install esptool\n` +
        `Or set the ESPTOOL_PATH environment variable to its absolute path.`
    );
}

/**
 * Merge bootloader + partition table + app binary into one flat flash image.
 * QEMU's -drive option requires a pre-merged image for the ESP32 machine type.
 *
 * Flash layout (standard ESP32 Arduino):
 *   0x1000  — bootloader
 *   0x8000  — partition table
 *   0x10000 — application
 *
 * @param {string} buildDir    - arduino-cli --output-dir
 * @param {string} sketchBase  - sketch name (without extension)
 * @param {object} esptoolRunner - {cmd, args} from _requireEsptool
 * @returns {string} Absolute path to the merged-flash.bin
 */
function _mergeFlashImage(buildDir, sketchBase, esptoolRunner) {
    const bootloader = path.join(buildDir, `${sketchBase}.bootloader.bin`);
    const partTable  = path.join(buildDir, `${sketchBase}.partitions.bin`);
    const appBin     = path.join(buildDir, `${sketchBase}.bin`);
    const mergedOut  = path.join(buildDir, 'merged-flash.bin');

    // Validate all required artifacts exist before calling esptool
    const artifacts = [
        ['bootloader',       bootloader],
        ['partition table',  partTable],
        ['application binary', appBin],
    ];
    for (const [label, p] of artifacts) {
        if (!fs.existsSync(p)) {
            throw new Error(
                `Flash merge failed: ${label} not found at ${p}.\n` +
                `Ensure the ESP32 board core is installed:\n` +
                `  arduino-cli core install esp32:esp32`,
            );
        }
    }

    const args = [
        ...esptoolRunner.args,
        '--chip',          'esp32',
        'merge_bin',
        '--output',        mergedOut,
        '--fill-flash-size', '4MB',
        '--flash_mode',    'dio',
        '--flash_size',    '4MB',
        '--flash_freq',    '40m',
        '0x1000',  bootloader,
        '0x8000',  partTable,
        '0x10000', appBin,
    ];

    execFileSync(esptoolRunner.cmd, args, { stdio: 'pipe', timeout: 30_000 });

    if (!fs.existsSync(mergedOut)) {
        throw new Error('esptool merge_bin succeeded but produced no output file.');
    }

    return mergedOut;
}

// ─── Ensure required directories exist at startup ─────────────────────────────

for (const dir of [TEMP_DIR, BUILDS_DIR, path.join(TEMP_DIR, 'arduino-cache')]) {
    fs.mkdirSync(dir, { recursive: true });
}

// ─── WebSocket message handler (installed once per connection) ────────────────

wsManager.onClientConnection((ws) => {
    ws.on('message', (rawMsg) => {
        let data;
        try { data = JSON.parse(rawMsg.toString()); } catch { return; }

        // ── REGISTER_SESSION ─────────────────────────────────────────────────
        // Client sends this immediately after WS open to claim its session.
        if (data.type === 'REGISTER_SESSION' && data.buildId) {
            const buildId = data.buildId;
            const isLive    = _activeRunners.has(buildId);
            const isPending = wsManager.hasPendingSession(buildId);
            const isActive  = wsManager.hasLiveSession(buildId);

            if (isLive || isPending || isActive) {
                wsManager.registerSession(ws, buildId);
                wsManager.sendToSession(buildId, {
                    type:    'SESSION_REGISTERED',
                    buildId,
                    // Tell the client whether firmware is already running
                    ready: _activeRunners.get(buildId)?.isReady ?? false,
                });
            } else {
                // Unknown buildId — session may have timed out or never existed
                try {
                    ws.send(JSON.stringify({ type: 'SESSION_NOT_FOUND', buildId }));
                } catch { /* ws may have closed between receiving message and sending */ }
            }
        }

        // ── SET_GPIO (virtual button / input pin interaction) ────────────────
        if (data.type === 'SET_GPIO' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                const pin   = parseInt(data.pin, 10);
                const value = Number(data.value);
                if (!isNaN(pin) && pin >= 0 && pin < 40 && !isNaN(value)) {
                    runner.setVirtualPin(pin, value);
                }
            }
        }

        // ── SET_DHT (DHT-22 dynamic temperature/humidity sync) ──────────────
        if (data.type === 'SET_DHT' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                const pin  = parseInt(data.pin, 10);
                const temp = parseInt(data.temp, 10);
                const hum  = parseInt(data.hum, 10);
                if (!isNaN(pin) && pin >= 0 && pin < 40 && !isNaN(temp) && !isNaN(hum)) {
                    if (typeof runner.setVirtualDht === 'function') {
                        runner.setVirtualDht(pin, temp, hum);
                    }
                }
            }
        }

        // ── SET_ADC (analog input potentiometer sync) ────────────────────────
        if (data.type === 'SET_ADC' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                const channel    = parseInt(data.channel, 10);
                const millivolts = parseInt(data.millivolts, 10);
                if (!isNaN(channel) && channel >= 0 && channel < 8 && !isNaN(millivolts)) {
                    if (typeof runner.setVirtualAdc === 'function') {
                        runner.setVirtualAdc(channel, millivolts);
                    }
                }
            }
        }

        // ── SENSOR_ATTACH (attach advanced I2C/SPI/ePaper sensors) ───────────
        if (data.type === 'SENSOR_ATTACH' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                runner.sensorAttach?.(data.sensor_type, data.pin, data.properties || {});
            }
        }

        // ── SENSOR_UPDATE (update sensor parameters) ────────────────────────
        if (data.type === 'SENSOR_UPDATE' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                runner.sensorUpdate?.(data.pin, data.properties || {});
            }
        }

        // ── SENSOR_DETACH (detach sensor) ────────────────────────────────────
        if (data.type === 'SENSOR_DETACH' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                runner.sensorDetach?.(data.pin);
            }
        }

        // ── ADC_SET (inject analog value for a GPIO pin) ─────────────────────
        // Frontend sends this when a potentiometer / LDR component state changes.
        // data: { buildId, pin: number, value: number (0-4095) }
        if (data.type === 'ADC_SET' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner && typeof runner.setAdcValue === 'function') {
                runner.setAdcValue(data.pin, data.value);
            }
        }

        // ── I2C_RESP_SET (pre-load I2C read-response bytes for an address) ───
        // Frontend sends this when an I2C sensor component has data to be read.
        // data: { buildId, addr: number (7-bit), bytes: number[] }
        if (data.type === 'I2C_RESP_SET' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner && typeof runner.setI2cResponse === 'function') {
                runner.setI2cResponse(data.addr, data.bytes || []);
            }
        }

        // ── SPI_RESP_SET (pre-load MISO bytes for SPI transactions) ─────────
        // Frontend sends this for SPI peripherals that need to send data back.
        // data: { buildId, bytes: number[] }
        if (data.type === 'SPI_RESP_SET' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner && !runner._destroyed) {
                // Push bytes via UART RX injection
                if (typeof runner.sendSerialInput === 'function') {
                    const hex = data.bytes.map(b => b.toString(16).padStart(2, '0')).join('');
                    const cmd = Buffer.from(`<SPI_RESP:${hex}>\n`);
                    runner.sendSerialInput(0, Array.from(cmd));
                }
            }
        }


        // ── SERIAL_INPUT (inject UART RX bytes into firmware) ────────────────
        // Sent by the frontend sendSerialBytes() helper in ≤64-byte chunks to
        // prevent QEMU's 128-byte UART RX FIFO from overflowing.
        // Supports UART0 (default) and secondary UARTs 1 / 2.
        if (data.type === 'SERIAL_INPUT' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner) {
                const bytes = data.bytes;
                const uart  = typeof data.uart === 'number' ? data.uart : 0;
                if (Array.isArray(bytes) && bytes.length > 0) {
                    if (typeof runner.sendSerialInput === 'function') {
                        runner.sendSerialInput(uart, bytes);
                    }
                }
            }
        }

        // ── CAMERA_ATTACH (tell worker webcam is connected) ──────────────────
        // Mirrors Velxio simulation.py: esp32_camera_attach → esp_lib_manager.camera_attach()
        if (data.type === 'CAMERA_ATTACH' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner && typeof runner.sendCameraAttach === 'function') {
                runner.sendCameraAttach();
            }
        }

        // ── CAMERA_FRAME (push JPEG to QEMU OV2640 DMA buffer) ───────────────
        // Mirrors Velxio simulation.py: esp32_camera_frame → esp_lib_manager.camera_frame()
        // Only accepted in shared-library mode — velxio_push_camera_frame() only
        // exists in a libqemu-xtensa rebuilt with the OV2640+I²S patch.
        if (data.type === 'CAMERA_FRAME' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner && data.b64 && typeof runner.sendCameraFrame === 'function') {
                runner.sendCameraFrame(
                    String(data.b64),
                    String(data.fmt || 'jpeg'),
                    Number(data.w  || 320),
                    Number(data.h  || 240),
                );
            }
        }

        // ── CAMERA_DETACH (drop frame, reset DMA pointer) ─────────────────────
        // Mirrors Velxio simulation.py: esp32_camera_detach → esp_lib_manager.camera_detach()
        if (data.type === 'CAMERA_DETACH' && data.buildId) {
            const runner = _activeRunners.get(data.buildId);
            if (runner && typeof runner.sendCameraDetach === 'function') {
                runner.sendCameraDetach();
            }
        }
    });


    // Client disconnects — session stays alive for the reconnect window;
    // the session GC handles eventual cleanup if the client never returns.
    ws.on('close', () => {
        console.log('[Compile] 📡 Client disconnected — QEMU session preserved for reconnect window');
    });
});

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/compile  { code: string, target: 'esp32' }
 *
 * Responds immediately with { success, buildId } then compiles asynchronously.
 * All build progress is delivered via WebSocket.
 */
export const compileArduinoCode = (req, res) => {
    const { code, target } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: 'Request body must include a non-empty "code" string.' });
    }

    if (target !== 'esp32') {
        return res.status(400).json({ error: 'This handler only supports target="esp32".' });
    }

    // ── Capacity check ────────────────────────────────────────────────────────
    if (_activeRunners.size >= MAX_SESSIONS) {
        return res.status(503).json({
            error: `Server at capacity (${_activeRunners.size}/${MAX_SESSIONS} active sessions). ` +
                   `Please try again in a moment.`,
        });
    }

    // ── esptool check (fail fast before touching disk) ────────────────────────
    let esptoolRunner;
    try {
        esptoolRunner = _requireEsptool();
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    // ── Build environment setup ───────────────────────────────────────────────
    const buildId   = crypto.randomUUID();
    const sketchDir = path.join(BUILDS_DIR, buildId);
    const buildDir  = path.join(sketchDir, 'build');
    const pipesDir  = path.join(os.tmpdir(), `openhw-${buildId}`);

    // Sketch name MUST match the directory name (Arduino IDE rule)
    const sketchName = buildId;
    const sketchFile = path.join(sketchDir, `${sketchName}.ino`);

    // Open the pending buffer BEFORE any async I/O so no QEMU output is lost
    wsManager.createPendingSession(buildId);

    const libName = os.platform() === 'win32' ? 'libqemu-xtensa.dll' : 'libqemu-xtensa.so';
    const libPath = process.env.QEMU_ESP32_LIB || path.resolve(__dirname, '../utils', libName);
    let isSharedLibraryMode = false;

    try {
        fs.mkdirSync(sketchDir, { recursive: true });
        fs.mkdirSync(buildDir,  { recursive: true });

        // ── Build the injected sketch ─────────────────────────────────────────
        //
        // The wrapper pattern solves the Guru Meditation Cache Error:
        //   __attribute__((constructor)) runs before the flash cache is ready,
        //   so calling Serial.begin() / xTaskCreatePinnedToCore() there causes
        //   a hard crash.  Instead, we inject a real setup() that calls
        //   _simBridgeInit() AFTER the Arduino hardware layer is fully online.
        //
        // The user's setup() / loop() are renamed via #define macros so the
        // compiler sees them as _sim_user_setup() / _sim_user_loop(), and our
        // injected setup() / loop() call them as sub-functions.
        //
        // Result for the blink sketch:
        //   void setup() {                 ← injected — runs first
        //       _simBridgeInit_Early();    ← mutex + logs off
        //       _sim_user_setup();         ← user's pinMode, Serial.begin
        //       _simBridgeInit_Late();     ← banner, tasks spawned here (safe!)
        //       if (!_sim_ready_sent) sim_ready();  ← auto-handshake
        //   }
        //   void loop() { _sim_user_loop(); }  ← user's blink logic

        const codeInput = req.body.code || '';
        console.log('\n\n[ESP32 COMPILE] Received Code:\n', codeInput, '\n[END CODE]\n');
        
        isSharedLibraryMode = fs.existsSync(libPath);

        let finalCode;
        if (isSharedLibraryMode) {
            finalCode = codeInput;
            console.log(`[Compile:${buildId}] ⚡ Shared-Library Pure Emulation Mode enabled. Skipping shim headers.`);
        } else {
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

            finalCode = preamble + codeInput + suffix;
        }

        fs.writeFileSync(sketchFile, finalCode, 'utf8');

        if (!isSharedLibraryMode) {
            // Copy all shim headers into the sketch directory so arduino-cli finds them.
            // Also strip any non-ASCII bytes that text editors may inject (Unicode box-drawing
            // chars in comments cause "extended character is not valid" gcc errors).
            for (const { src, dst } of SHIM_HEADERS) {
                if (fs.existsSync(src)) {
                    const destPath = path.join(sketchDir, dst);
                    const rawBytes = fs.readFileSync(src);   // read as Buffer (bytes)

                    // 1. Strip UTF-8 BOM (EF BB BF) if present
                    const startIdx = (rawBytes[0] === 0xEF && rawBytes[1] === 0xBB && rawBytes[2] === 0xBF) ? 3 : 0;

                    // 2. Copy only ASCII bytes (0x00-0x7F), skip any byte > 0x7F
                    const asciiBytes = [];
                    for (let i = startIdx; i < rawBytes.length; i++) {
                        if (rawBytes[i] <= 0x7F) asciiBytes.push(rawBytes[i]);
                    }

                    // 3. Safety: if the source file started with '/*' but stripping removed
                    //    the leading '/' (a multi-byte UTF-8 sequence spanning byte 0 is
                    //    extremely unlikely but has been observed), re-prepend it.
                    const origStart = rawBytes.slice(startIdx, startIdx + 3).toString('latin1');
                    if (origStart.startsWith('/**') || origStart.startsWith('/*')) {
                        if (asciiBytes[0] !== 0x2F) { // '/'
                            asciiBytes.unshift(0x2F);
                        }
                    }

                    fs.writeFileSync(destPath, Buffer.from(asciiBytes));
                } else {
                    console.warn(`[Compile:${buildId}] ⚠️  Shim header not found: ${src}`);
                }
            }
        }
    } catch (err) {
        wsManager.unregisterSession(buildId);
        _cleanup(buildId);
        return res.status(500).json({
            error:  'Failed to create build environment.',
            detail: err.message,
        });
    }

    // ── Respond immediately — compilation continues async ─────────────────────
    res.json({
        success: true,
        buildId,
        message: 'Compilation started. Connect via WebSocket and send REGISTER_SESSION.',
    });

    // ── Async: compile → merge → launch QEMU ─────────────────────────────────
    const CACHE_DIR = path.join(buildDir, 'cache');
    const compileArgs = [
        'compile',
        '--clean',
        '--fqbn',             ESP32_FQBN,
        '--build-cache-path', CACHE_DIR,
        '--output-dir',       buildDir,
        '--build-property',   'compiler.cpp.extra_flags=-include SimulatorBridge.h',
        sketchFile,
    ];

    console.log(`[Compile:${buildId}] 🔨 arduino-cli compile (fqbn=${ESP32_FQBN})`);

    execFile(
        ARDUINO_CLI_PATH,
        compileArgs,
        { timeout: COMPILE_TIMEOUT_MS },
        (error, stdout, stderr) => {
            const rawOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
            const output    = _shiftLineNumbers(rawOutput, sketchFile, isSharedLibraryMode);

            // arduino-cli may exit with an error code but still produce usable
            // artifacts (e.g. warnings-as-errors disabled). We use artifact
            // existence as the true success indicator.
            const appBin = path.join(buildDir, `${sketchName}.ino.bin`);

            if (!fs.existsSync(appBin)) {
                const reason = error?.killed
                    ? `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`
                    : 'No application binary was produced. Check that the ESP32 board core is installed:\n  arduino-cli core install esp32:esp32';

                console.error(`[Compile:${buildId}] ❌ Compile failed — ${reason}\n\nCompiler Output:\n${output}\n`);
                _sendErrorAndCleanup(buildId, output || reason);
                return;
            }

            // ── Flash merge ───────────────────────────────────────────────────
            let mergedFlash;
            try {
                mergedFlash = _mergeFlashImage(buildDir, `${sketchName}.ino`, esptoolRunner);
                console.log(`[Compile:${buildId}] 🔨 Flash image merged → ${mergedFlash}`);
            } catch (mergeErr) {
                console.error(`[Compile:${buildId}] ❌ Flash merge failed:`, mergeErr.message);
                _sendErrorAndCleanup(buildId, `Flash image merge failed:\n${mergeErr.message}`);
                return;
            }

            // ── Notify client that compilation succeeded ───────────────────────
            wsManager.sendToSession(buildId, { type: 'COMPILE_SUCCESS', buildId });

            // ── Launch QEMU ───────────────────────────────────────────────────
            const runner = new QemuRunner(buildId, mergedFlash, pipesDir, sketchDir);
            _activeRunners.set(buildId, runner);
            runner.start();

            console.log(`[Compile:${buildId}] 🚀 QEMU runner started`);
        },
    );
};

/**
 * DELETE /api/compile/esp32/:buildId
 *
 * Stop a running QEMU session by buildId.
 */
export const stopSession = (req, res) => {
    const { buildId } = req.params;

    if (!buildId || typeof buildId !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid buildId parameter.' });
    }

    const runner = _activeRunners.get(buildId);
    if (!runner) {
        return res.status(404).json({ error: 'Session not found or already stopped.' });
    }

    runner.kill();
    _cleanup(buildId);
    wsManager.unregisterSession(buildId);

    console.log(`[Compile:${buildId}] 🛑 Session stopped by client`);
    return res.json({ success: true, buildId });
};

/**
 * POST /api/compile/esp32/direct-boot
 *
 * Boot QEMU directly from a pre-compiled binary without going through
 * arduino-cli. Intended for development and hardware testing workflows.
 *
 * Requires ESP32_DIRECT_BOOT_BIN env var to point to a merged-flash.bin.
 */
export const directBoot = (req, res) => {
    const mergedFlash = process.env.ESP32_DIRECT_BOOT_BIN || '';

    if (!mergedFlash) {
        return res.status(400).json({
            error: 'ESP32_DIRECT_BOOT_BIN is not set. ' +
                   'Point it to a pre-compiled merged-flash.bin in your .env file.',
        });
    }

    if (!fs.existsSync(mergedFlash)) {
        return res.status(400).json({
            error: `Binary not found at: ${mergedFlash}`,
        });
    }

    if (_activeRunners.size >= MAX_SESSIONS) {
        return res.status(503).json({
            error: `Server at capacity (${_activeRunners.size}/${MAX_SESSIONS} active sessions).`,
        });
    }

    const buildId  = crypto.randomUUID();
    const pipesDir = path.join(os.tmpdir(), `openhw-${buildId}`);

    fs.mkdirSync(pipesDir, { recursive: true });

    wsManager.createPendingSession(buildId);

    // Respond before starting QEMU so client can open WS and send REGISTER_SESSION
    res.json({
        success: true,
        buildId,
        message: 'Starting direct boot from pre-compiled binary.',
    });

    // Brief delay to let the client open the WebSocket and register
    setTimeout(() => {
        wsManager.sendToSession(buildId, { type: 'COMPILE_SUCCESS', buildId });

        const runner = new QemuRunner(buildId, mergedFlash, pipesDir);
        _activeRunners.set(buildId, runner);
        runner.start();

        console.log(`[Compile:${buildId}] 🚀 QEMU started via Direct Boot from ${mergedFlash}`);
    }, 1500);
};

/**
 * POST /api/compile/esp32/run-binary
 *
 * Boot QEMU directly from a dynamic base64-encoded firmware binary.
 * Useful for running MicroPython or other pre-compiled binary payloads.
 */
export const runBinary = (req, res) => {
    const { firmware_b64, target } = req.body;

    if (!firmware_b64 || typeof firmware_b64 !== 'string') {
        return res.status(400).json({ error: 'Request body must include a non-empty "firmware_b64" string.' });
    }

    if (target !== 'esp32') {
        return res.status(400).json({ error: 'This handler only supports target="esp32".' });
    }

    if (_activeRunners.size >= MAX_SESSIONS) {
        return res.status(503).json({
            error: `Server at capacity (${_activeRunners.size}/${MAX_SESSIONS} active sessions).`,
        });
    }

    const buildId   = crypto.randomUUID();
    const sketchDir = path.join(BUILDS_DIR, buildId);
    const pipesDir  = path.join(os.tmpdir(), `openhw-${buildId}`);
    const mergedFlash = path.join(sketchDir, 'merged-flash.bin');

    wsManager.createPendingSession(buildId);

    try {
        fs.mkdirSync(sketchDir, { recursive: true });
        const buffer = Buffer.from(firmware_b64, 'base64');
        fs.writeFileSync(mergedFlash, buffer);
    } catch (err) {
        wsManager.unregisterSession(buildId);
        _cleanup(buildId);
        return res.status(500).json({
            error: 'Failed to write binary firmware.',
            detail: err.message,
        });
    }

    // Respond immediately so client can open WS and send REGISTER_SESSION
    res.json({
        success: true,
        buildId,
        message: 'Binary loaded successfully. Connect via WebSocket and send REGISTER_SESSION.',
    });

    // Brief delay to let the client open the WebSocket and register
    setTimeout(() => {
        wsManager.sendToSession(buildId, { type: 'COMPILE_SUCCESS', buildId });

        const runner = new QemuRunner(buildId, mergedFlash, pipesDir, sketchDir);
        _activeRunners.set(buildId, runner);
        runner.start();

        console.log(`[Compile:${buildId}] 🚀 QEMU started via runBinary`);
    }, 1000);
};
