/**
 * paths.js — src/compiler/paths.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for the backend data root (library pool, compile
 * cache support files, calibration budget, classroom assets).
 *
 *   DATA_ROOT env (optional) — absolute path, or relative to the backend
 *     root (openhw-studio-backend/). When unset, defaults to
 *     <backend-root>/data, which in Docker is /app/data (the persistent
 *     volume) and in local dev is openhw-studio-backend/data.
 *
 * Why this exists: the library pool was previously resolved with
 * `../../../data` from src/services + src/controllers, which lands on
 * <repo>/data in local dev but on `/data` (unpersisted root fs) inside
 * Docker. Everything now goes through getDataRoot().
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path of openhw-studio-backend/ regardless of cwd. */
export function getBackendRoot() {
    return path.resolve(__dirname, '../..');
}

/** Absolute data root honoring DATA_ROOT. */
export function getDataRoot() {
    const configured = String(process.env.DATA_ROOT || '').trim();
    if (configured) {
        return path.isAbsolute(configured)
            ? configured
            : path.resolve(getBackendRoot(), configured);
    }
    return path.join(getBackendRoot(), 'data');
}

export function getLibrariesRoot() {
    return path.join(getDataRoot(), 'libraries');
}

export function getPermanentDir() {
    return path.join(getLibrariesRoot(), 'permanent');
}

export function getCacheDir() {
    return path.join(getLibrariesRoot(), 'cache');
}

export function getLibraryIndexDir() {
    return path.join(getLibrariesRoot());
}

export function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
}
