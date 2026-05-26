/**
 * qemuRunner.js  —  src/esp32/utils/qemuRunner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the lifecycle of a single QEMU ESP32 process for one browser session.
 *
 * Responsibilities:
 *   • Create named FIFOs for UART0 full-duplex communication
 *   • Spawn qemu-system-xtensa with correct flash image and NIC args
 *   • Parse the UART byte-stream: intercept GPIO_SYNC frames, forward the
 *     rest to the client's Serial Monitor via WebSocketManager
 *   • Inject GPIO input commands via the uart.in write pipe
 *   • Tear down cleanly on stop() or unexpected QEMU exit
 *
 * Named-pipe I/O model (cross-platform):
 *   uart.out  — QEMU serial TX  → Node.js reads (O_RDONLY | O_NONBLOCK)
 *   uart.in   — Node.js writes  → QEMU serial RX (O_WRONLY | O_NONBLOCK)
 *
 * Polling vs. streams:
 *   We deliberately poll uart.out with setInterval rather than using a
 *   stream/pipe because the Node.js fs.ReadStream + FIFO combination can
 *   deadlock on macOS when the write end has not yet been opened.
 *   setInterval at 10 ms gives ≤10 ms latency with zero risk of blocking
 *   the event loop.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import wsManager from './websocketManager.js';
import NetworkProxy from './networkProxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * ROM boot signature strings — produced by the ESP32 bootloader before user
 * firmware runs.  Used to detect that QEMU has started successfully.
 * NOTE: these lines come from ROM and CANNOT be suppressed.
 */
const BOOT_SIGNATURES = Object.freeze([
    'ets J',
    'cpu_reset',
    'app_main',
    'Arduino setup',
    'rst:0x1',
    'ESP-ROM',
    'Build:',
]);

/**
 * ROM / IDF lines that are normal but noisy — filtered OUT of the user's
 * Serial Monitor to keep it clean.  They are not errors.
 */
const ROM_NOISE_PATTERNS = Object.freeze([
    // ESP32 ROM / bootloader lines (cannot be suppressed in QEMU)
    /^ets J/,      /^rst:0x/,     /^configsip:/,
    /^clk_drv:/,   /^mode:DIO/,   /^mode:QIO/,
    /^load:/,      /^entry /,     /^ESP-ROM:/,
    /^Build:/,     /^Chip is /,   /^Features:/,
    /^Crystal is /, /^MAC:/,
    // QEMU Wokwi machine identifier — wokwi_esp32_1 etc.
    /wokwi_esp32/i, /^wokwi/i,
    // ESP-IDF structured log lines  I/W/E (timestamp) tag: msg
    /^I \(\d+\) /, /^W \(\d+\) /, /^E \(\d+\) /,
    // IDF subsystem spam
    /^heap_init:/, /^spi_flash:/,
    // Blank lines
    /^\s*$/,
]);

/**
 * SimulatorBridge.h GPIO frame.
 * Format: >GPIO:<pin>:<val><
 */
const GPIO_PATTERN = />GPIO:(\d+):([01])</;

/**
 * SimulatorBridge.h I2C frame.
 * Format: >I2C:<addr_hex>:<data_hex><
 * e.g.  >I2C:3c:000001< 
 */
const I2C_PATTERN     = />I2C:([0-9a-fA-F]+):([0-9a-fA-F]*)</;
const I2C_READ_PATTERN = />I2C_READ:([0-9a-fA-F]+):([0-9a-fA-F]+)</;
const SPI_PATTERN      = />SPI:([0-9a-fA-F]{2})</;
const SPIBUF_PATTERN   = />SPIBUF:([0-9a-fA-F]+)</

/**
 * SimulatorBridge.h simulation control frames.
 * Format: >SIM:<cmd>[:<args>]<
 *   READY  — firmware setup() complete; device is fully initialised
 *   BEAT   — periodic heartbeat liveness ping
 *   LOG    — structured log line: >SIM:LOG:<level>:<msg><
 */
const SIM_FRAME_PATTERN = />SIM:([A-Z]+)(?::([^<]*))?</;

/**
 * Log patterns for detecting firmware crash / core panic.
 */
const CRASH_PATTERNS = Object.freeze([
    /Guru Meditation Error/i,
    /Core panic'ed/i,
    /Cache error/i,
    /instruction fetch/i,
    /illegal instruction/i,
    /double exception/i,
    /Unhandled debug exception/i,
]);

/**
 * How long (ms) to wait for the first heartbeat after READY before
 * treating the session as stalled.  Should be at least 2× SIM_HEARTBEAT_MS.
 */
const HEARTBEAT_TIMEOUT_MS = parseInt(
    process.env.SIM_HEARTBEAT_TIMEOUT_MS || '15000', 10
);

/** Maximum UART output buffer size before we forcibly flush (safety valve). */
const MAX_UART_BUFFER_BYTES = 16 * 1024; // 16 KiB

/** How often to poll uart.out (milliseconds). */
const POLL_INTERVAL_MS = 10;

/** How many 100 ms retries to wait for QEMU to open the FIFO write-end. */
const OPEN_PIPE_MAX_ATTEMPTS = 50; // 5 seconds total

/** Read chunk size per poll cycle. */
const READ_BUF_SIZE = 4096;

// ─── Logger helper ─────────────────────────────────────────────────────────────

/**
 * Prefixes every log line with the buildId so multi-session logs are easy to
 * grep. Pass the buildId once at construction; call log/warn/error as needed.
 */
class SessionLogger {
    constructor(buildId) {
        this._prefix = `[QEMU:${buildId.substring(0, 8)}]`;
    }
    info  (...args) { console.log  (this._prefix, ...args); }
    warn  (...args) { console.warn (this._prefix, ...args); }
    error (...args) { console.error(this._prefix, ...args); }
}

// ─── QemuRunner ────────────────────────────────────────────────────────────────

