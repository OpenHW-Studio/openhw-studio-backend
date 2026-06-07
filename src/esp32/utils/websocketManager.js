/**
 * websocketManager.js  —  src/esp32/utils/websocketManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Singleton WebSocket session manager for the ESP32 QEMU bridge.
 *
 * Design goals:
 *   1. Zero message loss — messages produced before the browser's WS handshake
 *      completes are buffered and flushed when the client registers.
 *   2. Back-pressure guard — pending buffers are bounded to prevent memory
 *      exhaustion when clients connect very slowly or not at all.
 *   3. Safe multi-session isolation — each buildId owns exactly one WS socket.
 *   4. Graceful cleanup — stale pending buffers are reaped by a GC timer.
 *
 * Message flow:
 *   1. compileController calls createPendingSession(buildId) immediately.
 *   2. QemuRunner calls sendToSession(buildId, msg) — buffered if no WS yet.
 *   3. Client opens WS and sends { type: 'REGISTER_SESSION', buildId }.
 *   4. Manager flushes the buffer in order and maps the live socket.
 *   5. All subsequent sends go directly to the socket.
 */

import WebSocket, { WebSocketServer } from 'ws';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of messages buffered per session (prevents OOM). */
const MAX_PENDING_BUFFER = 32768;

/**
 * Maximum age (ms) of a pending buffer whose client never showed up.
 * Reaped by the GC interval below.
 */
const PENDING_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** How often to scan for orphaned pending buffers. */
const PENDING_GC_INTERVAL_MS = 60 * 1000; // 1 minute

// ─── WebSocketManager singleton ────────────────────────────────────────────────

