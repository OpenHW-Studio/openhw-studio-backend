/**
 * renodeRunner.js  —  STM32 Renode emulation runner
 * ─────────────────────────────────────────────────────────────────────────────
 * Mirrors qemuRunner.js but targets Renode + STM32F103 instead of QEMU + ESP32.
 *
 * Key architecture differences vs QEMU:
 *  - Renode acts as the TCP SERVER (via sysbus.uart1 CreateTcpServer).
 *  - Node.js connects as TCP CLIENT, with retry loop since Renode takes ~1-2s to start.
 *  - No flash merging needed — Renode loads .elf directly.
 *  - No FreeRTOS on STM32 — UART task replaced by yield() hook.
 *
 * Protocol (identical to ESP32 / qemuRunner.js):
 *   Firmware → Node.js:
 *     >GPIO:<portpin>:<val><       e.g. >GPIO:PA5:1<
 *     >SIM:READY<
 *     >SIM:BEAT<
 *     >SIM:LOG:<level>:<msg><
 *     >I2C:<addr_hex>:<data_hex><
 *     >I2C_READ:<addr>:<qty><
 *     >SPIBUF:<hex><
 *
 *   Node.js → Firmware:
 *     <GPIO:<portpin>:<val>>\n     e.g. <GPIO:PA5:0>\n
 *     <ADC:<portpin>:<val12bit>>\n
 */

import net from 'net';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Configuration ────────────────────────────────────────────────────────────

const RENODE_PATH           = process.env.RENODE_PATH || 'renode';
const RENODE_TCP_BASE_PORT  = parseInt(process.env.RENODE_TCP_BASE_PORT || '4000', 10);
const RENODE_CONNECT_RETRIES = parseInt(process.env.RENODE_CONNECT_RETRIES || '25', 10);
const RENODE_CONNECT_DELAY_MS = parseInt(process.env.RENODE_CONNECT_DELAY_MS || '400', 10);
const RENODE_BOOT_WAIT_MS   = parseInt(process.env.RENODE_BOOT_WAIT_MS || '2000', 10);
const STM32_PLATFORM_DESC   = process.env.STM32_PLATFORM_DESC || '@platforms/cpus/stm32f103.repl';

// Simple port allocator — cycle through 200 ports to reduce conflicts
let _portCounter = 0;
function _allocatePort() {
    const port = RENODE_TCP_BASE_PORT + (_portCounter % 200);
    _portCounter++;
    return port;
}

// ─── Telnet constants ─────────────────────────────────────────────────────────
// Renode's CreateServerSocketTerminal speaks Telnet (RFC 854).
// We must complete the IAC option negotiation before it releases buffered
// UART data to the client.  Only the four options Renode actually sends are
// handled; everything else is refused.

const T_IAC  = 0xFF;   // Interpret As Command
const T_WILL = 0xFB;   // I will use option X
const T_WONT = 0xFC;   // I won't use option X
const T_DO   = 0xFD;   // Please use option X
const T_DONT = 0xFE;   // Please don't use option X
const T_SB   = 0xFA;   // Subnegotiation begin
const T_SE   = 0xF0;   // Subnegotiation end

const T_OPT_BINARY = 0x00;  // Transmit Binary
const T_OPT_ECHO   = 0x01;  // Echo
const T_OPT_SGA    = 0x03;  // Suppress Go-Ahead
const T_OPT_LMODE  = 0x22;  // Linemode

// What we send on connect to immediately complete negotiation
const TELNET_GREETING = Buffer.from([
    T_IAC, T_WILL, T_OPT_BINARY,   // We'll send 8-bit binary
    T_IAC, T_DO,   T_OPT_BINARY,   // Please send 8-bit binary
    T_IAC, T_DO,   T_OPT_SGA,      // Please suppress Go-Ahead
    T_IAC, T_WONT, T_OPT_ECHO,     // We won't echo
    T_IAC, T_DONT, T_OPT_LMODE,    // Don't use Linemode
]);

// ─── Frame parser ─────────────────────────────────────────────────────────────

/**
 * Parse incoming UART data from Renode.
 * Looks for >frame< tokens — same protocol as ESP32.
 */