export default class QemuRunner {
    /**
     * @param {string} buildId    - UUID for this browser session.
     * @param {string} flashImage - Absolute path to merged-flash.bin.
     * @param {string} pipesDir   - Directory for uart.in / uart.out FIFOs.
     * @param {string} sketchDir  - Optional sketch compilation directory for GC.
     */
    constructor(buildId, flashImage, pipesDir, sketchDir = null) {
        this.buildId    = buildId;
        this.flashImage = flashImage;
        this.pipesDir   = pipesDir;
        this.sketchDir  = sketchDir;

        // Runtime state
        this._process          = null;   // child_process handle
        this._uartServer       = null;   // net.Server for UART0
        this._uartSocket       = null;   // net.Socket for UART0
        this._uartPort         = null;   // TCP port for UART0
        this._outBuffer        = '';     // incomplete line accumulator
        this._proxy            = null;   // NetworkProxy instance
        this._log              = new SessionLogger(buildId);
        this._destroyed        = false;  // set to true after kill() to prevent double-cleanup
        this._bootDetected     = false;  // true once ROM boot signatures seen
        this._heartbeatTimer   = null;   // setTimeout handle for heartbeat watchdog

        // Emulation dynamic supervisor & sandboxing state
        this._restartCount     = 0;
        this._maxRestarts      = 3;
        this._qemuPath         = null;
        this._nicArgs          = null;
        this._proxyPort        = null;
        this._lastGpioValues   = new Uint8Array(40).fill(0xFF);

        // ── Performance diagnostic counters (logged every 1s) ─────────────────
        this._perf = {
            wsSent:     0,   // WS messages sent this window
            gpioRaw:    0,   // gpio_change events from worker (pre-dedup)
            gpioSent:   0,   // GPIO_SYNC forwarded to WS     (post-dedup)
            workerEvts: 0,   // total _handleWorkerEvent calls
            logTimer:   null,
        };

        /**
         * Lifecycle phase — reported to the frontend via WS messages.
         *
         *  'compiling'  — arduino-cli running           (set by compileController)
         *  'booting'    — QEMU running, ROM boot seen   (set here on first BOOT_SIG)
         *  'running'    — firmware sent >SIM:READY<     (set on SIM:READY frame)
         *  'stopped'    — session ended                 (set on kill/exit)
         */
        this.phase        = 'compiling';

        // Kept for backward compat — true once 'running'
        this.isReady      = false;
        this.lastActivity = Date.now();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * start() — Create FIFOs, boot NetworkProxy, then spawn QEMU.
     * Returns immediately; QEMU events are delivered via WebSocketManager.
     */
    _getSharedLibraryPath() {
        const libName = os.platform() === 'win32' ? 'libqemu-xtensa.dll' : 'libqemu-xtensa.so';
        const envPath = process.env.QEMU_ESP32_LIB;
        if (envPath && fs.existsSync(envPath)) return envPath;
        
        const localPath = path.resolve(__dirname, libName);
        if (fs.existsSync(localPath)) return localPath;
        
        return null;
    }

    _writeWorkerCmd(cmd) {
        if (this._process && this._process.stdin && this._process.stdin.writable) {
            try {
                this._process.stdin.write(JSON.stringify(cmd) + '\n');
            } catch (err) {
                this._log.warn('Failed to write command to worker:', err.message);
            }
        }
    }

    _startSharedLibraryWorker(libPath) {
        this.phase = 'booting';
        this._sendWs({ type: 'QEMU_BOOTING' });

        const pythonCmd = os.platform() === 'win32' ? 'python' : 'python3';
        const workerScript = path.resolve(__dirname, 'esp32_worker.py');

        this._log.info(`🚀 Spawning Shared-Library worker: ${pythonCmd} -u ${workerScript}`);

        this._process = spawn(pythonCmd, ['-u', workerScript], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        if (this._process && this._process.pid) {
            try {
                os.setPriority(this._process.pid, 10);
            } catch (e) {
                this._log.warn('Failed to set worker process priority:', e.message);
            }
        }

        try {
            const firmwareB64 = fs.readFileSync(this.flashImage).toString('base64');
            const config = {
                lib_path: libPath,
                firmware_b64: firmwareB64,
                machine: 'esp32-picsimlab',
                sensors: [],
                wifi_enabled: process.env.WIFI_MODE === 'slirp' || process.env.WIFI_MODE === 'tap',
                wifi_hostfwd_port: 0
            };
            this._process.stdin.write(JSON.stringify(config) + '\n');
        } catch (err) {
            this._log.error('Failed to write worker config:', err.message);
            this._sendWs({ type: 'QEMU_ERROR', message: `Worker config error: ${err.message}` });
            this.kill();
            return;
        }

        let outBuf = '';
        this._process.stdout.on('data', (data) => {
            outBuf += data.toString();
            const lines = outBuf.split('\n');
            outBuf = lines.pop();
            for (const line of lines) {
                const cleanLine = line.trim();
                if (cleanLine) {
                    try {
                        const event = JSON.parse(cleanLine);
                        this._handleWorkerEvent(event);
                    } catch (e) {
                        this._log.warn('Worker output not JSON:', cleanLine);
                    }
                }
            }
        });

        this._process.stderr.on('data', (data) => {
            const text = data.toString().trim();
            if (text) {
                this._log.info(`[Worker Log] ${text}`);
            }
        });

        this._process.on('close', (code, signal) => {
            this._log.info(`🛑 Worker exited (code=${code}, signal=${signal}, destroyed=${this._destroyed})`);
            if (!this._destroyed) {
                this._handleCrash(`Worker exited unexpectedly (code=${code ?? 'unknown'}, signal=${signal ?? 'none'})`);
            } else {
                this.phase = 'stopped';
                this._sendWs({ type: 'QEMU_EXIT', code: code ?? -1 });
                wsManager.unregisterSession(this.buildId);
                this._process = null;
            }
        });

        this._process.on('error', (err) => {
            this._log.error('🔴 Failed to spawn worker:', err.message);
            this.phase = 'stopped';
            this._sendWs({
                type:    'QEMU_ERROR',
                message: `Failed to start shared-library worker: ${err.message}.`,
            });
            if (!this._destroyed) this.kill();
        });
    }

    _handleWorkerEvent(event) {
        this._perf.workerEvts++;
        const etype = event.type;
        if (etype === 'system') {
            const ev = event.event;
            if (ev === 'booted') {
                this.phase = 'running';
                this.isReady = true;
                this._sendWs({ type: 'FIRMWARE_READY' });
                this._sendWs({ type: 'QEMU_READY' });
            } else if (ev === 'crash') {
                this._handleCrash(`Worker reported system crash: ${event.reason || 'unknown'}`);
            } else if (ev === 'reboot') {
                this._log.info(`🔄 Guest OS rebooted (count=${event.count})`);
                this._sendWs({ type: 'SERIAL_LOG', level: 'INFO', message: `ESP32 rebooted (count=${event.count})` });
            }
        } else if (etype === 'gpio_change') {
            const pin = event.pin;
            const value = event.state;
            this._perf.gpioRaw++;
            // Deduplicate — only forward if pin state actually changed.
            // The UART path already had this via _lastGpioValues; the worker
            // path was missing it, causing GPIO_SYNC flooding during boot.
            if (pin >= 0 && pin < this._lastGpioValues.length) {
                if (this._lastGpioValues[pin] !== value) {
                    this._lastGpioValues[pin] = value;
                    this._perf.gpioSent++;
                    this._sendWs({ type: 'GPIO_SYNC', pin, value });
                }
                // else: same value — suppress silently
            } else {
                this._perf.gpioSent++;
                this._sendWs({ type: 'GPIO_SYNC', pin, value });
            }
        } else if (etype === 'uart_tx') {
            const uart = event.uart;
            const byte = event.byte;
            if (!this._uartBuffers[uart]) {
                this._uartBuffers[uart] = [];
            }
            this._uartBuffers[uart].push(byte);

            if (byte === 10 || byte === 13 || byte === 46 || this._uartBuffers[uart].length >= 256) {
                const text = Buffer.from(this._uartBuffers[uart]).toString('utf8');
                this._uartBuffers[uart] = [];
                if (uart === 0) {
                    // Raw serial output forwarding is disabled to prevent UI lag
                    // this._sendWs({ type: 'SERIAL_OUTPUT', text });
                } else {
                    this._sendWs({ type: 'UART_OUTPUT', uart, text });
                }
            }
        } else if (etype === 'gpio_dir') {
            this._sendWs({ type: 'GPIO_DIR', pin: event.pin, dir: event.dir });
        } else if (etype === 'ledc_duty') {
            this._sendWs({ type: 'PWM_SYNC', channel: event.channel, duty_pct: event.duty_pct });
        } else if (etype === 'ws2812_update') {
            this._sendWs({ type: 'WS2812_UPDATE', channel: event.channel, pixels: event.pixels });
        } else if (etype === 'gpio_routing') {
            this._sendWs({ type: 'GPIO_ROUTING', gpio: event.gpio, signal_id: event.signal_id });
        } else if (etype === 'gpio_routing_clear') {
            this._sendWs({ type: 'GPIO_ROUTING_CLEAR', gpio: event.gpio });
        } else if (etype === 'i2c_event') {
            this._sendWs({ type: 'protocol:i2c', bus: event.bus, addr: event.addr, event: event.event, response: event.response });
        } else if (etype === 'i2c_transaction') {
            this._sendWs({ type: 'I2C_TRANSACTION', addr: event.addr, data: event.data });
        } else if (etype === 'proxy_i2c_complete') {
            this._sendWs({ type: 'PROXY_I2C_COMPLETE', addr: event.addr, data: event.data });
        } else if (etype === 'spi_event') {
            this._sendWs({ type: 'protocol:spi', bus: event.bus, event: event.event, response: event.response });
        } else if (etype === 'spi_batch') {
            this._sendWs({ type: 'SPI_BATCH', b64: event.b64 });
        } else if (etype === 'epaper_update') {
            this._sendWs({
                type: 'EPAPER_UPDATE',
                data: {
                    component_id: event.component_id,
                    width: event.width,
                    height: event.height,
                    frame_b64: event.frame_b64,
                    refresh_ms: event.refresh_ms || 50
                }
            });
        } else if (etype === 'error') {
            this._log.error('Worker error event:', event.message);
            this._sendWs({ type: 'QEMU_ERROR', message: event.message });
        }
    }

    start() {
        if (this._destroyed) {
            this._log.warn('start() called on a destroyed runner — ignoring.');
            return;
        }

        // ── Start 1-second perf diagnostic logger ────────────────────────────
        this._perf.logTimer = setInterval(() => {
            const { wsSent, gpioRaw, gpioSent, workerEvts } = this._perf;
            this._log.info(
                `[PERF] phase=${this.phase} | WS-sent/s=${wsSent}` +
                ` | worker-events/s=${workerEvts}` +
                ` | GPIO-raw/s=${gpioRaw} GPIO-forwarded/s=${gpioSent}` +
                ` (suppressed=${gpioRaw - gpioSent})`
            );
            this._perf.wsSent     = 0;
            this._perf.gpioRaw    = 0;
            this._perf.gpioSent   = 0;
            this._perf.workerEvts = 0;
        }, 1000);

        const libPath = this._getSharedLibraryPath();
        if (libPath) {
            this._isSharedLibraryMode = true;
            this._startSharedLibraryWorker(libPath);
            return;
        }

        this._isSharedLibraryMode = false;
        this._qemuPath = process.env.QEMU_ESP32_PATH || path.resolve(__dirname, '../../../../external/qemu/qemu/bin/qemu-system-xtensa');
        this._nicArgs  = this._buildNicArgs();

        // Start the network proxy first
        this._proxy = new NetworkProxy(this.buildId, (proxyPort) => {
            this._proxyPort = proxyPort;
            
            // Start TCP Server for UART0
            this._uartServer = net.createServer((socket) => {
                this._log.info('📡 QEMU connected to UART0 TCP bridge');
                this._uartSocket = socket;
                
                socket.setEncoding('utf8');
                socket.on('data', (chunk) => {
                    this.lastActivity = Date.now();
                    this._handleSerialData(chunk);
                });
                
                socket.on('error', (err) => {
                    this._log.warn('UART0 socket error:', err.message);
                });
                
                socket.on('close', () => {
                    this._uartSocket = null;
                });
            });
            
            this._uartServer.on('error', (err) => {
                this._log.error('❌ Failed to create UART0 TCP server:', err.message);
                this._sendWs({ type: 'QEMU_ERROR', message: `Failed to create serial bridge: ${err.message}` });
            });
            
            this._uartServer.listen(0, '127.0.0.1', () => {
                this._uartPort = this._uartServer.address().port;
                this._log.info(`🔌 UART0 TCP server listening on port ${this._uartPort}`);
                this._spawnQemu(this._qemuPath, this._nicArgs, proxyPort, this._uartPort);
            });
        });
        this._proxy.start();
    }

    /**
     * setVirtualPin() — Write a GPIO input command into uart.in.
     * SimulatorBridge.h polls Serial.available() and reacts within 5 ms.
     *
     * @param {number} pin   - GPIO pin number (0–39).
     * @param {0|1}    value - Pin level.
     */
    setVirtualPin(pin, value) {
        if (this._destroyed) return;

        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({ cmd: 'set_pin', pin, value: value ? 1 : 0 });
            return;
        }

        if (!this._uartSocket) return;

        const cmd = `<GPIO:${pin}:${value ? 1 : 0}>\n`;
        try {
            this._uartSocket.write(cmd);
        } catch (e) {
            this._log.warn('setVirtualPin write error:', e.message);
        }
    }

    setVirtualDht(pin, temp, hum) {
        if (this._destroyed) return;

        if (this._isSharedLibraryMode) {
            if (!this._attachedSensors) {
                this._attachedSensors = new Set();
            }
            if (!this._attachedSensors.has(pin)) {
                this._attachedSensors.add(pin);
                this._writeWorkerCmd({
                    cmd: 'sensor_attach',
                    sensor_type: 'dht22',
                    pin: pin,
                    temperature: temp,
                    humidity: hum
                });
            } else {
                this._writeWorkerCmd({
                    cmd: 'sensor_update',
                    pin: pin,
                    temperature: temp,
                    humidity: hum
                });
            }
        }
    }

    setVirtualAdc(channel, millivolts) {
        if (this._destroyed) return;

        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({
                cmd: 'set_adc',
                channel: channel,
                millivolts: millivolts
            });
        }
    }

