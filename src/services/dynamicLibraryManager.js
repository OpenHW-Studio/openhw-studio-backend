/**
 * dynamicLibraryManager.js  —  src/services/dynamicLibraryManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the two-tier library pool:
 *
 *   permanent/  — Pre-installed libraries listed in src/config/libraries.json.
 *                 Downloaded once on server boot, never pruned.
 *
 *   cache/      — Dynamically fetched libraries (latest or specific versions).
 *                 Subject to a 512 MB LRU prune cycle.
 *                 Versioned entries stored under cache/<Name>@<version>/.
 *
 * Public API:
 *   syncPermanentLibraries()               — called once at server boot
 *   fetchAndExtractLibrary(name, dir, ver) — low-level single-library fetch
 *   ensureLibrariesForCompile(entries)     — called before every compilation
 *                                           returns ordered --libraries paths
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { execFile } from 'child_process';
import util from 'util';
import { getLibraryMetadata } from './libraryIndexService.js';

const execFileAsync = util.promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR      = path.resolve(__dirname, '../../../data');
const CACHE_DIR     = path.join(DATA_DIR, 'libraries/cache');
const PERM_DIR      = path.join(DATA_DIR, 'libraries/permanent');
const CONFIG_FILE   = path.resolve(__dirname, '../config/libraries.json');
const ARDUINO_CLI_PATH = process.env.ARDUINO_CLI_PATH || 'arduino-cli';

const MAX_CACHE_SIZE   = 512 * 1024 * 1024; // 512 MB  (cache only)
const PRUNE_TARGET_SIZE = 400 * 1024 * 1024; // 400 MB

// ─── Utility ─────────────────────────────────────────────────────────────────

function getDirectorySize(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        total += entry.isDirectory() ? getDirectorySize(full) : fs.statSync(full).size;
    }
    return total;
}

// ─── LRU pruner (cache only, never touches permanent) ────────────────────────

function pruneCache() {
    if (!fs.existsSync(CACHE_DIR)) return;

    let cacheSize = getDirectorySize(CACHE_DIR);
    if (cacheSize <= MAX_CACHE_SIZE) return;

    console.log(`[LibraryCache] Cache size (${(cacheSize / 1024 / 1024).toFixed(2)} MB) exceeds 512 MB limit. Pruning to 400 MB...`);

    const libs = fs.readdirSync(CACHE_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
            const p = path.join(CACHE_DIR, d.name);
            return { path: p, name: d.name, atime: fs.statSync(p).atimeMs, size: getDirectorySize(p) };
        })
        .sort((a, b) => a.atime - b.atime); // oldest first

    for (const lib of libs) {
        if (cacheSize <= PRUNE_TARGET_SIZE) break;
        try {
            fs.rmSync(lib.path, { recursive: true, force: true });
            cacheSize -= lib.size;
            console.log(`[LibraryCache] Pruned: ${lib.name}`);
        } catch (err) {
            console.error(`[LibraryCache] Error pruning ${lib.name}:`, err.message);
        }
    }
}

// ─── Core fetch + extract ─────────────────────────────────────────────────────

/**
 * Download a library from the Arduino CDN and extract it into `targetDir`.
 *
 * @param {string}      libraryName  - Exact library name as in the Arduino index.
 * @param {string}      targetDir    - Destination directory.
 * @param {string|null} version      - Specific version string, or null for latest.
 */
