/**
 * networkProxy.js  —  src/esp32/utils/networkProxy.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js TCP proxy that bridges QEMU's simulated UART1 serial line to the
 * real internet on behalf of the ESP32 firmware.
 *
 * Architecture:
 *   QEMU UART1  ──TCP──►  NetworkProxy.uartServer (random port)
 *   NetworkProxy  ──TCP──►  real internet (outbound) / 0.0.0.0 (inbound)
 *
 * Binary framing protocol over UART1:
 *
 *   Firmware → Node.js  (SimulatorWiFi.h writes):
 *     \x01  <connId>:<command>[:<payload>]  \x02 \n
 *
 *   Node.js → Firmware  (proxy writes back):
 *     \x03  <connId>:<response>[:<payload>]  \x04 \n
 *
 * Connection IDs (connId) are 1–8.  connId 0 is reserved for global control
 * messages (WIFI_READY, SERVER_LISTEN, SERVER_CLOSE).
 *
 * Commands (firmware → proxy):
 *   CONNECT      <host>:<port>   — open a plain TCP socket
 *   TLS_CONNECT  <host>:<port>   — open a TLS socket (proxy handles the TLS)
 *   WRITE        <hex>           — send data on an existing socket
 *   CLOSE                        — close a socket
 *   SERVER_LISTEN  <port>        — start an inbound TCP listener
 *   SERVER_CLOSE   <port>        — stop a listener
 *
 * Responses (proxy → firmware):
 *   CONN_OK              — connection established
 *   CONN_FAIL            — connection refused / timeout
 *   DATA:<hex>           — incoming data from remote
 *   EOF                  — remote closed the connection
 *   INCOMING_CLIENT:<id> — inbound connection assigned id
 */

import net from 'net';
import tls from 'tls';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of simultaneous socket connections (matches SimulatorWiFi.h). */
const MAX_CONN_IDS = 8;

/**
 * Maximum binary frame size (bytes) in the UART1 stream.
 * Frames larger than this indicate protocol corruption; they are discarded.
 */
const MAX_FRAME_SIZE = 64 * 1024; // 64 KiB

/**
 * Connection timeout for outbound sockets (ms).
 * Prevents hung connection attempts from holding a connId slot.
 */
const SOCKET_CONNECT_TIMEOUT_MS = 15_000;

// ─── NetworkProxy ──────────────────────────────────────────────────────────────

export default class NetworkProxy {
    /**
     * @param {string}   buildId    - Session UUID (used in log prefixes).
     * @param {function} onReady    - Called with the bound TCP port once listening.
     */
    constructor(buildId, onReady) {
        this.buildId         = buildId;
        this._onReady        = onReady;

        /** @type {net.Server|null} Master server that QEMU connects to */
        this._uartServer  = null;

        /** @type {net.Socket|null} The single QEMU UART1 socket */
        this._qemuSocket  = null;

        /** @type {Map<number, net.Socket|tls.TLSSocket>} connId → real TCP socket */
        this._sockets     = new Map();

        /** @type {Map<number, net.Server>} port → inbound server */
        this._servers     = new Map();

        /** Incomplete frame accumulator for the UART1 byte stream */
        this._rxBuf       = '';

        this._proxyPort   = 0;
        this._destroyed   = false;
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * start() — Create the UART1 listener.  When bound successfully,
     * calls onReady(port) so QemuRunner knows which port to pass to QEMU.
     */
    start() {
        this._uartServer = net.createServer((socket) => {
            if (this._qemuSocket) {
                // Only one QEMU per proxy instance; reject duplicates
                console.warn(`[NetProxy:${this._buildPrefix}] Duplicate UART1 connection — rejecting`);
                socket.destroy();
                return;
            }

            console.log(`[NetProxy:${this._buildPrefix}] 🌐 QEMU UART1 connected`);
            this._qemuSocket = socket;

            socket.setEncoding('utf8'); // frames are ASCII/hex, never raw binary on UART
            socket.on('data',  (data) => this._handleUartData(data));
            socket.on('close', ()     => this._handleQemuDisconnect());
            socket.on('error', (err)  => {
                console.error(`[NetProxy:${this._buildPrefix}] UART1 socket error:`, err.message);
            });
        });

        this._uartServer.on('error', (err) => {
            console.error(`[NetProxy:${this._buildPrefix}] UART server error:`, err.message);
        });

        this._uartServer.listen(0, '127.0.0.1', () => {
            this._proxyPort = this._uartServer.address().port;
            console.log(
                `[NetProxy:${this._buildPrefix}] 🌐 Proxy listening on port ${this._proxyPort}`,
            );
            if (this._onReady) this._onReady(this._proxyPort);
        });
    }

    /** stop() — Tear down all sockets and servers cleanly. */
    stop() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._cleanup();
    }