class FrameParser {
    constructor(onFrame) {
        this._buf = '';
        this._onFrame = onFrame;
    }

    feed(chunk) {
        this._buf += chunk.toString('utf8');
        let start, end;
        while ((start = this._buf.indexOf('>')) !== -1) {
            end = this._buf.indexOf('<', start + 1);
            if (end === -1) break;
            const frame = this._buf.slice(start + 1, end);
            this._buf = this._buf.slice(end + 1);
            if (frame.length > 0) {
                try { this._onFrame(frame); } catch (e) {/* ignore */}
            }
        }
        // Trim to prevent unbounded growth if garbage data appears
        if (this._buf.length > 4096) {
            this._buf = this._buf.slice(-512);
        }
    }
}

// ─── RenodeRunner class ───────────────────────────────────────────────────────

export default class RenodeRunner {
    /**
     * @param {string} buildId      Unique session ID
     * @param {string} elfPath      Absolute path to compiled .elf file
     * @param {string} buildDir     Directory where build artifacts live
     * @param {import('./websocketManager.js').default} wsManager  WS session manager
     */
    constructor(buildId, elfPath, buildDir, wsManager) {
        this.buildId     = buildId;
        this.elfPath     = elfPath;
        this.buildDir    = buildDir;
        this.wsManager   = wsManager;

        this._renode     = null;     // Child process handle
        this._socket     = null;     // TCP socket to Renode's UART server
        this._tcpPort    = _allocatePort();
        this._rescPath   = path.join(buildDir, 'sim.resc');
        this._parser     = new FrameParser((frame) => this._handleFrame(frame));
        this._destroyed  = false;
        this._connectAttempts = 0;

        this.isReady        = false;
        this.lastActivity   = Date.now();
        this.disconnectedAt = null;
    }