class WebSocketManager {
    constructor() {
        // Enforce singleton pattern
        if (WebSocketManager._instance) return WebSocketManager._instance;

        /** @type {WebSocketServer|null} */
        this.wss = null;

        /**
         * Map<buildId, WebSocket>
         * Stores the LIVE socket for each registered session.
         */
        this._sessions = new Map();

        /**
         * Map<WebSocket, buildId>
         * Reverse lookup used to clean up sessions on WS close.
         */
        this._wsToSession = new Map();

        /**
         * Map<buildId, { msgs: Array, createdAt: number }>
         * Pre-registration message buffer.
         * Created by createPendingSession() so QEMU output is never dropped
         * between compile-response and WS open.
         */
        this._pending = new Map();

        /**
         * Listeners registered before init() is called.
         * Flushed to the real WSSServer once it is available.
         */
        this._earlyListeners = [];

        /**
         * Map<buildId, string>
         * Stores target engine ('esp32' or 'stm32') for each session.
         */
        this._buildIdToTarget = new Map();

        // Start orphan-buffer GC
        const gcTimer = setInterval(() => this._gcPendingBuffers(), PENDING_GC_INTERVAL_MS);
        gcTimer.unref(); // Don't prevent process exit

        WebSocketManager._instance = this;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialisation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Attach the WebSocket server to the HTTP server.
     * Must be called exactly once, after express is wired up.
     *
     * @param {import('http').Server} httpServer
     */
    init(httpServer) {
        if (this.wss) {
            console.warn('[WSManager] init() called more than once — ignoring duplicate');
            return;
        }

        this.wss = new WebSocketServer({ server: httpServer });
 
        this.wss.on('connection', (ws, req) => {
            const clientIp = req.socket.remoteAddress || 'unknown';
            console.log(`[WSManager] 📡 Client connected (ip=${clientIp})`);
 
            ws.on('close', (code, reason) => {
                console.log(
                    `[WSManager] 📡 Client disconnected (code=${code}, reason=${reason?.toString() || 'n/a'})`,
                );
                this._handleSocketClose(ws);
            });
 
            ws.on('error', (err) => {
                // Log WS-level errors; the 'close' event fires right after so
                // cleanup is handled there.
                console.error('[WSManager] WebSocket error:', err.message);
            });
 
            if (process.env.ROLE === 'main') {
                const checkProxyHandler = (rawMsg) => {
                    let data;
                    try { data = JSON.parse(rawMsg.toString()); } catch { return; }
                    
                    if (data.type === 'REGISTER_SESSION' && data.buildId) {
                        const target = this.getTarget(data.buildId);
                        if (target === 'esp32' || target === 'stm32') {
                            ws.off('message', checkProxyHandler);
                            this.proxySession(ws, data.buildId, target);
                            return;
                        }
                    }
                    
                    ws.off('message', checkProxyHandler);
                    this._fireEarlyListeners(ws);
                };
                ws.on('message', checkProxyHandler);
            } else {
                this._fireEarlyListeners(ws);
            }
        });
 
        console.log('[WSManager] 🚀 WebSocket server initialised');
    }

    _fireEarlyListeners(ws) {
        for (const cb of this._earlyListeners) {
            try { cb(ws); } catch (e) {
                console.error('[WSManager] Error in connection listener:', e);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Session lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * createPendingSession(buildId)
     *
     * Call this the instant a compile request arrives — before any async I/O.
     * Opens a pre-registration message buffer so QEMU output is never lost
     * even if the browser WS connection lags behind compilation.
     *
     * Idempotent — safe to call twice for the same buildId.
     */
    createPendingSession(buildId) {
        if (this._pending.has(buildId)) return; // already created
        this._pending.set(buildId, { msgs: [], createdAt: Date.now() });
        console.log(`[WSManager] 📦 Pending buffer opened for session ${buildId}`);
    }

    /**
     * registerSession(ws, buildId)
     *
     * Called when the browser sends { type: 'REGISTER_SESSION', buildId }.
     * Maps the live WebSocket, flushes the pending buffer in order, then
     * deletes the buffer.
     *
     * If a previous socket existed for this buildId it is unlinked (the new
     * socket takes over — handles page refresh mid-session).
     */
    registerSession(ws, buildId) {
        // Unlink any stale socket for this session
        const prev = this._sessions.get(buildId);
        if (prev && prev !== ws) {
            this._wsToSession.delete(prev);
            console.log(`[WSManager] 🔄 Replaced stale WS socket for session ${buildId}`);
        }

        this._sessions.set(buildId, ws);
        this._wsToSession.set(ws, buildId);
        console.log(`[WSManager] 🔗 Session ${buildId} registered`);

        // Flush buffered messages in chronological order
        const entry = this._pending.get(buildId);
        if (entry && entry.msgs.length > 0) {
            console.log(`[WSManager] 📤 Flushing ${entry.msgs.length} buffered msg(s) for ${buildId}`);
            for (const payload of entry.msgs) {
                this._safeSend(ws, payload);
            }
        }
        this._pending.delete(buildId);
    }

    /**
     * unregisterSession(buildId)
     *
     * Called by QemuRunner (via compileController) when QEMU exits or the
     * session is explicitly stopped.
     *
     * If a pending buffer still exists and is non-empty it is left in place —
     * the grace-period setTimeout in compileController will call us again
     * after the browser has had a chance to register and flush the buffer.
     */
    unregisterSession(buildId) {
        const ws = this._sessions.get(buildId);
        if (ws) this._wsToSession.delete(ws);
        this._sessions.delete(buildId);

        // Only remove the pending buffer if it has been flushed (empty) or
        // was never created.  Non-empty buffers are kept for the grace period.
        const entry = this._pending.get(buildId);
        if (!entry || entry.msgs.length === 0) {
            this._pending.delete(buildId);
        }

        console.log(`[WSManager] 🧹 Session ${buildId} unregistered`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sending
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * sendToSession(buildId, payload)
     *
     * Primary send method used by QemuRunner.
     *
     * Priority:
     *   1. If a live OPEN socket exists → send immediately.
     *   2. If a pending buffer exists → append (with overflow guard).
     *   3. Otherwise → silently discard (session already cleaned up).
     */
    sendToSession(buildId, payload) {
        const ws = this._sessions.get(buildId);
        if (ws && ws.readyState === ws.OPEN) {
            this._safeSend(ws, payload);
            return;
        }

        const entry = this._pending.get(buildId);
        if (entry) {
            if (entry.msgs.length >= MAX_PENDING_BUFFER) {
                // Drop the oldest message to make room (ring-buffer behaviour)
                entry.msgs.shift();
                
                const now = Date.now();
                if (!entry.lastOverflowLog || now - entry.lastOverflowLog > 5000) {
                    console.warn(
                        `[WSManager] ⚠️  Pending buffer overflow for ${buildId} — oldest message dropped`,
                    );
                    entry.lastOverflowLog = now;
                }
            }
            entry.msgs.push(payload);
        }
        // If neither ws nor buffer exists, the session was already cleaned up — discard silently.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * hasPendingSession(buildId)
     * @returns {boolean} true if a pre-registration buffer exists for buildId.
     */
    hasPendingSession(buildId) {
        return this._pending.has(buildId);
    }

    /**
     * hasLiveSession(buildId)
     * @returns {boolean} true if a live registered socket exists for buildId.
     */
    hasLiveSession(buildId) {
        return this._sessions.has(buildId);
    }

    /**
     * onClientConnection(callback)
     *
     * Register a listener that fires for every new WS connection.
     * Safe to call before init() — buffered and replayed once WSSServer exists.
     *
     * @param {(ws: WebSocket) => void} callback
     */
    onClientConnection(callback) {
        // Always push to earlyListeners — it acts as the canonical list.
        // The wss.on('connection') handler above iterates it on each connection.
        this._earlyListeners.push(callback);
    }

    /**
     * broadcast(payload)
     *
     * Send a message to ALL connected clients.
     * Kept for non-session system notifications (e.g., server maintenance).
     */
    broadcast(payload) {
        if (!this.wss) return;
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        for (const client of this.wss.clients) {
            if (client.readyState === client.OPEN) {
                try { client.send(data); } catch { /* client may have just closed */ }
            }
        }
    }

    /**
     * getStats()
     * @returns {{ liveSessions: number, pendingSessions: number, totalClients: number }}
     */
    getStats() {
        return {
            liveSessions:    this._sessions.size,
            pendingSessions: this._pending.size,
            totalClients:    this.wss ? this.wss.clients.size : 0,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────

    setTarget(buildId, target) {
        this._buildIdToTarget.set(buildId, target);
        console.log(`[WSManager] 🎯 Set target of ${buildId} to ${target}`);
    }

    getTarget(buildId) {
        return this._buildIdToTarget.get(buildId);
    }

    proxySession(ws, buildId, target) {
        console.log(`[WSManager] 🔀 Proxying session ${buildId} to ${target} worker`);
        
        const workerUrl = target === 'esp32' 
            ? (process.env.ESP32_WORKER_WS_URL || 'ws://esp32-worker:5001')
            : (process.env.STM32_WORKER_WS_URL || 'ws://stm32-worker:5002');
            
        const workerWs = new WebSocket(workerUrl);
        
        // Track the worker socket so we can close it if the client disconnects
        this._sessions.set(buildId, ws);
        this._wsToSession.set(ws, buildId);
        
        workerWs.on('open', () => {
            console.log(`[WSManager] 🔌 Connected to ${target} worker for session ${buildId}`);
            // Send register session to the worker
            workerWs.send(JSON.stringify({ type: 'REGISTER_SESSION', buildId }));
        });
        
        // Pipe client -> worker (ensuring text string format)
        ws.on('message', (rawMsg) => {
            if (workerWs.readyState === WebSocket.OPEN) {
                workerWs.send(rawMsg.toString('utf8'));
            }
        });
        
        // Pipe worker -> client (ensuring text string format so browser WebSocket client parses as text frame)
        workerWs.on('message', (rawMsg) => {
            if (ws.readyState === 1) { // 1 is OPEN for client ws
                ws.send(rawMsg.toString('utf8'));
            }
        });
        
        workerWs.on('close', () => {
            console.log(`[WSManager] 🔌 Worker socket closed for session ${buildId}`);
            ws.close();
        });
        
        workerWs.on('error', (err) => {
            console.error(`[WSManager] Worker socket error for session ${buildId}:`, err.message);
            ws.close();
        });
        
        ws.on('close', () => {
            console.log(`[WSManager] 📡 Client socket closed for session ${buildId}`);
            if (workerWs.readyState === WebSocket.OPEN || workerWs.readyState === WebSocket.CONNECTING) {
                workerWs.close();
            }
        });
    }

    /** Serialize and send; swallows errors so one bad client never crashes the server. */
    _safeSend(ws, payload) {
        try {
            ws.send(JSON.stringify(payload));
        } catch (e) {
            console.warn('[WSManager] Failed to send to client:', e.message);
        }
    }

    /** Remove the session mapping when a socket closes. */
    _handleSocketClose(ws) {
        const buildId = this._wsToSession.get(ws);
        if (buildId) {
            this._sessions.delete(buildId);
            this._wsToSession.delete(ws);
            console.log(
                `[WSManager] 🧹 Session ${buildId} removed from live map (socket closed)`,
            );
        }
    }

    /**
     * Reap pending buffers that are older than PENDING_SESSION_TTL_MS.
     * These are sessions where QEMU produced output but the browser never connected.
     */
    _gcPendingBuffers() {
        const now = Date.now();
        for (const [buildId, entry] of this._pending.entries()) {
            if (now - entry.createdAt > PENDING_SESSION_TTL_MS) {
                this._pending.delete(buildId);
                console.log(
                    `[WSManager] 🗑️  GC: pending buffer for ${buildId} expired after TTL`,
                );
            }
        }
    }
}

// Export the singleton instance
const instance = new WebSocketManager();
export default instance;