    // ─── UART1 framing ───────────────────────────────────────────────────────

    /**
     * Accumulate UART1 bytes and extract complete \x01…\x02 frames.
     *
     * The frame delimiter is:
     *   SOH (\x01) ... ETX (\x02) \n
     *
     * Junk bytes before the first SOH are silently discarded.
     * Frames larger than MAX_FRAME_SIZE are discarded (protocol error guard).
     */
    _handleUartData(data) {
        this._rxBuf += data;

        // Safety: prevent unbounded buffer growth
        if (this._rxBuf.length > MAX_FRAME_SIZE * 2) {
            console.warn(
                `[NetProxy:${this._buildPrefix}] RX buffer overflow — flushing`,
            );
            this._rxBuf = '';
            return;
        }

        const SOH = '\x01';
        const ETX = '\x02';

        while (true) {
            const startIdx = this._rxBuf.indexOf(SOH);
            if (startIdx === -1) {
                // No SOH found — discard junk
                this._rxBuf = '';
                break;
            }

            const endIdx = this._rxBuf.indexOf(ETX, startIdx + 1);
            if (endIdx === -1) {
                // Incomplete frame — wait for more data
                // Trim any junk before the SOH to keep the buffer small
                if (startIdx > 0) this._rxBuf = this._rxBuf.slice(startIdx);
                break;
            }

            const frame = this._rxBuf.slice(startIdx + 1, endIdx);
            this._rxBuf = this._rxBuf.slice(endIdx + 1);

            if (frame.length > MAX_FRAME_SIZE) {
                console.warn(`[NetProxy:${this._buildPrefix}] Oversized frame (${frame.length} bytes) — discarding`);
                continue;
            }

            this._processFrame(frame);
        }
    }

    /**
     * Parse frame content: "<connId>:<command>[:<payload>]"
     */
    _processFrame(frame) {
        const c1 = frame.indexOf(':');
        if (c1 < 0) return;

        const connId  = parseInt(frame.slice(0, c1), 10);
        const rest    = frame.slice(c1 + 1);

        const c2      = rest.indexOf(':');
        const command = c2 < 0 ? rest             : rest.slice(0, c2);
        const payload = c2 < 0 ? ''               : rest.slice(c2 + 1);

        if (isNaN(connId)) return;

        if (connId === 0) {
            this._handleGlobalCmd(command, payload);
        } else {
            this._handleSocketCmd(connId, command, payload);
        }
    }

    // ─── Global commands (connId 0) ──────────────────────────────────────────

    _handleGlobalCmd(cmd, payload) {
        switch (cmd) {
            case 'WIFI_READY':
                console.log(`[NetProxy:${this._buildPrefix}] 📡 SimulatorWiFi stack ready`);
                break;

            case 'SERVER_LISTEN': {
                const port = parseInt(payload, 10);
                if (isNaN(port) || port < 1 || port > 65535) {
                    console.warn(`[NetProxy:${this._buildPrefix}] Invalid SERVER_LISTEN port: ${payload}`);
                    break;
                }
                this._startInboundServer(port);
                break;
            }

            case 'SERVER_CLOSE': {
                const port = parseInt(payload, 10);
                const srv  = this._servers.get(port);
                if (srv) {
                    srv.close(() => {
                        console.log(`[NetProxy:${this._buildPrefix}] 🛑 Inbound server on port ${port} closed`);
                    });
                    this._servers.delete(port);
                }
                break;
            }

            default:
                console.warn(`[NetProxy:${this._buildPrefix}] Unknown global cmd: ${cmd}`);
        }
    }