    _logDebug(msg) {
        console.log(`[Renode:${this.buildId}] ${msg}`);
        this.wsManager.sendToSession(this.buildId, {
            type:    'SERIAL_OUTPUT',
            buildId: this.buildId,
            data:    `[SIM-DEBUG] ${msg}\n`,
        });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    start() {
        this._writeReplFile();
        this._writeRescScript();
        this._spawnRenode();
    }

    kill() {
        this._destroyed = true;
        this._closeSocket();
        if (this._renode && !this._renode.killed) {
            try { this._renode.kill('SIGTERM'); } catch (e) {/* ignore */}
            setTimeout(() => {
                if (this._renode && !this._renode.killed) {
                    try { this._renode.kill('SIGKILL'); } catch (e) {/* ignore */}
                }
            }, 2000);
        }
        console.log(`[Renode:${this.buildId}] 🛑 Killed`);
    }

    /**
     * Inject a virtual GPIO state into the firmware via UART.
     * @param {string} pin   STM32 port name e.g. "PA5"
     * @param {number} value 0 or 1
     */
    setVirtualPin(pin, value) {
        this._sendToFirmware(`<GPIO:${pin}:${value}>`);
    }

    /**
     * Inject an ADC reading for an analog pin.
     * @param {string} pin   STM32 port name e.g. "PA0"
     * @param {number} value 12-bit ADC value (0-4095)
     */
    setAdcValue(pin, value) {
        this._sendToFirmware(`<ADC:${pin}:${value}>`);
    }

    /**
     * Pre-load I2C read-response bytes for a given address.
     * @param {number} addr   7-bit I2C address
     * @param {number[]} bytes Response bytes
     */
    setI2cResponse(addr, bytes) {
        const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
        const addrHex = addr.toString(16).padStart(2, '0');
        this._sendToFirmware(`<I2C_RESP:${addrHex}:${hex}>`);
    }

    // ── Internal: .resc / .repl script generation ────────────────────────────

    /**
     * Generates a custom Renode Platform Description (.repl) file that adds
     * RCC and FLASH_ACR Python peripherals to the STM32F103 platform.
     *
     * WHY: The official stm32f103.repl has NO behavioral RCC model — only a
     * 4-byte SVD tag for RCC_CR at 0x40021000.  The STM32 Arduino core startup
     * sequence does:
     *   1. Enable HSE → wait for HSERDY  (reads RCC_CR, offset 0x00)
     *   2. Enable PLL → wait for PLLRDY  (reads RCC_CR, offset 0x00)
     *   3. Switch clock to PLL           (writes RCC_CFGR, offset 0x04)
     *   4. Wait for SWS==PLL             (reads RCC_CFGR bits 3:2)
     * Without a model that stores writes, step 4 loops forever because CFGR
     * always reads back 0x0 (SWS=00 = HSI).
     *
     * APPROACH: Use the Renode-recommended `script:` inline Python syntax
     * (identical to platforms/boards/vegaboard_ri5cy.repl) — NOT `filename:`
     * which has silent path-resolution failures on Windows.
     * Variables set during IsInit persist to IsRead/IsWrite naturally;
     * no `global` keyword is needed in Renode's IronPython engine.
     */
    _writeReplFile() {
        this._replPath = path.join(this.buildDir, 'stm32_mock.repl');

        // RCC_CR default: all clocks on + ready
        //   bit 0  HSION  = 1   bit 1  HSIRDY = 1
        //   bit 7  HSITRIM[5] = 1  (trim middle-value)
        //   bit 16 HSEON  = 1   bit 17 HSERDY = 1
        //   bit 24 PLLON  = 1   bit 25 PLLRDY = 1
        //   => 0x0A030083
        //
        const repl = [
            `// Auto-generated by renodeRunner.js for session ${this.buildId}`,
            `// Loaded AFTER stm32f103.repl to override the 4-byte RCC_CR tag.`,
            ``,
            `// ── RCC mock (0x40021000 .. +0x400) ───────────────────────────────────────`,
            `rcc: Python.PythonPeripheral @ sysbus 0x40021000`,
            `    size: 0x400`,
            `    initable: true`,
            `    script: '''`,
            `if 'rcc_regs' not in dir():`,
            `    rcc_regs = [0] * 0x100`,
            `    rcc_regs[0x00 >> 2] = 0x0A030083  # RCC_CR  - all clocks on & ready`,
            `    rcc_regs[0x04 >> 2] = 0x0000000A  # RCC_CFGR - SWS=10 PLL is sys clock`,
            `    rcc_regs[0x14 >> 2] = 0xFFFFFFFF  # RCC_AHBENR - enable all clocks`,
            `    rcc_regs[0x18 >> 2] = 0xFFFFFFFF  # RCC_APB2ENR - enable all clocks`,
            `    rcc_regs[0x1C >> 2] = 0xFFFFFFFF  # RCC_APB1ENR - enable all clocks`,
            `if request.IsRead:`,
            `    idx = request.Offset >> 2`,
            `    request.Value = rcc_regs[idx] if idx < len(rcc_regs) else 0`,
            `if request.IsWrite:`,
            `    idx = request.Offset >> 2`,
            `    if idx < len(rcc_regs):`,
            `        rcc_regs[idx] = request.Value`,
            `        # Mirror SW->SWS in RCC_CFGR so clock-switch wait loop exits`,
            `        if request.Offset == 0x04:`,
            `            sw = request.Value & 0x3`,
            `            rcc_regs[0x04 >> 2] = (rcc_regs[0x04 >> 2] & ~0xC) | (sw << 2)`,
            `        # Mirror PLLON->PLLRDY in RCC_CR (direct 32-bit write path)`,
            `        # When firmware writes PLLON=0, clear PLLRDY immediately so the`,
            `        # HAL 'wait for PLL unlocked' loop exits.`,
            `        if request.Offset == 0x00:`,
            `            pllon = (request.Value >> 24) & 1`,
            `            if pllon:`,
            `                rcc_regs[0] = rcc_regs[0] | (1 << 25)   # PLLRDY=1`,
            `            else:`,
            `                rcc_regs[0] = rcc_regs[0] & ~(1 << 25)  # PLLRDY=0`,
            `'''`,
            ``,
            `// ── RCC Bit-Band alias (0x42420000 .. +0x8000) ────────────────────────────`,
            `rcc_bitband: Python.PythonPeripheral @ sysbus 0x42420000`,
            `    size: 0x8000`,
            `    initable: true`,
            `    script: '''`,
            `if request.IsRead:`,
            `    word_idx = request.Offset >> 7`,
            `    bit_num  = (request.Offset >> 2) & 0x1F`,
            `    sysbus_ref = self.GetMachine().SystemBus`,
            `    reg_val  = sysbus_ref.ReadDoubleWord(0x40021000 + (word_idx * 4))`,
            `    request.Value = (reg_val >> bit_num) & 1`,
            `if request.IsWrite:`,
            `    word_idx = request.Offset >> 7`,
            `    bit_num  = (request.Offset >> 2) & 0x1F`,
            `    sysbus_ref = self.GetMachine().SystemBus`,
            `    reg_val  = sysbus_ref.ReadDoubleWord(0x40021000 + (word_idx * 4))`,
            `    if request.Value:`,
            `        new_val = reg_val | (1 << bit_num)`,
            `    else:`,
            `        new_val = reg_val & ~(1 << bit_num)`,
            `    sysbus_ref.WriteDoubleWord(0x40021000 + (word_idx * 4), new_val)`,
            `'''`,
            ``,
            `// ── FLASH_ACR mock (0x40022000 .. +0x4) ──────────────────────────────────`,
            `flash_acr: Python.PythonPeripheral @ sysbus 0x40022000`,
            `    size: 0x4`,
            `    initable: true`,
            `    script: '''`,
            `if 'flash' not in dir(): flash = 0x30`,
            `if request.IsRead:`,
            `    request.Value = flash`,
            `if request.IsWrite:`,
            `    flash = request.Value`,
            `'''`,
            ``,
            `// ── DWT mock (0xE0001000 .. +0x100) ──────────────────────────────────────`,
            `dwt: Python.PythonPeripheral @ sysbus 0xE0001000`,
            `    size: 0x100`,
            `    initable: true`,
            `    script: '''`,
            `if request.IsRead:`,
            `    if request.Offset == 0x04:`,
            `        cpu = None`,
            `        for c in self.GetMachine().SystemBus.GetCPUs():`,
            `            cpu = c`,
            `            break`,
            `        if cpu is not None:`,
            `            request.Value = int(cpu.ExecutedInstructions * 10) & 0xFFFFFFFF`,
            `        else:`,
            `            request.Value = 0`,
            `    elif request.Offset == 0x00:`,
            `        request.Value = 1`,
            `    else:`,
            `        request.Value = 0`,
            `if request.IsWrite:`,
            `    pass`,
            `'''`,
        ].join('\n');


        fs.writeFileSync(this._replPath, repl, 'utf8');
        console.log(`[Renode:${this.buildId}] 📄 .repl mock written → ${this._replPath}`);
    }

    _writeRescScript() {
        // Normalize paths for Renode — forward slashes on all platforms
        const elfForRenode  = this.elfPath.replace(/\\/g, '/');
        // The .repl path must use the Renode @ URI scheme so it resolves correctly
        const replForRenode = this._replPath.replace(/\\/g, '/');

        // NOTE: Load order is important:
        //  1. stm32f103.repl (official platform: cpu, gpio, timers, usart, SVD tags)
        //  2. stm32_mock.repl (our RCC + FLASH overrides — replaces the 4-byte SVD tag)
        const resc = [
            'using sysbus',
            '',
            `mach create "stm32-${this.buildId.slice(0, 8)}"`,
            '',
            `# Step 1: Load the official STM32F103 platform`,
            `machine LoadPlatformDescription ${STM32_PLATFORM_DESC}`,
            '',
            `# Step 2: Load our RCC + FLASH behavioral mock (overrides the SVD 4-byte tag)`,
            `machine LoadPlatformDescription @${replForRenode}`,
            '',
            `# Load the compiled Arduino ELF directly`,
            `sysbus LoadELF @${elfForRenode}`,
            '',
            `# Set CPU performance in MIPS to match the 72 MHz clock configuration`,
            `cpu PerformanceInMips 72`,
            '',
            `# Expose USART1 (Serial1 = PA9/PA10) as a buffered TCP server`,
            `# buffered=true: Renode queues UART output until our Node.js client connects`,
            `# (the firmware calls sim_ready() within ~200ms but TCP connects ~1.5s later)`,
            `emulation CreateServerSocketTerminal ${this._tcpPort} "term" true`,
            `connector Connect sysbus.usart1 term`,
            '',
            `# Start simulation`,
            `start`,
        ].join('\n');

        fs.writeFileSync(this._rescPath, resc, 'utf8');
        console.log(`[Renode:${this.buildId}] 📄 .resc script written → ${this._rescPath}`);
        console.log(`[Renode:${this.buildId}] 🔌 TCP port: ${this._tcpPort}`);
    }

    // ── Internal: process spawning ────────────────────────────────────────────

    _spawnRenode() {
        const args = [
            '--plain',           // no GUI / no interactive console
            '--disable-xwt',    // disable XWT GUI subsystem (headless)
            '--port', '0',      // disable / allocate random telnet monitor port to prevent collisions
            '-e',               // execute inline script
            `include @${this._rescPath}`,
        ];

        console.log(`[Renode:${this.buildId}] 🚀 Spawning: ${RENODE_PATH} ${args.join(' ')}`);

        this._renode = spawn(RENODE_PATH, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        this._renode.stdout.on('data', (d) => {
            const lines = d.toString().split('\n');
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                console.log(`[Renode:${this.buildId}] stdout: ${line}`);
                // Forward register access and sysbus warnings to the frontend
                if (line.includes('RCC') || line.includes('DWT') || line.includes('Flash') || line.includes('sysbus')) {
                    this.wsManager.sendToSession(this.buildId, {
                        type:    'SERIAL_OUTPUT',
                        buildId: this.buildId,
                        data:    `[SIM-REG] ${line}\n`,
                    });
                }
            }
        });

        this._renode.stderr.on('data', (d) => {
            const lines = d.toString().split('\n');
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                console.log(`[Renode:${this.buildId}] stderr: ${line}`);
                this.wsManager.sendToSession(this.buildId, {
                    type:    'SERIAL_OUTPUT',
                    buildId: this.buildId,
                    data:    `[SIM-STDERR] ${line}\n`,
                });
            }
        });

        this._renode.on('error', (err) => {
            this._logDebug(`❌ Process error: ${err.message}`);
            this.wsManager.sendToSession(this.buildId, {
                type: 'RUNTIME_ERROR',
                buildId: this.buildId,
                message: `Renode process error: ${err.message}. Is Renode installed and on PATH?`,
            });
            this._destroyed = true;
        });

        this._renode.on('exit', (code, signal) => {
            this._logDebug(`🏁 Renode exited (code=${code}, signal=${signal})`);
            if (!this._destroyed) {
                this.wsManager.sendToSession(this.buildId, {
                    type: 'SIMULATOR_STOPPED',
                    buildId: this.buildId,
                    code,
                });
            }
            this._closeSocket();
            this._destroyed = true;
        });

        // Wait for Renode to boot before connecting TCP
        setTimeout(() => {
            if (!this._destroyed) {
                this._connectTcp();
            }
        }, RENODE_BOOT_WAIT_MS);
    }

