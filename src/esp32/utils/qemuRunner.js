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

import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
const GPIO_PATTERN = /^>GPIO:(\d+):([01])<$/;

/**
 * SimulatorBridge.h simulation control frames.
 * Format: >SIM:<cmd>[:<args>]<
 *   READY  — firmware setup() complete; device is fully initialised
 *   BEAT   — periodic heartbeat liveness ping
 *   LOG    — structured log line: >SIM:LOG:<level>:<msg><
 */
const SIM_FRAME_PATTERN = /^>SIM:([A-Z]+)(?::(.*))?<$/;

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

        // Derived FIFO paths
        this.uartIn  = path.join(pipesDir, 'uart.in');
        this.uartOut = path.join(pipesDir, 'uart.out');

        // Runtime state
        this._process          = null;   // child_process handle
        this._pollTimer        = null;   // setInterval handle for uart.out polling
        this._uartOutFd        = -1;     // raw file descriptor for uart.out
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
    start() {
        if (this._destroyed) {
            this._log.warn('start() called on a destroyed runner — ignoring.');
            return;
        }

        if (!this._createFifos()) return; // error already sent to WS

        this._qemuPath = process.env.QEMU_ESP32_PATH || path.resolve(__dirname, '../../../../external/qemu/qemu/bin/qemu-system-xtensa');
        this._nicArgs  = this._buildNicArgs();

        // Start the network proxy first; QEMU is spawned inside the callback
        // so we know the proxy TCP port before building the QEMU argv.
        this._proxy = new NetworkProxy(this.buildId, (proxyPort) => {
            this._proxyPort = proxyPort;
            this._spawnQemu(this._qemuPath, this._nicArgs, proxyPort);
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

        const cmd = `<GPIO:${pin}:${value ? 1 : 0}>\n`;
        let fd = -1;
        try {
            // O_WRONLY | O_NONBLOCK — open never blocks if firmware isn't reading
            fd = fs.openSync(this.uartIn, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
            fs.writeSync(fd, cmd);
        } catch (e) {
            if (e.code !== 'ENXIO') {
                // ENXIO = no reader on the FIFO yet (expected during boot) — silent
                this._log.warn('setVirtualPin write error:', e.code, e.message);
            }
        } finally {
            if (fd !== -1) {
                try { fs.closeSync(fd); } catch { /* best-effort */ }
            }
        }
    }

    /**
     * kill() — Terminate QEMU immediately (SIGKILL) and clean up all resources.
     * Safe to call multiple times.
     */
    kill() {
        if (this._destroyed) return;
        this._destroyed = true;

        this.phase = 'stopped';
        this._log.info('⚡ Killing QEMU process');

        this._stopPollTimer();
        this._stopHeartbeatWatchdog();

        if (this._process) {
            try { this._process.kill('SIGKILL'); } catch { /* already exited */ }
            this._process = null;
        }

        this._closeFd();
        this._cleanupPipes();
    }

    _stopHeartbeatWatchdog() {
        if (this._heartbeatTimer !== null) {
            clearTimeout(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private — FIFO setup
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Creates the uart.in and uart.out named pipes.
     * Removes stale FIFOs from a previous crashed session first.
     * @returns {boolean} true on success, false if an error was sent to WS.
     */
    _createFifos() {
        try {
            fs.mkdirSync(this.pipesDir, { recursive: true });

            // Remove stale FIFOs from a previous run (unlinkSync is safe on missing files)
            for (const p of [this.uartIn, this.uartOut]) {
                try { fs.unlinkSync(p); } catch { /* not present — fine */ }
            }

            // Node.js has no native mkfifo binding; use execFileSync for portability.
            execFileSync('mkfifo', [this.uartIn]);
            execFileSync('mkfifo', [this.uartOut]);

            return true;
        } catch (err) {
            this._log.error('❌ Failed to create FIFOs:', err.message);
            this._sendWs({ type: 'QEMU_ERROR', message: `Failed to create serial pipes: ${err.message}` });
            return false;
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
    _spawnQemu(qemuPath, nicArgs, proxyPort) {
        const pipePrefix = path.join(this.pipesDir, 'uart');

        const args = [
            '-nographic',
            '-machine', 'esp32',
            '-m', '4M',
            '-drive',   `file=${this.flashImage},if=mtd,format=raw`,
            '-serial',  `pipe:${pipePrefix}`,      // UART0 → SimulatorBridge
            '-serial',  `tcp:127.0.0.1:${proxyPort}`, // UART1 → NetworkProxy
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

        // Attach lifecycle handlers before opening the FIFO to avoid race.
        this._attachProcessHandlers();

        // Open the uart.out FIFO for non-blocking reads.
        // We retry because QEMU may not have opened its write-end yet.
        this._openOutPipe(0);
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
                this._stopPollTimer();
                this._stopHeartbeatWatchdog();
                this._closeFd();

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
            this._stopPollTimer();
            this._stopHeartbeatWatchdog();
            this._closeFd();
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
            const diagMsg = `\r\n⚠️ [SYSTEM] ESP32 simulator crashed or stalled: ${reason}.\r\n` +
                            `⚠️ [SYSTEM] Restarting emulation session (Attempt ${this._restartCount}/${this._maxRestarts})...\r\n\r\n`;
            this._sendWs({ type: 'SERIAL_OUTPUT', text: diagMsg });

            // Transition state back to booting
            this.phase = 'booting';
            this._bootDetected = false;
            this.isReady = false;
            this._sendWs({ type: 'QEMU_BOOTING' });

            // Teardown the current process context cleanly
            this._stopPollTimer();
            this._stopHeartbeatWatchdog();
            this._closeFd();

            if (this._process) {
                try {
                    this._process.removeAllListeners();
                    this._process.kill('SIGKILL');
                } catch { /* already dead */ }
                this._process = null;
            }

            // Clear incomplete line buffer
            this._outBuffer = '';

            // Schedule QEMU reboot after a brief cooldown
            setTimeout(() => {
                if (this._destroyed) return;
                this._log.info(`Rebooting QEMU ESP32 instance (Attempt ${this._restartCount}/${this._maxRestarts})...`);
                this._spawnQemu(this._qemuPath, this._nicArgs, this._proxyPort);
            }, 500);
        } else {
            // Exceeded retry count
            const fatalMsg = `\r\n❌ [SYSTEM] ESP32 simulator crashed repeatedly. Emulation aborted.\r\n`;
            this._sendWs({ type: 'SERIAL_OUTPUT', text: fatalMsg });
            this._sendWs({
                type:    'QEMU_ERROR',
                message: `QEMU simulator terminated: ${reason}. Repeated crashes detected.`,
            });
            this.kill();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private — uart.out FIFO polling
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Attempt to open uart.out O_NONBLOCK. Retries up to OPEN_PIPE_MAX_ATTEMPTS
     * times (×100 ms = 5 s) while QEMU is still initialising its write-end.
     *
     * Once opened, starts a setInterval poll loop.
     */
    _openOutPipe(attempt) {
        if (this._destroyed || !this._process) return;

        try {
            const fd = fs.openSync(
                this.uartOut,
                fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
            );
            this._uartOutFd = fd;
            this._log.info('📡 uart.out FIFO opened — starting poll loop');
            this._startPollLoop(fd);
        } catch (e) {
            if (attempt < OPEN_PIPE_MAX_ATTEMPTS) {
                setTimeout(() => this._openOutPipe(attempt + 1), 100);
            } else {
                this._log.error(
                    `❌ Could not open uart.out after ${OPEN_PIPE_MAX_ATTEMPTS * 100}ms:`,
                    e.message,
                );
                this._sendWs({
                    type:    'QEMU_ERROR',
                    message: 'UART serial pipe failed to open — QEMU may have crashed at boot.',
                });
            }
        }
    }

    /**
     * Poll uart.out every POLL_INTERVAL_MS milliseconds.
     * Reads up to READ_BUF_SIZE bytes per tick to prevent starvation.
     */
    _startPollLoop(fd) {
        const buf = Buffer.allocUnsafe(READ_BUF_SIZE);

        this._pollTimer = setInterval(() => {
            // Abort if QEMU has been killed between ticks
            if (this._destroyed || !this._process) {
                this._stopPollTimer();
                this._closeFd();
                return;
            }

            try {
                const n = fs.readSync(fd, buf, 0, buf.length, null);
                if (n > 0) {
                    this.lastActivity = Date.now();
                    this._handleSerialData(buf.subarray(0, n).toString('utf8'));
                }
            } catch (e) {
                // EAGAIN / EWOULDBLOCK = no data ready — this is normal
                if (e.code !== 'EAGAIN' && e.code !== 'EWOULDBLOCK') {
                    this._log.error('uart.out read error:', e.code, e.message);
                    this._stopPollTimer();
                }
            }
        }, POLL_INTERVAL_MS);
    }

    _stopPollTimer() {
        if (this._pollTimer !== null) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _closeFd() {
        if (this._uartOutFd !== -1) {
            try { fs.closeSync(this._uartOutFd); } catch { /* best-effort */ }
            this._uartOutFd = -1;
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
            const line = raw.replace(/\r/g, '').trim();
            if (line) this._processLine(line);
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
            // Propagate the crash line to the serial monitor so user sees the panic trace,
            // then trigger recovery asynchronously to allow remaining outputs to deliver.
            this._sendWs({ type: 'SERIAL_OUTPUT', text: line + '\n' });
            setTimeout(() => {
                this._handleCrash('Guru Meditation / Cache Error');
            }, 50);
            return;
        }

        // ── GPIO shim intercept ───────────────────────────────────────────────
        // >GPIO:<pin>:<val>< must NEVER reach the serial monitor.
        const gpioMatch = line.match(GPIO_PATTERN);
        if (gpioMatch) {
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

        // ── Regular serial output → client serial monitor ─────────────────────
        this._sendWs({ type: 'SERIAL_OUTPUT', text: line + '\n' });
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

        for (const p of [this.uartIn, this.uartOut]) {
            try { fs.unlinkSync(p); } catch { /* already gone */ }
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