    // ─── Per-socket commands (connId 1–8) ────────────────────────────────────

    _handleSocketCmd(connId, cmd, payload) {
        switch (cmd) {
            case 'CONNECT':
            case 'TLS_CONNECT':
                this._openSocket(connId, payload, cmd === 'TLS_CONNECT');
                break;

            case 'WRITE': {
                const sock = this._sockets.get(connId);
                if (sock && !sock.destroyed) {
                    const buf = Buffer.from(payload, 'hex');
                    if (buf.length > 0) sock.write(buf);
                }
                break;
            }

            case 'CLOSE': {
                const sock = this._sockets.get(connId);
                if (sock) {
                    sock.end();
                    this._sockets.delete(connId);
                }
                break;
            }

            default:
                console.warn(
                    `[NetProxy:${this._buildPrefix}] Unknown socket cmd on id=${connId}: ${cmd}`,
                );
        }
    }

    // ─── Outbound socket management ──────────────────────────────────────────

    /**
     * Open a new TCP or TLS socket to <host>:<port> and map it to connId.
     * A connection timeout prevents held connId slots.
     */
    _openSocket(connId, payload, isTls) {
        const parts = payload.split(':');
        if (parts.length < 2) {
            console.warn(`[NetProxy:${this._buildPrefix}] Malformed CONNECT payload: ${payload}`);
            this._sendToUart(connId, 'CONN_FAIL', '');
            return;
        }

        const host = parts[0];
        const port = parseInt(parts[1], 10);

        if (!host || isNaN(port) || port < 1 || port > 65535) {
            console.warn(`[NetProxy:${this._buildPrefix}] Invalid host/port: ${host}:${port}`);
            this._sendToUart(connId, 'CONN_FAIL', '');
            return;
        }

        console.log(
            `[NetProxy:${this._buildPrefix}] 🔗 Opening ${isTls ? 'TLS' : 'TCP'} socket to ` +
            `${host}:${port} [id=${connId}]`,
        );

        let sock;
        if (isTls) {
            // rejectUnauthorized=false so test/self-signed certs work in the simulator.
            // The Node.js host still performs its own TLS validation.
            sock = tls.connect(
                { host, port, rejectUnauthorized: false },
                () => this._sendToUart(connId, 'CONN_OK', ''),
            );
        } else {
            sock = net.connect(
                { host, port },
                () => this._sendToUart(connId, 'CONN_OK', ''),
            );
        }

        // Apply connection timeout
        sock.setTimeout(SOCKET_CONNECT_TIMEOUT_MS, () => {
            console.warn(
                `[NetProxy:${this._buildPrefix}] Socket [id=${connId}] connect timeout`,
            );
            sock.destroy();
            this._sendToUart(connId, 'CONN_FAIL', '');
            this._sockets.delete(connId);
        });

        sock.on('data', (buf) => {
            // Hex-encode to protect UART framing delimiters in the data path
            const hex = buf.toString('hex').toUpperCase();
            this._sendToUart(connId, `DATA:${hex}`, '');
        });

        sock.on('close', () => {
            this._sendToUart(connId, 'EOF', '');
            this._sockets.delete(connId);
        });

        sock.on('error', (err) => {
            console.error(
                `[NetProxy:${this._buildPrefix}] Socket [id=${connId}] error:`, err.message,
            );
            this._sendToUart(connId, 'CONN_FAIL', '');
            this._sockets.delete(connId);
        });

        this._sockets.set(connId, sock);
    }

    // ─── Inbound server management ────────────────────────────────────────────

