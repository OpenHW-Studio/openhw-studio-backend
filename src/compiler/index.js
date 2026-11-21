/**
 * src/compiler/index.js — Compiler worker module barrel
 * ─────────────────────────────────────────────────────────────────────────────
 * The compiler-worker is a deployment shape, not a separate codebase:
 * the SAME express app boots in two roles.
 *
 *   ROLE=main      → full API (auth, classroom, projects, …) + proxies
 *                    compile execution paths to the compiler-worker over HTTP.
 *                    Library search/admin stays local (shared volume + index).
 *   ROLE=compiler  → ONLY /api/compile/* (+ /health). Owns arduino-cli,
 *                    the library pool (permanent + cache), the result cache,
 *                    and all build workspaces. No MongoDB connection.
 *
 * Local dev (no ROLE set) runs everything in one process, exactly as before.
 *
 * Exports:
 *   isCompilerRole()            — true when ROLE=compiler
 *   isMainRole()                — true when ROLE=main
 *   isSingleService()           — true when ROLE is unset (local dev)
 *   initCompilerModule(app)     — mount /api/compile on a compiler-role app
 *   proxyCompileToWorker        — main-role proxy for compile execution paths
 */

import compileRoutes from '../routes/compile.js';

const COMPILER_UPSTREAM = () => {
    const configured = String(process.env.COMPILER_WORKER_HTTP_URL || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    // In docker compose the worker is reachable by service name; in local dev
    // the compiler usually runs on 5001 next to the main backend.
    if (process.env.NODE_ENV === 'production') return 'http://compiler-worker:5001';
    return 'http://localhost:5001';
};

export const isCompilerRole = () => process.env.ROLE === 'compiler';
export const isMainRole = () => process.env.ROLE === 'main';
export const isSingleService = () => !process.env.ROLE;

/**
 * Mount ONLY the compile router on this express app.
 * Used by the compiler-worker role (and single-service dev boot).
 */
export function initCompilerModule(app) {
    app.use('/api/compile', compileRoutes);
}

/**
 * Proxy a compile execution request to the compiler-worker.
 * Mount-relative: inside the /api router, req.url is e.g.
 * '/compile/ports?showAll=true' → upstream '/api/compile/ports?showAll=true'.
 * Auth header is forwarded; the worker enforces its own route middleware.
 *
 * Retry policy (per user decision): up to 3 attempts in a row, ~300 ms
 * apart, then give up with 502. Retries cover transient worker restarts /
 * deploys — NOT queued compiles (those 503 immediately, see resourceManager).
 * Only network-level failures and 502/503/504 are retried; any other
 * worker response (4xx compile errors included) is returned as-is.
 */
const PROXY_MAX_ATTEMPTS = Math.max(1, Number(process.env.COMPILER_PROXY_ATTEMPTS || 3));
const PROXY_RETRY_DELAY_MS = Math.max(0, Number(process.env.COMPILER_PROXY_RETRY_MS || 300));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const proxyCompileToWorker = async (req, res) => {
    const upstream = `${COMPILER_UPSTREAM()}/api${req.url}`;
    const headers = { 'Content-Type': 'application/json' };
    const auth = req.headers.authorization;
    if (auth) headers.Authorization = auth;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody ? JSON.stringify(req.body ?? {}) : undefined;

    let lastErr = null;
    for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(upstream, {
                method: req.method,
                headers,
                body,
            });

            // Retry transient upstream failures; pass everything else through.
            if ([502, 503, 504].includes(response.status) && attempt < PROXY_MAX_ATTEMPTS) {
                lastErr = new Error(`Upstream ${response.status}`);
                console.warn(`[Compiler Proxy] Attempt ${attempt}/${PROXY_MAX_ATTEMPTS} got ${response.status}, retrying…`);
                await sleep(PROXY_RETRY_DELAY_MS);
                continue;
            }

            const contentType = response.headers.get('content-type') || '';
            res.status(response.status);
            if (contentType.includes('application/json')) {
                const data = await response.json();
                return res.json(data);
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (contentType) res.setHeader('Content-Type', contentType);
            const disposition = response.headers.get('content-disposition');
            if (disposition) res.setHeader('Content-Disposition', disposition);
            return res.send(buffer);
        } catch (err) {
            lastErr = err;
            if (attempt < PROXY_MAX_ATTEMPTS) {
                console.warn(`[Compiler Proxy] Attempt ${attempt}/${PROXY_MAX_ATTEMPTS} failed (${err?.message || err}), retrying…`);
                await sleep(PROXY_RETRY_DELAY_MS);
                continue;
            }
        }
    }

    console.error(`[Compiler Proxy] All ${PROXY_MAX_ATTEMPTS} attempts failed for ${upstream}:`, lastErr?.message || lastErr);
    return res.status(502).json({
        error: 'Compiler worker is offline or unavailable.',
        details: lastErr?.message || 'Upstream fetch failed.',
    });
};

// Back-compat aliases (api.js may reference either name).
export const handleCompileProxy = proxyCompileToWorker;
export const handleCompileSubpathProxy = proxyCompileToWorker;
