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

import { WebSocketServer } from 'ws';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of messages buffered per session (prevents OOM). */
const MAX_PENDING_BUFFER = 512;

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

            // Fire any listeners registered via onClientConnection()
            for (const cb of this._earlyListeners) {
                try { cb(ws); } catch (e) {
                    console.error('[WSManager] Error in connection listener:', e);
                }
            }
        });

        console.log('[WSManager] 🚀 WebSocket server initialised');
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
                console.warn(
                    `[WSManager] ⚠️  Pending buffer overflow for ${buildId} — oldest message dropped`,
                );
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