    /**
     * Start a TCP server listening on internalPort.
     * Inbound connections are assigned the next free connId (1–8) and the
     * firmware is notified via INCOMING_CLIENT:<id>.
     *
     * Security note: binds to 127.0.0.1 (loopback only).
     * Change to 0.0.0.0 only for intentional internet-facing deployments.
     */
    _startInboundServer(internalPort) {
        if (this._servers.has(internalPort)) return; // already listening

        const srv = net.createServer((incoming) => {
            const newId = this._allocConnId();
            if (newId === -1) {
                console.warn(
                    `[NetProxy:${this._buildPrefix}] No free connId for inbound on port ${internalPort} — rejecting`,
                );
                incoming.end();
                return;
            }

            console.log(
                `[NetProxy:${this._buildPrefix}] 📥 Inbound connection on port ${internalPort} → id=${newId}`,
            );
            this._sockets.set(newId, incoming);

            incoming.on('data', (buf) => {
                const hex = buf.toString('hex').toUpperCase();
                this._sendToUart(newId, `DATA:${hex}`, '');
            });

            incoming.on('close', () => {
                this._sendToUart(newId, 'EOF', '');
                this._sockets.delete(newId);
            });

            incoming.on('error', () => {
                this._sendToUart(newId, 'EOF', '');
                this._sockets.delete(newId);
            });

            // Notify the firmware
            this._sendToUart(0, `INCOMING_CLIENT:${newId}`, '');
        });

        srv.listen(internalPort, '127.0.0.1', () => {
            console.log(
                `[NetProxy:${this._buildPrefix}] 👂 Inbound server listening on 127.0.0.1:${internalPort}`,
            );
        });

        srv.on('error', (err) => {
            console.error(
                `[NetProxy:${this._buildPrefix}] Inbound server error on port ${internalPort}:`,
                err.message,
            );
            this._servers.delete(internalPort);
        });

        this._servers.set(internalPort, srv);
    }

    // ─── UART1 serialisation ─────────────────────────────────────────────────

    /**
     * Send a frame to the QEMU firmware over UART1.
     * Format: \x03 <connId>:<msg> \x04 \n
     *
     * payload may be empty ('') for simple state-change messages.
     */
    _sendToUart(connId, command, payload) {
        if (!this._qemuSocket || this._qemuSocket.destroyed) return;

        const msg = payload && payload.length > 0 ? `${command}:${payload}` : command;
        const out = `\x03${connId}:${msg}\x04\n`;

        try {
            this._qemuSocket.write(out);
        } catch (e) {
            console.warn(`[NetProxy:${this._buildPrefix}] Write to UART failed:`, e.message);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /** Find the lowest free connId in 1..MAX_CONN_IDS, or -1 if all busy. */
    _allocConnId() {
        for (let id = 1; id <= MAX_CONN_IDS; id++) {
            if (!this._sockets.has(id)) return id;
        }
        return -1;
    }

    get _buildPrefix() {
        return this.buildId.substring(0, 8);
    }

    _handleQemuDisconnect() {
        console.log(`[NetProxy:${this._buildPrefix}] QEMU UART1 disconnected`);
        this._qemuSocket = null;
        // Do NOT call _cleanup() here! QemuRunner might restart the QEMU process
        // to recover from a crash. If we clean up the listening server, QEMU will
        // fail to connect on reboot. We only cleanup when stop() is explicitly called.
    }

    _cleanup() {
        if (this._uartServer) {
            this._uartServer.close();
            this._uartServer = null;
        }

        if (this._qemuSocket) {
            try { this._qemuSocket.destroy(); } catch { /* best-effort */ }
            this._qemuSocket = null;
        }

        // Destroy all outbound / inbound sockets
        for (const sock of this._sockets.values()) {
            if (!sock.destroyed) {
                try { sock.destroy(); } catch { /* best-effort */ }
            }
        }
        this._sockets.clear();

        // Close all inbound servers
        for (const srv of this._servers.values()) {
            try { srv.close(); } catch { /* best-effort */ }
        }
        this._servers.clear();

        console.log(`[NetProxy:${this._buildPrefix}] 🧹 NetworkProxy cleaned up`);
    }
}