export async function fetchAndExtractLibrary(libraryName, targetDir = CACHE_DIR, version = null) {
    fs.mkdirSync(targetDir, { recursive: true });

    const searchTarget = version ? `${libraryName}@${version}` : libraryName;
    console.log(`[LibrarySync] Resolving download URL for ${searchTarget}...`);

    let downloadUrl = null;

    // A. Fast local resolution
    try {
        const libInfo = getLibraryMetadata(libraryName);
        if (libInfo) {
            if (version && libInfo.releases?.[version]?.resources?.url) {
                downloadUrl = libInfo.releases[version].resources.url;
                console.log(`[LibrarySync] [FAST] Resolved ${searchTarget} from local index cache.`);
            } else if (libInfo.latest?.resources?.url) {
                downloadUrl = libInfo.latest.resources.url;
                console.log(`[LibrarySync] [FAST] Resolved latest version for ${libraryName} from local index cache.`);
                if (version) {
                    console.warn(`[LibrarySync] [FAST] Requested version ${version} not found in cache - falling back to latest`);
                }
            }
        }
    } catch (err) {
        console.error(`[LibrarySync] Fast index resolution failed:`, err.message);
    }

    // B. Slow fallback via arduino-cli
    if (!downloadUrl) {
        console.log(`[LibrarySync] [SLOW-FALLBACK] Searching for ${searchTarget} via arduino-cli...`);
        const { stdout } = await execFileAsync(ARDUINO_CLI_PATH, ['lib', 'search', libraryName, '--format', 'json']);

        const jsonStart = stdout.indexOf('{');
        const jsonEnd   = stdout.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) throw new Error(`No JSON in arduino-cli output for ${libraryName}`);

        const data    = JSON.parse(stdout.substring(jsonStart, jsonEnd + 1));
        const libInfo = data.libraries?.find(l => l.name === libraryName) ?? data.libraries?.[0];

        if (!libInfo) throw new Error(`Library not found in Arduino index: ${libraryName}`);

        if (version && libInfo.releases?.[version]?.resources?.url) {
            downloadUrl = libInfo.releases[version].resources.url;
            console.log(`[LibrarySync] Using specific version ${version} for ${libraryName} (CLI resolved)`);
        } else if (libInfo.latest?.resources?.url) {
            downloadUrl = libInfo.latest.resources.url;
            if (version) {
                console.warn(`[LibrarySync] Version ${version} not found for ${libraryName} — falling back to latest (CLI resolved)`);
            }
        }
    }

    if (!downloadUrl) {
        throw new Error(`No download URL found for ${libraryName}`);
    }

    console.log(`[LibrarySync] Downloading from: ${downloadUrl}`);
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`[LibrarySync] Extracting ${libraryName} → ${targetDir}`);
    
    const zip = new AdmZip(buffer);
    zip.extractAllTo(targetDir, true);

    const entries = zip.getEntries();
    if (entries.length > 0) {
        const firstEntryName = entries[0].entryName;
        const slashIdx = firstEntryName.indexOf('/');
        if (slashIdx !== -1) {
            const rootFolderName = firstEntryName.substring(0, slashIdx);
            // Verify all entries are under this root folder
            const hasSingleRoot = entries.every(e => e.entryName.startsWith(rootFolderName + '/'));
            if (hasSingleRoot && rootFolderName !== libraryName) {
                const oldPath = path.join(targetDir, rootFolderName);
                const newPath = path.join(targetDir, libraryName);
                if (fs.existsSync(newPath)) {
                    fs.rmSync(newPath, { recursive: true, force: true });
                }
                if (fs.existsSync(oldPath)) {
                    fs.renameSync(oldPath, newPath);
                    console.log(`[LibrarySync] Renamed root directory: ${rootFolderName} → ${libraryName}`);
                }
            }
        }
    }

    pruneCache();
    return true;
}

// ─── Permanent pool sync (called once at boot) ────────────────────────────────

export async function syncPermanentLibraries() {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.log(`[LibrarySync] Config not found: ${CONFIG_FILE}`);
        return;
    }

    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
        console.error('[LibrarySync] Failed to parse libraries.json:', err.message);
        return;
    }

    if (!Array.isArray(config.permanent)) return;

    for (const lib of config.permanent) {
        let name = lib;
        let version = null;
        if (lib.includes('@')) {
            const parts = lib.split('@');
            name = parts[0];
            version = parts[1];
        }

        const libPath = path.join(PERM_DIR, name);
        if (!fs.existsSync(libPath)) {
            console.log(`[LibrarySync] Fetching permanent library: ${lib}`);
            try {
                await fetchAndExtractLibrary(name, PERM_DIR, version);
            } catch (err) {
                console.error(`[LibrarySync] Failed to fetch ${lib}:`, err.message);
            }
        } else {
            console.log(`[LibrarySync] Permanent library verified: ${lib}`);
        }
    }
}

// ─── Per-compile library resolution ──────────────────────────────────────────