    // ── Internal: TCP connection to Renode UART server ────────────────────────

    _connectTcp() {
        if (this._destroyed) return;

        this._connectAttempts++;
        this._logDebug(`🔗 TCP connect attempt ${this._connectAttempts}/${RENODE_CONNECT_RETRIES} → port ${this._tcpPort}`);

        const socket = net.connect(this._tcpPort, 'localhost');
        socket.setNoDelay(true);

        socket.on('connect', () => {
            this._logDebug(`✅ TCP connected to Renode UART server. Sending Telnet greeting...`);
            this._socket = socket;
            this._connectAttempts = 0;
            this.lastActivity = Date.now();
            // Send our Telnet greeting immediately so Renode completes the
            // IAC option handshake and releases buffered UART data.
            socket.write(TELNET_GREETING);
        });

        socket.on('data', (chunk) => {
            this.lastActivity = Date.now();
            // Strip Telnet IAC sequences and respond to options;
            // the returned buffer contains only raw UART bytes.
            const data = this._handleTelnet(socket, chunk);
            if (data.length > 0) {
                this._parser.feed(data);
            }
        });

        socket.on('error', (err) => {
            if (this._destroyed) return;
            if (this._connectAttempts < RENODE_CONNECT_RETRIES) {
                // Renode not ready yet — retry after delay
                setTimeout(() => this._connectTcp(), RENODE_CONNECT_DELAY_MS);
            } else {
                this._logDebug(`❌ TCP failed after ${RENODE_CONNECT_RETRIES} attempts: ${err.message}`);
                this.wsManager.sendToSession(this.buildId, {
                    type: 'RUNTIME_ERROR',
                    buildId: this.buildId,
                    message: `Cannot connect to Renode UART TCP server on port ${this._tcpPort}. Renode may have crashed.`,
                });
                this._destroyed = true;
            }
        });

        socket.on('close', () => {
            if (!this._destroyed) {
                this._logDebug(`🔌 TCP socket closed`);
            }
            this._socket = null;
        });
    }