    sensorAttach(sensor_type, pin, properties) {
        if (this._destroyed) return;
        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({ cmd: 'sensor_attach', sensor_type, pin, ...properties });
        }
    }

    /**
     * setAdcValue(pin, value)
     * Inject a 12-bit ADC value for a GPIO pin (legacy mode only).
     * The value is sent to the firmware as <ADC:pin:val>\n via UART RX.
     */
    setAdcValue(pin, value) {
        if (this._destroyed) return;
        if (!this._isSharedLibraryMode) {
            const cmd = `<ADC:${pin}:${value}>\n`;
            if (this._uartSocket && !this._uartSocket.destroyed) {
                try { this._uartSocket.write(Buffer.from(cmd)); } catch (e) {}
            }
        } else {
            // Shared-lib mode: set_adc_raw already exists
            this._writeWorkerCmd({ cmd: 'set_adc_raw', channel: pin, raw: value });
        }
    }

    /**
     * setI2cResponse(addr, bytes)
     * Pre-load the I2C read-response bytes for a given 7-bit address.
     * When the firmware calls Wire.requestFrom(addr, n), the firmware shim
     * emits >I2C_READ:addr:qty< and this runner injects <I2C_RESP:addr:hex>.
     */
    setI2cResponse(addr, bytes) {
        if (this._destroyed) return;
        if (!this._i2cResponses) this._i2cResponses = new Map();
        this._i2cResponses.set(addr, bytes);
    }

    /**
     * _scheduleSpiFlush()
     * Schedules a one-shot 33ms timer that encodes all buffered SPI TX bytes
     * as base64 and emits a SPI_BATCH WebSocket event. Re-arming is idempotent.
     */
    _scheduleSpiFlush() {
        if (this._spiFlushTimer) return; // already scheduled
        this._spiFlushTimer = setTimeout(() => {
            this._spiFlushTimer = null;
            if (!this._spiTxBuf || this._spiTxBuf.length === 0) return;
            // Encode hex pairs as a binary buffer then base64
            const hexStr = this._spiTxBuf.join('');
            this._spiTxBuf = [];
            const bin = Buffer.from(hexStr, 'hex');
            const b64 = bin.toString('base64');
            this._sendWs({ type: 'SPI_BATCH', b64 });
        }, 33);
    }

    _flushSpi() {
        if (this._spiFlushTimer) {
            clearTimeout(this._spiFlushTimer);
            this._spiFlushTimer = null;
        }
        if (!this._spiTxBuf || this._spiTxBuf.length === 0) return;
        const hexStr = this._spiTxBuf.join('');
        this._spiTxBuf = [];
        const bin = Buffer.from(hexStr, 'hex');
        const b64 = bin.toString('base64');
        this._sendWs({ type: 'SPI_BATCH', b64 });
    }

    sensorUpdate(pin, properties) {
        if (this._destroyed) return;
        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({ cmd: 'sensor_update', pin, ...properties });
        }
    }

    sensorDetach(pin) {
        if (this._destroyed) return;
        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({ cmd: 'sensor_detach', pin });
        }
    }

    /**
     * sendSerialInput(uart, bytes)
     *
     * Inject raw bytes into the ESP32's UART RX FIFO.
     * In shared-library mode, forwards a 'uart_receive' command to the Python
     * worker which calls qemu_picsimlab_uart_receive() directly — the safest
     * and most timing-accurate path.
     * In legacy TCP mode, writes the bytes as a raw buffer over the UART0 socket.
     *
     * The caller (compileController) is responsible for chunking to ≤64 bytes
     * to prevent FIFO overflow, matching the Velxio constraint.
     *
     * @param {number}   uart  - UART index (0 = primary Serial, 1/2 = extra).
     * @param {number[]} bytes - Array of byte values (0–255).
     */
    sendSerialInput(uart, bytes) {
        if (this._destroyed) return;
        if (!Array.isArray(bytes) || bytes.length === 0) return;

        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({ cmd: 'uart_receive', uart, bytes });
            return;
        }

        // Legacy mode — only UART0 is bridged via the TCP socket
        if (uart === 0 && this._uartSocket && !this._uartSocket.destroyed) {
            try {
                this._uartSocket.write(Buffer.from(bytes));
            } catch (e) {
                this._log.warn('sendSerialInput write error (legacy):', e.message);
            }
        }
    }

    // ── ESP32-CAM frame injection ─────────────────────────────────────────────
    // Mirrors Velxio's Esp32Bridge.sendCameraAttach/Frame/Detach exactly.
    // The worker routes to velxio_push_camera_frame() in libqemu-xtensa which
    // delivers the bytes to the QEMU OV2640+I²S DMA buffer.  esp_camera_fb_get()
    // in the firmware receives the frame transparently.

    /**
     * sendCameraAttach()
     *
     * Tell the worker a webcam frame source is connected. Call once when the
     * user grants camera permission. No-op if library not built with camera patch.
     */
    sendCameraAttach() {
        if (this._destroyed) return;
        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({ cmd: 'camera_attach' });
        }
    }

    /**
     * sendCameraFrame(b64, fmt?, width?, height?)
     *
     * Push one JPEG frame from the browser webcam to the QEMU OV2640 DMA buffer.
     * Encoding: base64 in JSON, ~10–14 KB per QVGA frame at quality 0.6.
     * At 10 fps that's ~120 KB/s — trivial over local WS.
     *
     * @param {string} b64    - JPEG frame as base64 string (btoa of raw bytes).
     * @param {string} fmt    - Image format, 'jpeg' by default.
     * @param {number} width  - Frame width in pixels (default 320).
     * @param {number} height - Frame height in pixels (default 240).
     */
    sendCameraFrame(b64, fmt = 'jpeg', width = 320, height = 240) {
        if (this._destroyed) return;
        if (!b64) return;
        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({ cmd: 'camera_frame', b64, fmt, w: width, h: height });
        }
    }

    /**
     * sendCameraDetach()
     *
     * Drop the queued frame and detach the camera. Calls velxio_push_camera_frame
     * with a NULL/empty payload on the C side which resets the DMA pointer.
     */
    sendCameraDetach() {
        if (this._destroyed) return;
        if (this._isSharedLibraryMode) {
            this._writeWorkerCmd({ cmd: 'camera_detach' });
        }
    }

    /**
     * kill() — Terminate QEMU immediately (SIGKILL) and clean up all resources.
     * Safe to call multiple times.
     */
    kill() {
        if (this._destroyed) return;
        this._destroyed = true;

        // Stop perf log timer
        if (this._perf.logTimer) {
            clearInterval(this._perf.logTimer);
            this._perf.logTimer = null;
        }

        this.phase = 'stopped';
        this._log.info('⚡ Killing QEMU process');

        this._stopHeartbeatWatchdog();

        if (this._process) {
            try {
                if (this._isSharedLibraryMode) {
                    this._writeWorkerCmd({ cmd: 'stop' });
                    this._process.kill('SIGKILL');
                } else {
                    this._process.kill('SIGKILL');
                }
            } catch { /* already exited */ }
            this._process = null;
        }

        if (!this._isSharedLibraryMode) {
            this._cleanupPipes();
        } else {
            if (this.sketchDir) {
                try {
                    if (fs.existsSync(this.sketchDir)) {
                        fs.rmSync(this.sketchDir, { recursive: true, force: true });
                        this._log.info(`🧹 Sketch build folder cleaned up: ${this.sketchDir}`);
                    }
                } catch (e) {
                    this._log.error(`Failed to delete sketch build folder ${this.sketchDir}:`, e.message);
                }
            }
        }
    }

    _stopHeartbeatWatchdog() {
        if (this._heartbeatTimer !== null) {
            clearTimeout(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }



    // ─────────────────────────────────────────────────────────────────────────
    // Private — NIC argument builder
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns the -nic args for QEMU based on the WIFI_MODE env var.
     *
     *  slirp (default) — userspace NAT, no root needed, macOS + Linux.
     *  tap             — kernel-level tap0, Linux production only.
     */
    _buildNicArgs() {
        const wifiMode = (process.env.WIFI_MODE || 'slirp').toLowerCase();

        if (wifiMode === 'tap') {
            const tapIface = process.env.TAP_INTERFACE || 'tap0';
            this._log.info(`🌐 WiFi mode: TAP (interface=${tapIface})`);
            // Prerequisites: ip tuntap add tap0 mode tap && ip link set tap0 up
            return ['-nic', `tap,ifname=${tapIface},script=no,downscript=no,model=open_eth`];
        }

        this._log.info('🌐 WiFi mode: SLIRP (userspace NAT)');
        return ['-nic', 'user,model=open_eth'];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private — QEMU spawn
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Builds the QEMU argv and spawns the child process.
     *
     * UART mapping:
     *   -serial pipe:<prefix>            → UART0 (SimulatorBridge GPIO + serial monitor)
     *   -serial tcp:127.0.0.1:<port>     → UART1 (WiFi payload multiplexer)
     */
    _spawnQemu(qemuPath, nicArgs, proxyPort, uartPort) {
        const args = [
            '-nographic',
            '-machine', 'esp32',
            '-m', '4M',
            '-drive',   `file=${this.flashImage},if=mtd,format=raw`,
            '-serial',  `tcp:127.0.0.1:${uartPort}`,      // UART0 → Node.js TCP Server
            '-serial',  `tcp:127.0.0.1:${proxyPort}`,     // UART1 → NetworkProxy
            ...nicArgs,
        ];

        this._log.info(`🚀 Spawning QEMU: ${qemuPath} ${args.join(' ')}`);

        this._process = spawn(qemuPath, args, {
            // stdin/stdout/stderr are for QEMU's monitor, NOT the UART lines.
            // Only pipe stderr so we can capture QEMU-level errors.
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        // Set low scheduling priority to prevent CPU starvation
        if (this._process && this._process.pid) {
            try {
                os.setPriority(this._process.pid, 10);
                this._log.info(`Priority set to 10 for QEMU process ${this._process.pid}`);
            } catch (e) {
                this._log.warn('Failed to set QEMU process priority:', e.message);
            }
        }

        // Attach lifecycle handlers
        this._attachProcessHandlers();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private — Process lifecycle handlers
    // ─────────────────────────────────────────────────────────────────────────

    _attachProcessHandlers() {
        // ── QEMU stderr (QEMU monitor / errors — not UART) ───────────────────
        this._process.stderr.on('data', (data) => {
            const text = data.toString().trim();
            if (!text) return;

            // Only surface genuine errors; suppress QEMU info lines
            const lower = text.toLowerCase();
            if (lower.includes('error') || lower.includes('failed') || lower.includes('abort')) {
                this._log.error('🔴 QEMU stderr:', text);
            }
        });

        // ── Normal or unexpected exit ───────────────────────────────────────────
        this._process.on('close', (code, signal) => {
            this._log.info(`🛑 QEMU exited (code=${code}, signal=${signal}, destroyed=${this._destroyed})`);
            
            if (!this._destroyed) {
                // Unexpected exit - trigger crash recovery
                this._handleCrash(`Process exited unexpectedly (code=${code ?? 'unknown'}, signal=${signal ?? 'none'})`);
            } else {
                // Normal exit triggered by kill()
                this._stopHeartbeatWatchdog();

                this.phase = 'stopped';
                this._sendWs({ type: 'QEMU_EXIT', code: code ?? -1 });
                wsManager.unregisterSession(this.buildId);

                this._process = null;
                this._cleanupPipes();
            }
        });

        // ── Spawn error (e.g. QEMU not in PATH) ──────────────────────────────
        this._process.on('error', (err) => {
            this._log.error('🔴 Failed to spawn QEMU:', err.message);
            this.phase = 'stopped';
            this._sendWs({
                type:    'QEMU_ERROR',
                message: `Failed to start QEMU: ${err.message}. ` +
                         `Is qemu-system-xtensa installed and in PATH?`,
            });
            this._stopHeartbeatWatchdog();
            if (!this._destroyed) this._cleanupPipes();
        });
    }

    /**
     * _handleCrash(reason)
     *
     * Handles unexpected crashes, stalls, or cache errors.
     * Automatically attempts to reboot QEMU up to _maxRestarts times.
     */
    _handleCrash(reason) {
        if (this._destroyed) return;

        this._log.warn(`⚠️ QEMU session crashed or stalled: ${reason}`);

        if (this._restartCount < this._maxRestarts) {
            this._restartCount++;

            // Print diagnostic warning in the client's serial monitor
            this._sendWs({
                type: 'SERIAL_LOG',
                level: 'WARN',
                message: `ESP32 simulator crashed or stalled: ${reason}. Restarting emulation session (Attempt ${this._restartCount}/${this._maxRestarts})...`
            });

            // Transition state back to booting
            this.phase = 'booting';
            this._bootDetected = false;
            this.isReady = false;
            this._sendWs({ type: 'QEMU_BOOTING' });

            // Teardown the current process context cleanly
            this._stopHeartbeatWatchdog();

            if (this._process) {
                try {
                    this._process.removeAllListeners();
                    this._process.kill('SIGKILL');
                } catch { /* already dead */ }
                this._process = null;
            }

            // Clear incomplete line buffer
            this._outBuffer = '';
            if (this._uartBuffers) {
                this._uartBuffers = {};
            }

            // Schedule QEMU reboot after a brief cooldown.
            // Wait 1.5 s to give the OS time to reclaim the TCP port from
            // the crashed QEMU process before we try to bind it again.
            setTimeout(async () => {
                if (this._destroyed) return;
                this._log.info(`Rebooting QEMU ESP32 instance (Attempt ${this._restartCount}/${this._maxRestarts})...`);

                // On Windows, force-kill any process still listening on the UART
                // port left behind by the crashed QEMU (zombie TCP server).
                if (this._uartPort) {
                    try {
                        const { execSync } = await import('child_process');
                        // netstat -ano shows PID; find the one on our port and kill it
                        const out = execSync(
                            `netstat -ano | findstr ":${this._uartPort} "`,
                            { encoding: 'utf8', timeout: 3000 }
                        );
                        const pids = new Set();
                        for (const line of out.split('\n')) {
                            const m = line.trim().split(/\s+/);
                            const pid = parseInt(m[m.length - 1], 10);
                            if (pid > 4 && pid !== process.pid) pids.add(pid);  // skip System (PID 4) and ourselves
                        }
                        for (const pid of pids) {
                            try {
                                execSync(`taskkill /PID ${pid} /F`, { timeout: 2000 });
                                this._log.info(`🧹 Killed zombie QEMU process PID ${pid} holding port ${this._uartPort}`);
                            } catch { /* already dead */ }
                        }
                    } catch { /* netstat failed or no zombie — proceed anyway */ }
                }

                if (this._isSharedLibraryMode) {
                    const libPath = this._getSharedLibraryPath();
                    this._startSharedLibraryWorker(libPath);
                } else {
                    this._spawnQemu(this._qemuPath, this._nicArgs, this._proxyPort, this._uartPort);
                }
            }, 1500);
        } else {
            // Exceeded retry count
            this._sendWs({
                type: 'SERIAL_LOG',
                level: 'ERROR',
                message: 'ESP32 simulator crashed repeatedly. Emulation aborted.'
            });
            this._sendWs({
                type:    'QEMU_ERROR',
                message: `QEMU simulator terminated: ${reason}. Repeated crashes detected.`,
            });
            this.kill();
        }
    }



    // ─────────────────────────────────────────────────────────────────────────
    // Private — UART data parser
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Called on every successful read from uart.out.
     * Appends chunk to the line accumulator, then processes complete lines.
     *
     * Safety valve: if the buffer grows beyond MAX_UART_BUFFER_BYTES without a
     * newline, the accumulated data is flushed as-is and the buffer is reset.
     * This prevents unbounded memory growth if firmware sends binary garbage.
     */
    _handleSerialData(chunk) {
        this._outBuffer += chunk;

        // Safety valve: prevent memory exhaustion from missing newlines
        if (this._outBuffer.length > MAX_UART_BUFFER_BYTES) {
            this._log.warn(
                `UART buffer overflow (${this._outBuffer.length} bytes) — flushing`,
            );
            this._processLine(this._outBuffer.replace(/\r?\n/g, ' '));
            this._outBuffer = '';
            return;
        }

        const lines = this._outBuffer.split('\n');
        // Keep the last (potentially incomplete) chunk in the buffer
        this._outBuffer = lines.pop();

        for (const raw of lines) {
            // Process complete line — strip CR and ANSI escape sequences
            const lineClean = raw.replace(/\r/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
            if (lineClean) this._processLine(lineClean);
        }
    }

    /**
     * Routes a single complete UART line through the full lifecycle state machine:
     *
     *  Phase 1 — BOOTING
     *   • ROM boot signatures detected → send QEMU_BOOTING once
     *   • ROM noise filtered out of serial monitor
     *
     *  Phase 2 — RUNNING (after firmware sends >SIM:READY<)
     *   • >SIM:READY<     → send FIRMWARE_READY (UI shows "Running")
     *   • >SIM:BEAT<      → refresh heartbeat watchdog
     *   • >SIM:LOG:…<     → send SERIAL_LOG with level + message
     *   • >GPIO:<p>:<v><  → send GPIO_SYNC (never to serial monitor)
     *   • Everything else → send SERIAL_OUTPUT
     */
    _processLine(line) {
        if (process.env.DEBUG_RAW_UART === 'true') {
            this._log.info('RAW UART LINE:', line);
        }
        // ── Phase 1: ROM boot detection ───────────────────────────────────────
        if (!this._bootDetected) {
            if (BOOT_SIGNATURES.some(sig => line.includes(sig))) {
                this._bootDetected = true;
                this.phase = 'booting';
                this._log.info('🔄 QEMU_BOOTING — ROM boot sequence detected');
                this._sendWs({ type: 'QEMU_BOOTING' });
            }
        }

        // ── Crash / Core Panic detection ──────────────────────────────────────
        if (CRASH_PATTERNS.some(re => re.test(line))) {
            this._log.error('🔴 Crash pattern detected in serial output:', line);
            // Propagate the crash event, but skip raw trace serialization to prevent lag
            setTimeout(() => {
                this._handleCrash('Guru Meditation / Cache Error');
            }, 50);
            return;
        }

        // ── GPIO shim intercept ───────────────────────────────────────────────
        // >GPIO:<pin>:<val>< must NEVER reach the serial monitor.
        const gpioMatch = line.match(GPIO_PATTERN);
        if (gpioMatch) {
            // Flush any buffered SPI bytes before changing GPIO pin state
            this._flushSpi();

            const pin   = parseInt(gpioMatch[1], 10);
            const value = parseInt(gpioMatch[2], 10);

            
            // Deduplicate GPIO state changes to prevent WebSocket flooding
            if (pin >= 0 && pin < this._lastGpioValues.length) {
                if (this._lastGpioValues[pin] !== value) {
                    this._lastGpioValues[pin] = value;
                    this._sendWs({ type: 'GPIO_SYNC', pin, value });
                }
            } else {
                this._sendWs({ type: 'GPIO_SYNC', pin, value });
            }
            return;
        }

        // ── I2C shim intercept ───────────────────────────────────────────────
        // >I2C:<addr_hex>:<data_hex>< — write transaction from SimWire
        const i2cMatch = line.match(I2C_PATTERN);
        if (i2cMatch) {
            const addr = parseInt(i2cMatch[1], 16);
            const hexStr = i2cMatch[2];
            const data = [];
            for (let i = 0; i < hexStr.length; i += 2) {
                data.push(parseInt(hexStr.substring(i, i + 2), 16));
            }
            this._sendWs({ type: 'I2C_TRANSACTION', addr, data });
            return;
        }

        // >I2C_READ:<addr_hex>:<qty_hex>< — read request from SimWire.requestFrom()
        // Respond immediately by injecting cached response bytes via UART RX.
        const i2cReadMatch = line.match(I2C_READ_PATTERN);
        if (i2cReadMatch) {
            const addr = parseInt(i2cReadMatch[1], 16);
            const qty  = parseInt(i2cReadMatch[2], 16);
            // Also notify frontend so it can update component state
            this._sendWs({ type: 'I2C_READ_REQ', addr, qty });
            // Inject cached response if available
            const respBytes = this._i2cResponses?.get(addr);
            if (respBytes && respBytes.length > 0) {
                const hex = Array.from(respBytes.slice(0, qty))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
                const cmd = `<I2C_RESP:${addr.toString(16).padStart(2,'0')}:${hex}>\n`;
                if (this._uartSocket && !this._uartSocket.destroyed) {
                    try { this._uartSocket.write(Buffer.from(cmd)); } catch (e) {}
                }
            }
            return;
        }

        // >SPI:<hexbyte>< — single byte SPI.transfer() from SimSPI
        // >SPIBUF:<hexdata>< — buffer SPI.transferBytes() from SimSPI
        // Both are batched into a SPI_BATCH WS event every 33ms.
        const spiMatch = line.match(SPI_PATTERN);
        if (spiMatch) {
            if (!this._spiTxBuf) this._spiTxBuf = [];
            this._spiTxBuf.push(spiMatch[1]);
            this._scheduleSpiFlush();
            return;
        }
        const spiBufMatch = line.match(SPIBUF_PATTERN);
        if (spiBufMatch) {
            if (!this._spiTxBuf) this._spiTxBuf = [];
            // Split into 2-char hex pairs
            const hex = spiBufMatch[1];
            for (let i = 0; i < hex.length; i += 2) this._spiTxBuf.push(hex.substring(i, i + 2));
            this._scheduleSpiFlush();
            return;
        }

        // ── Simulator control frame intercept ────────────────────────────────
        // >SIM:CMD[:payload]< lines are protocol control — not user serial output.
        const simMatch = line.match(SIM_FRAME_PATTERN);
        if (simMatch) {
            this._handleSimFrame(simMatch[1], simMatch[2] || '');
            return; // consumed — do not forward to serial monitor
        }

        // ── ROM noise filter ──────────────────────────────────────────────────
        // Suppress well-known ROM/IDF lines from the user's serial monitor.
        // These are normal and cannot be removed from QEMU output.
        if (this.phase === 'booting') {
            if (ROM_NOISE_PATTERNS.some(re => re.test(line))) return;
        }

        // ── Regular serial output → client serial monitor (Disabled to prevent UI/event-loop lag) ─────────────────────
        // this._sendWs({ type: 'SERIAL_OUTPUT', text: line + '\n' });
    }

    /**
     * _handleSimFrame(cmd, payload)
     *
     * Handles simulator-internal protocol frames from SimulatorBridge.h.
     * These originate from sim_ready(), heartbeat task, and sim_log().
     */
    _handleSimFrame(cmd, payload) {
        switch (cmd) {
            case 'READY':
                if (this.phase === 'running') return; // Idempotent
                this.phase   = 'running';
                this.isReady = true;
                this._log.info('✅ FIRMWARE_READY — device handshake received');
                this._sendWs({ type: 'FIRMWARE_READY' });
                // Also send legacy QEMU_READY for backward compat
                this._sendWs({ type: 'QEMU_READY' });
                // Arm heartbeat watchdog now that firmware is live
                this._armHeartbeatWatchdog();
                break;

            case 'BEAT':
                // Refresh the watchdog on every heartbeat
                this.lastActivity = Date.now();
                this._armHeartbeatWatchdog();
                // this._log.info('💓 Heartbeat received'); // Muted to prevent backend terminal spam
                break;

            case 'LOG': {
                // payload = "<level>:<message>"
                const colonIdx = payload.indexOf(':');
                const level   = colonIdx > 0 ? payload.slice(0, colonIdx)  : 'INFO';
                const message = colonIdx > 0 ? payload.slice(colonIdx + 1) : payload;
                this._sendWs({ type: 'SERIAL_LOG', level, message });
                break;
            }

            default:
                this._log.warn('Unknown SIM frame command:', cmd);
        }
    }

    /**
     * _armHeartbeatWatchdog()
     *
     * Resets the heartbeat timeout.  If no BEAT arrives within
     * HEARTBEAT_TIMEOUT_MS after being armed, the session is declared stalled
     * and FIRMWARE_STALLED is sent to the frontend.
     *
     * The watchdog is NOT armed until FIRMWARE_READY is received, so it does
     * not fire during the (potentially slow) boot sequence.
     */
    _armHeartbeatWatchdog() {
        if (HEARTBEAT_TIMEOUT_MS <= 0) return; // Disabled
        if (this._heartbeatTimer !== null) clearTimeout(this._heartbeatTimer);
        this._heartbeatTimer = setTimeout(() => {
            if (this._destroyed) return;
            this._log.warn('⚠️  Heartbeat timeout — firmware may have crashed or stalled');
            this._handleCrash(`Heartbeat timeout (Infinite loop or stall detected)`);
        }, HEARTBEAT_TIMEOUT_MS);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private — Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Helper: send a WebSocket message for this session.
     * Always injects buildId so the frontend can verify session ownership.
     */
    _sendWs(payload) {
        this._perf.wsSent++;
        wsManager.sendToSession(this.buildId, { ...payload, buildId: this.buildId });
    }

    /**
     * Stop the NetworkProxy and remove the FIFO files and their directory.
     * rmdirSync is intentionally non-recursive — we only remove our own temp dir.
     */
    _cleanupPipes() {
        if (this._proxy) {
            try { this._proxy.stop(); } catch { /* best-effort */ }
            this._proxy = null;
        }

        if (this._uartSocket && !this._uartSocket.destroyed) {
            try { this._uartSocket.destroy(); } catch { /* best-effort */ }
            this._uartSocket = null;
        }

        if (this._uartServer) {
            try { this._uartServer.close(); } catch { /* best-effort */ }
            this._uartServer = null;
        }

        try { fs.rmdirSync(this.pipesDir); } catch { /* non-empty or already gone */ }

        if (this.sketchDir) {
            try {
                if (fs.existsSync(this.sketchDir)) {
                    fs.rmSync(this.sketchDir, { recursive: true, force: true });
                    this._log.info(`🧹 Sketch build folder cleaned up: ${this.sketchDir}`);
                }
            } catch (e) {
                this._log.error(`Failed to delete sketch build folder ${this.sketchDir}:`, e.message);
            }
        }

        this._log.info('🧹 Pipes and proxy cleaned up');
    }
}