/**
 * Ensure all libraries required by a compile request are available on disk.
 * Returns an **ordered** list of `--libraries` path arguments to pass to
 * arduino-cli so version-specific overrides shadow the permanent pool.
 *
 * Resolution rules per entry:
 *  1. No version requested  → look in permanent pool; if missing, fetch latest
 *     to general cache.
 *  2. Specific version       → check cache/<Name>@<version>/; if missing,
 *     download that exact version there.
 *  3. If specific version == permanent version, use permanent (no cache hit
 *     needed; arduino-cli resolves from permanent naturally).
 *
 * The returned array is ordered so that version-specific cache dirs come FIRST,
 * guaranteeing they override the permanent pool for the same library.
 *
 * @param {{ name: string, version: string | null }[]} entries
 * @returns {Promise<string[]>} Ordered list of --libraries paths
 */
export async function ensureLibrariesForCompile(entries) {
    if (!entries || entries.length === 0) {
        // No explicit list → return the two default paths
        return [PERM_DIR, CACHE_DIR];
    }

    const versionSpecificPaths = []; // added first (highest priority)
    const needsGenericCache    = []; // missing from perm, will go to CACHE_DIR

    for (const { name, version } of entries) {
        if (version) {
            // ── Specific version requested ────────────────────────────────────
            // Check if the permanent pool already has this exact version
            const permLibDir = path.join(PERM_DIR, name);
            if (fs.existsSync(permLibDir)) {
                // Read the library.properties to check installed version
                const propFile = path.join(permLibDir, 'library.properties');
                try {
                    const props = fs.readFileSync(propFile, 'utf8');
                    const match = props.match(/^version\s*=\s*(.+)$/m);
                    const permVersion = match?.[1]?.trim();
                    if (permVersion === version) {
                        // Exact match in permanent — nothing to do, perm path covers it
                        console.log(`[LibraryResolver] ${name}@${version} satisfied by permanent pool`);
                        continue;
                    }
                } catch { /* property file missing or unreadable — proceed to cache check */ }
            }

            // Check versioned cache dir: cache/<Name>@<version>/
            // The zip from Arduino CDN extracts to a subdirectory like "<Name>/"
            // so we keep the whole versioned parent dir as the --libraries target.
            const versionedCacheDir = path.join(CACHE_DIR, `${name}@${version}`);
            if (!fs.existsSync(versionedCacheDir)) {
                console.log(`[LibraryResolver] Fetching ${name}@${version} to versioned cache...`);
                try {
                    await fetchAndExtractLibrary(name, versionedCacheDir, version);
                } catch (err) {
                    console.error(`[LibraryResolver] Failed to fetch ${name}@${version}:`, err.message);
                    // Fall back: add generic cache dir so we at least try permanent/general cache
                }
            } else {
                // Touch so LRU pruner knows it's recently used
                try { fs.utimesSync(versionedCacheDir, new Date(), new Date()); } catch { /* ignore */ }
            }

            if (fs.existsSync(versionedCacheDir)) {
                versionSpecificPaths.push(versionedCacheDir);
            }
        } else {
            // ── No version specified — use latest from permanent or general cache ──
            const permLibDir = path.join(PERM_DIR, name);
            if (fs.existsSync(permLibDir)) {
                console.log(`[LibraryResolver] ${name} satisfied by permanent pool (latest)`);
                // Permanent path is always included — nothing extra needed
            } else {
                // Check general cache
                const cacheLibDir = path.join(CACHE_DIR, name);
                if (!fs.existsSync(cacheLibDir)) {
                    console.log(`[LibraryResolver] Fetching ${name} (latest) to general cache...`);
                    try {
                        await fetchAndExtractLibrary(name, CACHE_DIR, null);
                    } catch (err) {
                        console.error(`[LibraryResolver] Failed to fetch ${name}:`, err.message);
                    }
                } else {
                    try { fs.utimesSync(cacheLibDir, new Date(), new Date()); } catch { /* ignore */ }
                }
                needsGenericCache.push(name);
            }
        }
    }

    // Build final --libraries path list:
    // 1. Version-specific cache dirs (highest priority — override permanent)
    // 2. Permanent pool
    // 3. General cache dir (for latest-version downloads)
    const result = [...versionSpecificPaths, PERM_DIR, CACHE_DIR];

    // Deduplicate while preserving order
    return [...new Set(result)];
}