    /**
     * Parse one chunk of raw TCP data from Renode's Telnet server.
     * Strips all IAC command sequences, sends appropriate WILL/DO responses,
     * and returns a Buffer containing only the raw UART payload bytes.
     */
    _handleTelnet(socket, chunk) {
        const out = [];
        let i = 0;
        while (i < chunk.length) {
            if (chunk[i] !== T_IAC) {
                out.push(chunk[i++]);
                continue;
            }
            // IAC — need at least one more byte
            if (i + 1 >= chunk.length) { i++; break; }
            const cmd = chunk[i + 1];

            if (cmd === T_IAC) {
                // Escaped 0xFF — literal data byte
                out.push(0xFF);
                i += 2;
                continue;
            }

            if (cmd === T_SB) {
                // Subnegotiation block — skip until IAC SE
                i += 2;
                while (i < chunk.length - 1) {
                    if (chunk[i] === T_IAC && chunk[i + 1] === T_SE) { i += 2; break; }
                    i++;
                }
                continue;
            }

            if (cmd === T_WILL || cmd === T_WONT || cmd === T_DO || cmd === T_DONT) {
                if (i + 2 >= chunk.length) { i += 2; break; }
                const opt = chunk[i + 2];
                this._replyTelnet(socket, cmd, opt);
                i += 3;
                continue;
            }

            // Any other 2-byte command (NOP, DM, BRK, …) — skip
            i += 2;
        }
        return Buffer.from(out);
    }

    /**
     * Send the correct Telnet response for a received DO/WILL option.
     * We accept BINARY and SGA; refuse everything else.
     */
    _replyTelnet(socket, cmd, opt) {
        if (!socket || socket.destroyed) return;
        let reply;
        if (cmd === T_DO) {
            // Server asks us (client) to enable option
            const accept = (opt === T_OPT_BINARY || opt === T_OPT_SGA);
            reply = Buffer.from([T_IAC, accept ? T_WILL : T_WONT, opt]);
        } else if (cmd === T_WILL) {
            // Server offers to enable an option
            const accept = (opt === T_OPT_BINARY || opt === T_OPT_SGA);
            reply = Buffer.from([T_IAC, accept ? T_DO : T_DONT, opt]);
        }
        // WONT / DONT are terminations — no reply needed
        if (reply) {
            try { socket.write(reply); } catch (e) {/* ignore */}
        }
    }

    _closeSocket() {
        if (this._socket) {
            try { this._socket.destroy(); } catch (e) {/* ignore */}
            this._socket = null;
        }

    }

    // ── Internal: write to firmware via TCP UART ──────────────────────────────

    _sendToFirmware(data) {
        if (this._socket && !this._socket.destroyed) {
            try {
                this._socket.write(data + '\n');
            } catch (e) {
                console.warn(`[Renode:${this.buildId}] ⚠️  Send to firmware failed: ${e.message}`);
            }
        }
    }

    // ── Internal: parse incoming UART frames from firmware ────────────────────

    _handleFrame(frame) {
        this.lastActivity = Date.now();

        // >GPIO:PA5:1<
        if (frame.startsWith('GPIO:')) {
            const parts = frame.split(':');
            if (parts.length >= 3) {
                const pin   = parts[1];
                const value = parseInt(parts[2], 10);
                if (pin && !isNaN(value)) {
                    this.wsManager.sendToSession(this.buildId, {
                        type:    'GPIO_SYNC',
                        buildId: this.buildId,
                        pin,
                        value,
                    });
                }
            }
            return;
        }

        // >TONE:PA5:440:0<
        if (frame.startsWith('TONE:')) {
            const parts = frame.split(':');
            if (parts.length >= 3) {
                const pin   = parts[1];
                const frequency = parseInt(parts[2], 10);
                const duration  = parts[3] ? parseInt(parts[3], 10) : 0;
                if (pin && !isNaN(frequency)) {
                    this.wsManager.sendToSession(this.buildId, {
                        type:    'TONE',
                        buildId: this.buildId,
                        pin,
                        frequency,
                        duration,
                    });
                }
            }
            return;
        }

        // >SIM:READY<
        if (frame === 'SIM:READY') {
            this.isReady = true;
            console.log(`[Renode:${this.buildId}] ✅ SIM:READY received — firmware is running`);
            this.wsManager.sendToSession(this.buildId, {
                type:    'SIMULATOR_READY',
                buildId: this.buildId,
            });
            return;
        }

        // >SIM:BEAT<
        if (frame === 'SIM:BEAT') {
            // heartbeat — just update activity timestamp (already done above)
            return;
        }

        // >SIM:LOG:INFO:message<
        if (frame.startsWith('SIM:LOG:')) {
            const rest  = frame.slice('SIM:LOG:'.length);
            const colon = rest.indexOf(':');
            if (colon !== -1) {
                const level = rest.slice(0, colon);
                const msg   = rest.slice(colon + 1);
                this.wsManager.sendToSession(this.buildId, {
                    type:    'SERIAL_OUTPUT',
                    buildId: this.buildId,
                    data:    `[${level}] ${msg}\n`,
                });
            }
            return;
        }

        // >I2C:<addr_hex>:<data_hex><  — I2C write transaction
        if (frame.startsWith('I2C:')) {
            const parts = frame.split(':');
            if (parts.length >= 3) {
                const addr = parseInt(parts[1], 16);
                const hex  = parts[2] || '';
                if (!isNaN(addr)) {
                    const data = [];
                    for (let i = 0; i < hex.length; i += 2) {
                        data.push(parseInt(hex.slice(i, i + 2), 16));
                    }
                    this.wsManager.sendToSession(this.buildId, {
                        type:    'I2C_TRANSACTION',
                        buildId: this.buildId,
                        addr,
                        data,
                    });
                }
            }
            return;
        }

        // >I2C_READ:<addr_hex>:<qty_hex>< — I2C read request (firmware wants data)
        if (frame.startsWith('I2C_READ:')) {
            const parts = frame.split(':');
            if (parts.length >= 3) {
                const addr = parseInt(parts[1], 16);
                const qty  = parseInt(parts[2], 16);
                if (!isNaN(addr) && !isNaN(qty)) {
                    this.wsManager.sendToSession(this.buildId, {
                        type:    'I2C_READ_REQUEST',
                        buildId: this.buildId,
                        addr,
                        qty,
                    });
                }
            }
            return;
        }

        // >SPIBUF:<hex>< — SPI bulk write
        if (frame.startsWith('SPIBUF:')) {
            const hex = frame.slice('SPIBUF:'.length);
            const bin = Buffer.from(hex, 'hex');
            const b64 = bin.toString('base64');
            this.wsManager.sendToSession(this.buildId, {
                type:    'SPI_BATCH',
                buildId: this.buildId,
                b64,
            });
            return;
        }

        // Anything else is treated as raw serial output
        this.wsManager.sendToSession(this.buildId, {
            type:    'SERIAL_OUTPUT',
            buildId: this.buildId,
            data:    frame + '\n',
        });
    }
}
