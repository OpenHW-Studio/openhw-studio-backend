import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';

import { parseLibrariesTxt } from '../services/libraryTxtParser.js';
import { ensureLibrariesForCompile } from '../services/dynamicLibraryManager.js';
import { enqueueCompile } from '../services/compileQueueManager.js';
import { getCost } from '../services/resourceManager.js';
import { resolveBoard, normalizeArtifactRequest } from '../compiler/boardRegistry.js';
import { selectArtifacts, toLegacyPayload } from '../compiler/artifactSelector.js';
import { getCompileResultFromCache, setCompileResultCache } from '../compiler/resultCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARDUINO_CLI_PATH = process.env.ARDUINO_CLI_PATH || 'arduino-cli';
const TEMP_DIR = path.resolve(__dirname, '../../temp');
const COMPILE_WORKSPACE_ROOT = path.join(TEMP_DIR, 'compile-workspaces');
// Workspace GC caps (env-configurable for Docker deploys):
// COMPILE_WORKSPACE_TTL_MS — workspace age before cleanup (default 12 h).
// COMPILE_WORKSPACE_MAX    — max live workspaces kept (default 48).
const COMPILE_WORKSPACE_TTL_MS = Number(process.env.COMPILE_WORKSPACE_TTL_MS || (1000 * 60 * 60 * 12));
const COMPILE_WORKSPACE_MAX = Math.max(8, Number(process.env.COMPILE_WORKSPACE_MAX || 48));
// Input size guards — reject abuse before touching disk/toolchain.
// Tuned for real sketches: 512 KB total source, 64 files max, 256 KB per file.
const MAX_SOURCE_FILES = Math.max(1, Number(process.env.COMPILE_MAX_FILES || 64));
const MAX_FILE_BYTES = Math.max(1024, Number(process.env.COMPILE_MAX_FILE_BYTES || 262144));
const MAX_TOTAL_BYTES = Math.max(4096, Number(process.env.COMPILE_MAX_TOTAL_BYTES || 524288));

function checkCompileInputSize({ code, files }) {
    const fileList = Array.isArray(files) ? files : [];
    if (fileList.length > MAX_SOURCE_FILES) {
        return `Too many source files (${fileList.length} > ${MAX_SOURCE_FILES}).`;
    }
    let total = typeof code === 'string' ? Buffer.byteLength(code) : 0;
    for (const f of fileList) {
        const content = typeof f?.content === 'string' ? f.content : '';
        const size = Buffer.byteLength(content);
        if (size > MAX_FILE_BYTES) {
            return `Source file "${String(f?.name || 'unnamed').slice(0, 64)}" exceeds ${MAX_FILE_BYTES} bytes.`;
        }
        total += size;
        if (total > MAX_TOTAL_BYTES) {
            return `Total source size exceeds ${MAX_TOTAL_BYTES} bytes.`;
        }
    }
    if (total > MAX_TOTAL_BYTES) {
        return `Total source size exceeds ${MAX_TOTAL_BYTES} bytes.`;
    }
    return null;
}
const DEFAULT_PICO_MICROPYTHON_UF2_SOURCE = String(
    process.env.PICO_MICROPYTHON_UART0_UF2_URL
    || process.env.PICO_MICROPYTHON_UF2_URL
    || ''
).trim();
const DEFAULT_PICO_MICROPYTHON_HEX_SOURCE = String(
    process.env.PICO_MICROPYTHON_HEX_PATH
    || process.env.PICO_MICROPYTHON_HEX_SOURCE
    || './data/firmware/rp2040-micropython-uart.hex'
).trim();
const DEFAULT_PICO_CIRCUITPYTHON_UF2_SOURCE = String(
    process.env.PICO_CIRCUITPYTHON_UF2_PATH
    || process.env.PICO_CIRCUITPYTHON_UF2_URL
    || './data/firmware/adafruit-circuitpython-raspberry_pi_pico-en_US-8.2.7.uf2'
).trim();
const PICO_MICROPYTHON_CACHE_TTL_MS = Number(process.env.PICO_MICROPYTHON_CACHE_TTL_MS || (1000 * 60 * 60 * 6));
const PICO_CIRCUITPYTHON_CACHE_TTL_MS = Number(process.env.PICO_CIRCUITPYTHON_CACHE_TTL_MS || (1000 * 60 * 60 * 6));

let picoMicropythonUf2Cache = null;
let picoMicropythonHexCache = null;
let picoCircuitPythonUf2Cache = null;

function stableSourceFiles(files) {
    const list = Array.isArray(files) ? files : [];
    return list
        .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string')
        .map((f) => ({
            name: sanitizeFileName(f.name),
            content: f.content,
        }))
        .filter((f) => ensureAllowedSourceExt(f.name))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function buildCompileRequestHash({ code, files, fqbn, builder, libraries_txt, artifacts }) {
    const payload = {
        code: typeof code === 'string' ? code : '',
        files: stableSourceFiles(files),
        fqbn: String(fqbn || '').trim() || 'arduino:avr:uno',
        builder: String(builder || '').trim() || 'arduino-cli',
        libraries_txt: String(libraries_txt || '').trim(),
        artifacts: Array.isArray(artifacts) ? [...artifacts].sort() : [],
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Shape a compile result for the wire: legacy primary fields (hex/elf/…)
 * plus the full `artifacts` map the frontend selects from.
 * Every artifact entry is { fileName, encoding, data }.
 */
function shapeCompileResponse({ primary, artifacts, outputFiles, stdout, diagnostics, cache }) {
    return {
        // Legacy primary contract — untouched so old frontends keep working.
        hex: primary.payload,
        artifactType: primary.artifactType,
        artifactPayload: primary.payload,
        uf2: primary.artifactType === 'uf2' ? primary.payload : '',
        intelHex: primary.artifactType === 'hex' ? primary.payload : '',
        artifactName: primary.artifactName,
        outputFiles,
        success: true,
        elf: primary.elfPayload || '',
        elfName: primary.elfName || null,
        gdb: primary.gdb || null,
        stdout: stdout || '',
        diagnostics: diagnostics || null,
        // New contract: exact files the frontend asked for via `artifacts`.
        artifacts: artifacts || {},
        requestedArtifacts: Object.keys(artifacts || {}),
        cache: cache || 'miss',
    };
}

// NOTE: firmware result cache (L1 memory + L2 disk result.json) lives in
// src/compiler/resultCache.js — imported above as
// getCompileResultFromCache / setCompileResultCache. Do not re-add locals here.

function ensureCompileWorkspace(scopeHash, safeSketchName) {
    const sketchFolderName = `${safeSketchName}_${String(scopeHash || '').slice(0, 8) || '00000000'}`;
    const scopeRoot = path.join(COMPILE_WORKSPACE_ROOT, String(scopeHash || 'default'));
    const sketchDir = path.join(scopeRoot, sketchFolderName);
    const buildDir = path.join(scopeRoot, 'build');

    fs.mkdirSync(sketchDir, { recursive: true });
    fs.mkdirSync(buildDir, { recursive: true });

    return {
        scopeRoot,
        sketchDir,
        buildDir,
        sketchFolderName,
        mainSketchFile: path.join(sketchDir, `${sketchFolderName}.ino`),
    };
}

function clearWorkspaceSources(sketchDir) {
    if (!fs.existsSync(sketchDir)) return;

    const removableExt = new Set(['.ino', '.h', '.hpp', '.c', '.cpp', '.S', '.s', '.txt']);
    for (const name of fs.readdirSync(sketchDir)) {
        const full = path.join(sketchDir, name);
        let stat = null;
        try {
            stat = fs.statSync(full);
        } catch {
            stat = null;
        }
        if (!stat || !stat.isFile()) continue;
        const ext = path.extname(name);
        if (!removableExt.has(ext)) continue;
        try {
            fs.rmSync(full, { force: true });
        } catch {
            // best effort cleanup
        }
    }
}

function pruneCompileWorkspaces() {
    if (!fs.existsSync(COMPILE_WORKSPACE_ROOT)) return;

    let entries = [];
    try {
        entries = fs.readdirSync(COMPILE_WORKSPACE_ROOT, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
                const full = path.join(COMPILE_WORKSPACE_ROOT, entry.name);
                let mtimeMs = 0;
                try {
                    mtimeMs = fs.statSync(full).mtimeMs;
                } catch {
                    mtimeMs = 0;
                }
                return { name: entry.name, full, mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
        return;
    }

    const now = Date.now();
    const toDelete = new Set();

    entries.forEach((entry, index) => {
        const expired = entry.mtimeMs > 0 && (now - entry.mtimeMs) > COMPILE_WORKSPACE_TTL_MS;
        const overflow = index >= COMPILE_WORKSPACE_MAX;
        if (expired || overflow) {
            toDelete.add(entry.full);
        }
    });

    toDelete.forEach((full) => {
        try {
            fs.rmSync(full, { recursive: true, force: true });
        } catch {
            // best effort cleanup
        }
    });
}

function resolvePicoMicropythonUf2Source() {
    const source = DEFAULT_PICO_MICROPYTHON_UF2_SOURCE;
    if (!source) {
        throw new Error('Missing PICO_MICROPYTHON_UART0_UF2_URL (or PICO_MICROPYTHON_UF2_URL) for Pico MicroPython UF2 source.');
    }

    const lower = source.toLowerCase();
    if (lower.includes('micropython.org/resources/firmware/rpi_pico')) {
        throw new Error('Configured UF2 source points to official micropython.org firmware (USB CDC REPL). Use a UART0-enabled Pico MicroPython UF2 build.');
    }

    if (/^https?:\/\//i.test(source)) {
        return { kind: 'url', value: source };
    }

    const filePath = path.isAbsolute(source)
        ? source
        : path.resolve(__dirname, '../../', source);
    return { kind: 'file', value: filePath };
}

function resolvePicoMicropythonHexSource() {
    const source = DEFAULT_PICO_MICROPYTHON_HEX_SOURCE;
    if (!source) {
        throw new Error('Missing PICO_MICROPYTHON_HEX_PATH (or PICO_MICROPYTHON_HEX_SOURCE) for Pico MicroPython HEX source.');
    }

    if (/^https?:\/\//i.test(source)) {
        return { kind: 'url', value: source };
    }

    const filePath = path.isAbsolute(source)
        ? source
        : path.resolve(__dirname, '../../', source);
    return { kind: 'file', value: filePath };
}

function resolvePicoCircuitPythonUf2Source() {
    const source = DEFAULT_PICO_CIRCUITPYTHON_UF2_SOURCE;
    if (!source) {
        throw new Error('Missing PICO_CIRCUITPYTHON_UF2_PATH (or PICO_CIRCUITPYTHON_UF2_URL) for Pico CircuitPython UF2 source.');
    }

    if (/^https?:\/\//i.test(source)) {
        return { kind: 'url', value: source };
    }

    const filePath = path.isAbsolute(source)
        ? source
        : path.resolve(__dirname, '../../', source);
    return { kind: 'file', value: filePath };
}

function sanitizeSketchName(name) {
    const base = String(name || '').trim() || 'sketch';
    return base.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sanitizeFileName(name) {
    const base = path.basename(String(name || '').trim());
    return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureAllowedSourceExt(name) {
    const ext = path.extname(name).toLowerCase();
    return ['.ino', '.h', '.hpp', '.c', '.cpp'].includes(ext);
}

function sanitizePortName(name) {
    return String(name || '').trim().replace(/[^a-zA-Z0-9_:\/.\\-]/g, '');
}

function uniqueNonEmptyLines(lines, maxCount = 12) {
    const seen = new Set();
    const out = [];
    for (const line of lines) {
        const normalized = String(line || '').trimEnd();
        if (!normalized.trim()) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
        if (out.length >= maxCount) break;
    }
    return out;
}

function extractDiagnosticHighlights(text, includeWarnings = true) {
    const source = String(text || '');
    const lines = source.split(/\r?\n/);
    const pattern = includeWarnings
        ? /(fatal error:|\berror:|\bwarning:|undefined reference|not found|no such file|collect2: error|ld returned|exception|traceback)/i
        : /(fatal error:|\berror:|undefined reference|not found|no such file|collect2: error|ld returned|exception|traceback)/i;

    const matched = lines.filter((line) => pattern.test(line));
    if (matched.length > 0) return uniqueNonEmptyLines(matched, 12);

    const fallback = lines.filter((line) => String(line || '').trim());
    return uniqueNonEmptyLines(fallback.slice(-12), 12);
}

function classifyCompileFailure(text, builder = '', fqbn = '') {
    const body = String(text || '');
    const lower = body.toLowerCase();
    const lowerBuilder = String(builder || '').toLowerCase();
    const lowerFqbn = String(fqbn || '').toLowerCase();

    if (lower.includes("platform 'rp2040:rp2040' not found")
        || lower.includes('platform rp2040:rp2040 is not found')
        || lower.includes('missing fqbn')) {
        return {
            category: 'missing-platform',
            hint: 'Install the required Arduino core (for RP2040: arduino-cli core install rp2040:rp2040).',
        };
    }

    if (lowerBuilder === 'pico-sdk' && lower.includes('pico_sdk_path')) {
        return {
            category: 'sdk-config',
            hint: 'Configure PICO_SDK_PATH or ensure openhw-studio-backend/external/pico-sdk exists.',
        };
    }

    if (lower.includes('arm-none-eabi') && (lower.includes('not found') || lower.includes('no such file'))) {
        return {
            category: 'missing-toolchain',
            hint: 'Install ARM GCC toolchain or set PICO_TOOLCHAIN_PATH to a valid toolchain root.',
        };
    }

    if (lower.includes('ninja') && lower.includes('not found')) {
        return {
            category: 'missing-build-tool',
            hint: 'Install Ninja and ensure it is available on PATH.',
        };
    }

    if (lower.includes('fatal error:') && lower.includes('no such file or directory')) {
        return {
            category: 'missing-header',
            hint: 'Check include paths and library dependencies for missing header files.',
        };
    }

    if (lower.includes('undefined reference') || lower.includes('collect2: error') || lower.includes('ld returned')) {
        return {
            category: 'linker-error',
            hint: 'Check function definitions, link order, and required libraries.',
        };
    }

    if (lower.includes('no firmware artifact was produced')
        || (lowerFqbn.includes('rp2040') && lower.includes('no .uf2 file found'))
        || lower.includes('expected .hex or .uf2 in build output')) {
        return {
            category: 'artifact-missing',
            hint: 'Build completed without UF2/HEX output. Verify board selection and build output directory.',
        };
    }

    if (lower.includes('was not declared in this scope')
        || lower.includes('error: expected')
        || lower.includes('stray')
        || lower.includes('invalid conversion')) {
        return {
            category: 'source-error',
            hint: 'Fix source compile errors reported in the highlighted compiler lines.',
        };
    }

    if (lower.includes('permission denied') || lower.includes('access is denied')) {
        return {
            category: 'permission-error',
            hint: 'Check filesystem/port permissions and close other tools that may lock build/upload files.',
        };
    }

    return {
        category: 'compile-failed',
        hint: 'Review diagnostics highlights for the first concrete compiler or linker error.',
    };
}

function buildCompileFailureDiagnostics({ text, builder = '', fqbn = '', stage = 'compile', statusCode = 400 }) {
    const body = String(text || '');
    const classification = classifyCompileFailure(body, builder, fqbn);
    return {
        ok: false,
        stage,
        statusCode,
        builder: String(builder || 'arduino-cli'),
        fqbn: String(fqbn || 'arduino:avr:uno'),
        category: classification.category,
        hint: classification.hint,
        highlights: extractDiagnosticHighlights(body, true),
        lines: body ? body.split(/\r?\n/).length : 0,
    };
}

function buildCompileSuccessDiagnostics({ stdout = '', builder = '', fqbn = '' }) {
    const output = String(stdout || '');
    const warningLines = extractDiagnosticHighlights(output, true)
        .filter((line) => /\bwarning:/i.test(line));

    return {
        ok: true,
        stage: 'compile',
        builder: String(builder || 'arduino-cli'),
        fqbn: String(fqbn || 'arduino:avr:uno'),
        category: warningLines.length > 0 ? 'warnings' : 'clean',
        warningCount: warningLines.length,
        highlights: warningLines.slice(0, 8),
    };
}

function sendCompileFailure(res, statusCode, payload, context = {}) {
    const details = String(payload?.details || payload?.error || '').trim();
    const diagnostics = buildCompileFailureDiagnostics({
        text: details,
        builder: context.builder,
        fqbn: context.fqbn,
        stage: context.stage,
        statusCode,
    });

    return res.status(statusCode).json({
        ...payload,
        diagnostics,
    });
}

// NOTE: legacy single-artifact resolvers (resolveCompileArtifact /
// resolveElfArtifact) were replaced by src/compiler/artifactSelector.js
// (selectArtifacts), which extracts exactly the artifacts the frontend asks
// for via the `artifacts` request param. Kept documented here so future
// board ports don't reintroduce parallel resolvers.

function resolveGdbMeta(targetFqbn = '') {
    const fqbn = String(targetFqbn || '').toLowerCase();
    if (fqbn.includes('rp2040') || fqbn.includes('pico')) {
        return {
            arch: 'arm',
            gdb: 'arm-none-eabi-gdb',
            targetRemote: 'localhost:3333',
        };
    }

    if (fqbn.includes('avr') || fqbn.includes('arduino:avr')) {
        return {
            arch: 'avr',
            gdb: 'avr-gdb',
            targetRemote: 'localhost:3555',
        };
    }

    return {
        arch: 'unknown',
        gdb: 'gdb-multiarch',
        targetRemote: 'localhost:3333',
    };
}

function resolvePicoSdkPath() {
    const envPath = String(process.env.PICO_SDK_PATH || '').trim();
    const candidates = [
        envPath,
        path.resolve(__dirname, '../../external/pico-sdk'),
        path.resolve(process.cwd(), 'external/pico-sdk'),
        path.resolve(process.cwd(), 'openhw-studio-backend/external/pico-sdk'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        const importCmake = path.join(candidate, 'external', 'pico_sdk_import.cmake');
        if (fs.existsSync(importCmake)) {
            return candidate;
        }
    }
    return '';
}

function resolveRp2040ToolchainPaths() {
    const compilerExe = os.platform() === 'win32' ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc';
    const explicit = String(process.env.PICO_TOOLCHAIN_PATH || '').trim();
    if (explicit) {
        const explicitBin = path.join(explicit, 'bin');
        const explicitExeInBin = path.join(explicitBin, compilerExe);
        const explicitExeDirect = path.join(explicit, compilerExe);
        if (fs.existsSync(explicitExeInBin)) {
            return { root: explicit, bin: explicitBin };
        }
        if (fs.existsSync(explicitExeDirect)) {
            return { root: path.dirname(explicit), bin: explicit };
        }
    }

    const dataCandidates = [
        String(process.env.ARDUINO_DATA_DIR || '').trim(),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Arduino15') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'Arduino15') : '',
    ].filter(Boolean);

    for (const dataDir of dataCandidates) {
        const toolsRoot = path.join(dataDir, 'packages', 'rp2040', 'tools', 'pqt-gcc');
        if (!fs.existsSync(toolsRoot)) continue;

        const versions = fs.readdirSync(toolsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

        for (const version of versions) {
            const root = path.join(toolsRoot, version);
            const bin = path.join(root, 'bin');
            const gccExe = path.join(bin, compilerExe);
            if (fs.existsSync(gccExe)) {
                return { root, bin };
            }
        }
    }

    return { root: '', bin: '' };
}

function resolveRp2040PicotoolExecutable() {
    const exeName = os.platform() === 'win32' ? 'picotool.exe' : 'picotool';
    const explicitExe = String(process.env.PICO_PICOTOOL_EXE || '').trim();
    if (explicitExe && fs.existsSync(explicitExe)) {
        return explicitExe;
    }

    const explicitDir = String(process.env.PICO_PICOTOOL_DIR || '').trim();
    if (explicitDir) {
        const explicitCandidate = path.join(explicitDir, exeName);
        if (fs.existsSync(explicitCandidate)) {
            return explicitCandidate;
        }
    }

    const dataCandidates = [
        String(process.env.ARDUINO_DATA_DIR || '').trim(),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Arduino15') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'Arduino15') : '',
    ].filter(Boolean);

    for (const dataDir of dataCandidates) {
        const toolsRoot = path.join(dataDir, 'packages', 'rp2040', 'tools', 'pqt-picotool');
        if (!fs.existsSync(toolsRoot)) continue;

        const versions = fs.readdirSync(toolsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

        for (const version of versions) {
            const exePath = path.join(toolsRoot, version, exeName);
            if (fs.existsSync(exePath)) {
                return exePath;
            }
        }
    }

    return '';
}

function resolveNinjaExecutable() {
    const envNinja = String(process.env.CMAKE_MAKE_PROGRAM || process.env.NINJA || '').trim();
    const candidates = [
        envNinja,
        path.resolve(__dirname, '../../../.venv/Scripts/ninja.exe'),
        path.resolve(__dirname, '../../env/Scripts/ninja.exe'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    // On unix-like systems we can usually rely on PATH if not found above.
    if (os.platform() !== 'win32') {
        return 'ninja';
    }

    return '';
}

function execFileAsync(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (error, stdout, stderr) => {
            if (error) return reject(new Error(stderr || stdout || error.message));
            resolve({ stdout, stderr });
        });
    });
}

function normalizePortEntry(address, meta = {}) {
    return {
        port: String(address || ''),
        label: meta.label || String(address || ''),
        protocol: meta.protocol || '',
        boardName: meta.boardName || '',
        fqbn: meta.fqbn || '',
        source: meta.source || 'system',
    };
}

async function listDetectedArduinoPorts() {
    try {
        const { stdout } = await execFileAsync(ARDUINO_CLI_PATH, ['board', 'list', '--format', 'json']);
        const parsed = JSON.parse(stdout || '{}');
        const rows = Array.isArray(parsed?.detected_ports) ? parsed.detected_ports : [];
        const out = [];

        rows.forEach((r) => {
            const address = r?.port?.address;
            if (!address) return;
            const bestMatch = Array.isArray(r?.matching_boards) ? r.matching_boards[0] : null;
            out.push(normalizePortEntry(address, {
                label: `${address}${bestMatch?.name ? ` (${bestMatch.name})` : ''}`,
                protocol: r?.port?.protocol || '',
                boardName: bestMatch?.name || '',
                fqbn: bestMatch?.fqbn || '',
                source: 'detected',
            }));
        });
        return out;
    } catch {
        return [];
    }
}

async function listSystemSerialPorts() {
    const platform = os.platform();
    if (platform === 'win32') {
        try {
            const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object | ConvertTo-Json -Compress']);
            const parsed = JSON.parse(stdout || '[]');
            const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
            return arr.map((p) => normalizePortEntry(p, { source: 'system' }));
        } catch {
            return [];
        }
    }

    // Basic fallback for unix-like systems
    const patterns = ['/dev/ttyUSB', '/dev/ttyACM', '/dev/cu.usb'];
    try {
        const devEntries = fs.readdirSync('/dev');
        return devEntries
            .map((name) => `/dev/${name}`)
            .filter((full) => patterns.some((p) => full.startsWith(p)))
            .map((p) => normalizePortEntry(p, { source: 'system' }));
    } catch {
        return [];
    }
}

async function fetchPicoMicropythonUf2Asset() {
    const sourceInfo = resolvePicoMicropythonUf2Source();
    const now = Date.now();
    const isFresh = picoMicropythonUf2Cache
        && (now - picoMicropythonUf2Cache.fetchedAt) < PICO_MICROPYTHON_CACHE_TTL_MS;

    if (isFresh) {
        return { ...picoMicropythonUf2Cache, cacheState: 'hit' };
    }

    try {
        if (sourceInfo.kind === 'url') {
            const upstream = await fetch(sourceInfo.value, {
                headers: {
                    'user-agent': 'OpenHW-Studio-Backend/1.0',
                },
            });

            if (!upstream.ok) {
                throw new Error(`Upstream UF2 fetch failed (${upstream.status})`);
            }

            const arrBuf = await upstream.arrayBuffer();
            const buffer = Buffer.from(arrBuf);
            const parsed = new URL(sourceInfo.value);
            const fileName = path.basename(parsed.pathname || '') || 'pico-micropython-uart0.uf2';

            picoMicropythonUf2Cache = {
                buffer,
                fileName,
                fetchedAt: now,
                contentType: upstream.headers.get('content-type') || 'application/octet-stream',
            };
        } else {
            const buffer = fs.readFileSync(sourceInfo.value);
            const fileName = path.basename(sourceInfo.value) || 'pico-micropython-uart0.uf2';

            picoMicropythonUf2Cache = {
                buffer,
                fileName,
                fetchedAt: now,
                contentType: 'application/octet-stream',
            };
        }

        return { ...picoMicropythonUf2Cache, cacheState: 'miss' };
    } catch (err) {
        if (picoMicropythonUf2Cache) {
            return { ...picoMicropythonUf2Cache, cacheState: 'stale' };
        }
        throw err;
    }
}

async function fetchPicoMicropythonHexAsset() {
    const sourceInfo = resolvePicoMicropythonHexSource();
    const now = Date.now();
    const isFresh = picoMicropythonHexCache
        && (now - picoMicropythonHexCache.fetchedAt) < PICO_MICROPYTHON_CACHE_TTL_MS;

    if (isFresh) {
        return { ...picoMicropythonHexCache, cacheState: 'hit' };
    }

    try {
        if (sourceInfo.kind === 'url') {
            const upstream = await fetch(sourceInfo.value, {
                headers: {
                    'user-agent': 'OpenHW-Studio-Backend/1.0',
                },
            });

            if (!upstream.ok) {
                throw new Error(`Upstream HEX fetch failed (${upstream.status})`);
            }

            const text = await upstream.text();
            const parsed = new URL(sourceInfo.value);
            const fileName = path.basename(parsed.pathname || '') || 'rp2040-micropython-uart.hex';

            picoMicropythonHexCache = {
                buffer: Buffer.from(String(text || ''), 'utf8'),
                fileName,
                fetchedAt: now,
                contentType: upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
            };
        } else {
            const buffer = fs.readFileSync(sourceInfo.value);
            const fileName = path.basename(sourceInfo.value) || 'rp2040-micropython-uart.hex';

            picoMicropythonHexCache = {
                buffer,
                fileName,
                fetchedAt: now,
                contentType: 'text/plain; charset=utf-8',
            };
        }

        return { ...picoMicropythonHexCache, cacheState: 'miss' };
    } catch (err) {
        if (picoMicropythonHexCache) {
            return { ...picoMicropythonHexCache, cacheState: 'stale' };
        }
        throw err;
    }
}

async function fetchPicoCircuitPythonUf2Asset() {
    const sourceInfo = resolvePicoCircuitPythonUf2Source();
    const now = Date.now();
    const isFresh = picoCircuitPythonUf2Cache
        && (now - picoCircuitPythonUf2Cache.fetchedAt) < PICO_CIRCUITPYTHON_CACHE_TTL_MS;

    if (isFresh) {
        return { ...picoCircuitPythonUf2Cache, cacheState: 'hit' };
    }

    try {
        if (sourceInfo.kind === 'url') {
            const upstream = await fetch(sourceInfo.value, {
                headers: {
                    'user-agent': 'OpenHW-Studio-Backend/1.0',
                },
            });

            if (!upstream.ok) {
                throw new Error(`Upstream CircuitPython UF2 fetch failed (${upstream.status})`);
            }

            const arrBuf = await upstream.arrayBuffer();
            const buffer = Buffer.from(arrBuf);
            const parsed = new URL(sourceInfo.value);
            const fileName = path.basename(parsed.pathname || '') || 'adafruit-circuitpython-raspberry_pi_pico-en_US-8.2.7.uf2';

            picoCircuitPythonUf2Cache = {
                buffer,
                fileName,
                fetchedAt: now,
                contentType: upstream.headers.get('content-type') || 'application/octet-stream',
            };
        } else {
            const buffer = fs.readFileSync(sourceInfo.value);
            const fileName = path.basename(sourceInfo.value) || 'adafruit-circuitpython-raspberry_pi_pico-en_US-8.2.7.uf2';

            picoCircuitPythonUf2Cache = {
                buffer,
                fileName,
                fetchedAt: now,
                contentType: 'application/octet-stream',
            };
        }

        return { ...picoCircuitPythonUf2Cache, cacheState: 'miss' };
    } catch (err) {
        if (picoCircuitPythonUf2Cache) {
            return { ...picoCircuitPythonUf2Cache, cacheState: 'stale' };
        }
        throw err;
    }
}

export const compileArduinoCode = async (req, res) => {
    const { code, files, sketchName, fqbn, builder, target, artifacts: requestedArtifacts } = req.body || {};

    let targetFqbn = typeof fqbn === 'string' && fqbn.trim() ? fqbn.trim() : 'arduino:avr:uno';

    const board = resolveBoard(targetFqbn);
    if (!board) {
        return sendCompileFailure(
            res,
            400,
            {
                error: `Unsupported board FQBN: ${targetFqbn}.`,
                details: 'This compiler supports Arduino Uno (arduino:avr:uno) and Raspberry Pi Pico (rp2040:rp2040) targets. Add the board to src/compiler/boardRegistry.js to extend support.',
                supportedBoards: ['arduino:avr:uno', 'rp2040:rp2040'],
            },
            { builder, fqbn: targetFqbn, stage: 'request' }
        );
    }

    const normalizedBuilder = String(builder || '').trim() || board.defaultBuilder;
    const wantedArtifacts = normalizeArtifactRequest(requestedArtifacts, board);

    const sizeError = checkCompileInputSize({ code, files });
    if (sizeError) {
        return sendCompileFailure(
            res,
            413,
            { error: 'Compile request too large.', details: sizeError },
            { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'request' }
        );
    }

    if (!code && (!Array.isArray(files) || files.length === 0)) {
        return sendCompileFailure(
            res,
            400,
            { error: 'No code or files provided.', details: 'The compile request must include code or at least one source file.' },
            { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'request' }
        );
    }

    const safeSketchName = sanitizeSketchName(sketchName || 'sketch');
    const requestHash = buildCompileRequestHash({
        code,
        files,
        fqbn: targetFqbn,
        builder: normalizedBuilder,
        libraries_txt: req.body?.libraries_txt,
        artifacts: wantedArtifacts,
    });

    const cacheHit = getCompileResultFromCache(requestHash);
    if (cacheHit) {
        console.log(`[Compile Cache] 🟢 Cache hit! Skipping compilation for target FQBN: ${targetFqbn}`);
        return res.json({ ...cacheHit, cache: 'hit' });
    }

    // Keep a persistent per-sketch workspace so toolchains can reuse object files.
    const workspaceScopeHash = crypto.createHash('sha1').update(JSON.stringify({
        builder: normalizedBuilder,
        fqbn: targetFqbn,
        sketch: safeSketchName,
    })).digest('hex');

    pruneCompileWorkspaces();

    let workspace = null;
    let validFiles = [];
    let mainSketchFile = '';
    let sketchDir = '';
    let buildDir = '';
    let sketchFolderName = '';

    try {
        workspace = ensureCompileWorkspace(workspaceScopeHash, safeSketchName);
        sketchDir = workspace.sketchDir;
        buildDir = workspace.buildDir;
        mainSketchFile = workspace.mainSketchFile;
        sketchFolderName = workspace.sketchFolderName;

        clearWorkspaceSources(sketchDir);
        validFiles = stableSourceFiles(files);

        const namedIno = validFiles.find((f) => {
            const ext = path.extname(f.name).toLowerCase();
            if (ext !== '.ino') return false;
            const base = path.basename(f.name, ext);
            return sanitizeSketchName(base) === safeSketchName;
        });
        const firstIno = validFiles.find((f) => path.extname(f.name).toLowerCase() === '.ino');
        const mainSourceName = namedIno?.name || firstIno?.name || null;

        validFiles
            .filter((f) => !mainSourceName || f.name !== mainSourceName)
            .forEach((f) => {
                fs.writeFileSync(path.join(sketchDir, f.name), f.content);
            });

        const mainCode = (typeof code === 'string' && code.length > 0)
            ? code
            : (namedIno?.content || firstIno?.content || 'void setup(){}\nvoid loop(){}\n');

        fs.writeFileSync(mainSketchFile, mainCode);
    } catch (err) {
        console.error('Error creating compile workspace:', err);
        return sendCompileFailure(
            res,
            500,
            {
                error: 'Failed to create build workspace.',
                details: err?.message || 'Unable to initialize compile workspace.',
            },
            { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'workspace' }
        );
    }

    // Handle pico-sdk builder
    if (normalizedBuilder === 'pico-sdk') {
        const picoSdkPath = resolvePicoSdkPath();
        if (!picoSdkPath) {
            return sendCompileFailure(
                res,
                400,
                {
                    error: 'Pico SDK build failed',
                    details: 'PICO_SDK_PATH is not configured and no local SDK was found at openhw-studio-backend/external/pico-sdk.',
                },
                { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'precheck' }
            );
        }

        const toolchain = resolveRp2040ToolchainPaths();
        if (!toolchain.root || !toolchain.bin) {
            return sendCompileFailure(
                res,
                400,
                {
                    error: 'Pico SDK build failed',
                    details: 'ARM toolchain not found for Pico SDK. Install/repair Arduino RP2040 core (rp2040:rp2040) or set PICO_TOOLCHAIN_PATH.',
                },
                { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'precheck' }
            );
        }

        const ninjaExe = resolveNinjaExecutable();
        if (!ninjaExe) {
            return sendCompileFailure(
                res,
                400,
                {
                    error: 'Pico SDK build failed',
                    details: 'Ninja build tool was not found. Install Ninja or set CMAKE_MAKE_PROGRAM to ninja executable.',
                },
                { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'precheck' }
            );
        }

        const picotoolExe = resolveRp2040PicotoolExecutable();

        const cmakelists = path.join(sketchDir, 'CMakeLists.txt');
        let sources = [];
        // Gather written files
        const filesInDir = fs.readdirSync(sketchDir);
        for (const f of filesInDir) {
            if (f.endsWith('.c') || f.endsWith('.cpp') || f.endsWith('.S')) {
                sources.push(f);
            }
        }
        if (sources.length === 0) {
            // If there were no .c/.cpp files, then rename the main sketch to .cpp so cmake handles it.
            const cppName = `${sketchFolderName}.cpp`;
            fs.renameSync(mainSketchFile, path.join(sketchDir, cppName));
            sources.push(cppName);
        }
        const picotoolShim = picotoolExe
            ? [
                'if (DEFINED ENV{PICO_PICOTOOL_EXE} AND NOT TARGET picotool)',
                'file(TO_CMAKE_PATH "$ENV{PICO_PICOTOOL_EXE}" OPENHW_PICOTOOL_EXE)',
                'if (EXISTS "${OPENHW_PICOTOOL_EXE}")',
                'add_executable(picotool IMPORTED GLOBAL)',
                'set_property(TARGET picotool PROPERTY IMPORTED_LOCATION "${OPENHW_PICOTOOL_EXE}")',
                'message(STATUS "Using preinstalled picotool at ${OPENHW_PICOTOOL_EXE}")',
                'endif()',
                'endif()',
                '',
            ].join('\n')
            : '';
        const cmaketemplated = `cmake_minimum_required(VERSION 3.13)
include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)
project(pico_project)
${picotoolShim}pico_sdk_init()
add_executable(firmware ${sources.join(' ')})
pico_enable_stdio_usb(firmware 1)
pico_enable_stdio_uart(firmware 1)
target_link_libraries(firmware pico_stdlib)
pico_add_extra_outputs(firmware)
`;
        fs.writeFileSync(cmakelists, cmaketemplated);

        const cmakePathEntries = [
            toolchain.bin,
            ...(path.isAbsolute(ninjaExe) ? [path.dirname(ninjaExe)] : []),
            ...(picotoolExe && path.isAbsolute(picotoolExe) ? [path.dirname(picotoolExe)] : []),
            process.env.PATH || '',
        ];

        const cmakeEnv = {
            ...process.env,
            PICO_SDK_PATH: picoSdkPath,
            PICO_TOOLCHAIN_PATH: toolchain.root,
            ...(picotoolExe ? { PICO_PICOTOOL_EXE: picotoolExe.replace(/\\/g, '/') } : {}),
            PATH: cmakePathEntries.join(path.delimiter),
        };

        const configureArgs = [
            '-S',
            sketchDir,
            '-B',
            buildDir,
            '-G',
            'Ninja',
            `-DCMAKE_MAKE_PROGRAM=${ninjaExe}`,
            `-DPICO_SDK_PATH=${picoSdkPath}`,
            `-DPICO_TOOLCHAIN_PATH=${toolchain.root}`,
            '-DPICO_BOARD=pico',
        ];

        if (process.platform !== 'win32') {
            configureArgs.push('-DCMAKE_C_COMPILER_LAUNCHER=ccache');
            configureArgs.push('-DCMAKE_CXX_COMPILER_LAUNCHER=ccache');
        }

          try {
              await enqueueCompile(getCost(board?.costTarget || 'pico', 'compile'), () => new Promise((resolve) => {
              const doBuild = (cfgStdout = '', cfgStderr = '') => {
                  execFile('cmake', ['--build', buildDir, '--target', 'firmware', '--config', 'Release'], { cwd: sketchDir, env: cmakeEnv }, (buildErr, buildStdout, buildStderr) => {
                  if (buildErr) {
                      console.error('Pico SDK build error:', buildStderr || buildStdout);
                      return sendCompileFailure(
                          res,
                          400,
                          {
                              error: 'Pico SDK build failed',
                              details: `${cfgStderr || cfgStdout}\n${buildStderr || buildStdout}`.trim(),
                          },
                          { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'build' }
                      );
                  }

                  try {
                      const stdoutText = `${cfgStdout || ''}\n${buildStdout || ''}`.trim();
                      const { artifacts, outputFiles } = selectArtifacts(buildDir, wantedArtifacts);
                      const primaryName = wantedArtifacts[0];
                      const primaryEntry = artifacts[primaryName];
                      if (!primaryEntry) {
                          return sendCompileFailure(
                              res,
                              500,
                              {
                                  error: 'Compilation finished but no firmware artifact was produced.',
                                  details: `Requested ${wantedArtifacts.join(', ')} for ${targetFqbn}. Found: ${outputFiles.join(', ') || '(none)'}`,
                                  requestedArtifacts: wantedArtifacts,
                              },
                              { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'artifact' }
                          );
                      }

                      const elfEntry = artifacts.elf || null;
                      const responsePayload = shapeCompileResponse({
                          primary: {
                              payload: toLegacyPayload(primaryName, primaryEntry),
                              artifactType: primaryName,
                              artifactName: primaryEntry.fileName,
                              elfPayload: elfEntry ? toLegacyPayload('elf', elfEntry) : '',
                              elfName: elfEntry?.fileName || null,
                              gdb: resolveGdbMeta('rp2040'),
                          },
                          artifacts,
                          outputFiles,
                          stdout: stdoutText,
                          diagnostics: buildCompileSuccessDiagnostics({
                              stdout: stdoutText,
                              builder: normalizedBuilder,
                              fqbn: targetFqbn,
                          }),
                          cache: 'miss',
                      });

                      setCompileResultCache(requestHash, responsePayload);
                      return res.json({ ...responsePayload });
                  } catch (err) {
                      console.error('Error extracting UF2:', err);
                      return sendCompileFailure(
                          res,
                          500,
                          { error: 'Failed to extract UF2.', details: err?.message || 'UF2 extraction failed.' },
                          { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'artifact' }
                      );
                  } finally {
                      resolve();
                  }
              });
          };

          if (fs.existsSync(path.join(buildDir, 'CMakeCache.txt'))) {
              return doBuild();
          }

          execFile('cmake', configureArgs, { cwd: sketchDir, env: cmakeEnv }, (cfgErr, cfgStdout, cfgStderr) => {
              if (cfgErr) {
                  console.error('Pico SDK configure error:', cfgStderr || cfgStdout);
                  sendCompileFailure(
                      res,
                      400,
                      {
                          error: 'Pico SDK build failed',
                          details: cfgStderr || cfgStdout,
                      },
                      { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'configure' }
                  );
                  return resolve();
              }
              doBuild(cfgStdout, cfgStderr);
          });
          }));
          } catch (poolErr) {
              if (poolErr?.code === 'POOL_FULL') {
                  res.setHeader('Retry-After', String(poolErr.retryAfterSec || 30));
                  return res.status(503).json({
                      error: 'Compile server is full for now. Please try again in a moment.',
                      retryAfterSec: poolErr.retryAfterSec || 30,
                  });
              }
              throw poolErr;
          }
          return;
    }

    // Parse and resolve libraries from the optional libraries_txt field
    const libraryEntries = parseLibrariesTxt(req.body?.libraries_txt);
    const libraryPaths   = await ensureLibrariesForCompile(libraryEntries);
    const libraryFlags   = libraryPaths.flatMap(p => ['--libraries', p]);

    // Determine target
    const isAVR  = String(targetFqbn).includes('avr');

    // Disabled for AVR and RP2040 because their platform.txt prepends compiler.path directly, which breaks the ccache command.
    const isRP2040 = String(targetFqbn).includes('rp2040');
    const useCcache = process.platform !== 'win32' && !isAVR && !isRP2040;

    const ccacheC   = 'arm-none-eabi-gcc';
    const ccacheCpp = 'arm-none-eabi-g++';
    const ccacheProps = useCcache ? [
        '--build-property', `compiler.c.cmd=ccache ${ccacheC}`,
        '--build-property', `compiler.cpp.cmd=ccache ${ccacheCpp}`,
    ] : [];

    // NOTE: arduino-cli's own core cache lives under ~/.arduino15 + the
    // per-workspace build dir; no separate COMPILE_CACHE_DIR is needed.

    // Ask arduino-cli for a linker map alongside the firmware so `map`
    // is available when the frontend requests it. Harmless when unrequested:
    // selectArtifacts only picks files the frontend asked for.
    const wantMap = wantedArtifacts.includes('map');
    const mapFlag = wantMap
        ? (String(targetFqbn).toLowerCase().includes('rp2040')
            ? ['--build-property', 'compiler.c.elf.extra_flags=-Wl,-Map,{build.path}/{build.project_name}.map']
            : ['--build-property', 'compiler.c.elf.extra_flags=-Wl,-Map,{build.path}/{build.project_name}.map'])
        : [];

    const cliArgs = [
        'compile',
        '--fqbn', targetFqbn,
        '--build-path', buildDir,
        '--jobs', '4',
        ...ccacheProps,
        ...mapFlag,
        ...libraryFlags,
    ];

    cliArgs.push(sketchDir);

      try {
      await enqueueCompile(getCost(board?.costTarget || 'uno', 'compile'), () => new Promise((resolve) => {
          execFile(ARDUINO_CLI_PATH, cliArgs, {
              env: { ...process.env, CC_CACHE_ENABLED: '1', CCACHE_MAXSIZE: '2G' }
          }, (error, stdout, stderr) => {
        if (error) {
            console.error('Compile error:', error || stdout);
            return sendCompileFailure(
                res,
                400,
                {
                    error: 'Compilation failed',
                    details: stderr || stdout,
                },
                { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'compile' }
            );
        }

        const { artifacts, outputFiles } = selectArtifacts(buildDir, wantedArtifacts);
        const primaryName = wantedArtifacts[0];
        const primaryEntry = artifacts[primaryName];

        if (!primaryEntry) {
            return sendCompileFailure(
                res,
                500,
                {
                    error: 'Compilation finished but no firmware artifact was produced.',
                    details: `Requested ${wantedArtifacts.join(', ')} for ${targetFqbn}. Found: ${outputFiles.join(', ') || '(none)'}`,
                    requestedArtifacts: wantedArtifacts,
                },
                { builder: normalizedBuilder, fqbn: targetFqbn, stage: 'artifact' }
            );
        }

        const elfEntry = artifacts.elf || null;
        const elfPayload = elfEntry ? toLegacyPayload('elf', elfEntry) : '';
        const primaryPayload = toLegacyPayload(primaryName, primaryEntry);
        const responsePayload = shapeCompileResponse({
            primary: {
                payload: primaryPayload,
                artifactType: primaryName,
                artifactName: primaryEntry.fileName,
                elfPayload,
                elfName: elfEntry?.fileName || null,
                gdb: resolveGdbMeta(targetFqbn),
            },
            artifacts,
            outputFiles,
            stdout,
            diagnostics: buildCompileSuccessDiagnostics({
                stdout,
                builder: normalizedBuilder,
                fqbn: targetFqbn,
            }),
            cache: 'miss',
        });
        // Extra legacy aliases some simulator code reads directly.
        responsePayload.artifactPayload = primaryPayload;
        responsePayload.uf2 = primaryName === 'uf2' ? primaryPayload : '';
        responsePayload.intelHex = primaryName === 'hex' ? primaryPayload : '';

        setCompileResultCache(requestHash, responsePayload);
        res.json({ ...responsePayload });
        resolve();
      });
      }));
      } catch (poolErr) {
          if (poolErr?.code === 'POOL_FULL') {
              res.setHeader('Retry-After', String(poolErr.retryAfterSec || 30));
              return res.status(503).json({
                  error: 'Compile server is full for now. Please try again in a moment.',
                  retryAfterSec: poolErr.retryAfterSec || 30,
              });
          }
          throw poolErr;
      }
};

function resolveAvrdudeExecutable() {
    const isWin = os.platform() === 'win32';
    const exeName = isWin ? 'avrdude.exe' : 'avrdude';
    const explicitExe = String(process.env.AVRDUDE_PATH || '').trim();
    if (explicitExe && fs.existsSync(explicitExe)) return explicitExe;

    const dataCandidates = [
        String(process.env.ARDUINO_DATA_DIR || '').trim(),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Arduino15') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'Arduino15') : '',
    ].filter(Boolean);

    for (const dataDir of dataCandidates) {
        const toolsRoot = path.join(dataDir, 'packages', 'arduino', 'tools', 'avrdude');
        if (!fs.existsSync(toolsRoot)) continue;

        const versions = fs.readdirSync(toolsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

        for (const version of versions) {
            const exePath = path.join(toolsRoot, version, 'bin', exeName);
            if (fs.existsSync(exePath)) return exePath;
        }
    }
    return exeName; // fallback to PATH
}

function resolveAvrdudeConf() {
    const explicit = String(process.env.AVRDUDE_CONF || '').trim();
    if (explicit && fs.existsSync(explicit)) return explicit;

    const dataCandidates = [
        String(process.env.ARDUINO_DATA_DIR || '').trim(),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Arduino15') : '',
        process.env.APPDATA ? path.join(process.env.APPDATA, 'Arduino15') : '',
    ].filter(Boolean);

    for (const dataDir of dataCandidates) {
        const toolsRoot = path.join(dataDir, 'packages', 'arduino', 'tools', 'avrdude');
        if (!fs.existsSync(toolsRoot)) continue;

        const versions = fs.readdirSync(toolsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

        for (const version of versions) {
            const confPath = path.join(toolsRoot, version, 'etc', 'avrdude.conf');
            if (fs.existsSync(confPath)) return confPath;
        }
    }
    return '';
}

export const flashFirmware = (req, res) => {
    const { port, fqbn, hex, baudRate, resetMethod } = req.body || {};
    const cleanPort = sanitizePortName(port);
    const targetFqbn = typeof fqbn === 'string' && fqbn.trim() ? fqbn.trim() : 'arduino:avr:uno';
    const hexContent = typeof hex === 'string' ? hex.trim() : '';
    const cleanBaud = Number(baudRate);

    if (!cleanPort) {
        return res.status(400).json({ error: 'Missing hardware port. Example: COM3 or /dev/ttyUSB0.' });
    }
    if (!hexContent) {
        return res.status(400).json({ error: 'Missing HEX firmware content.' });
    }

    const flashId = crypto.randomBytes(8).toString('hex');
    const flashDir = path.join(TEMP_DIR, `flash_${flashId}`);
    const hexFile = path.join(flashDir, `firmware_${flashId}.hex`);

    try {
        fs.mkdirSync(flashDir, { recursive: true });

        const loweredFqbn = targetFqbn.toLowerCase();
        if (loweredFqbn.includes('esp32') || loweredFqbn.includes('stm32')) {
            fs.rm(flashDir, { recursive: true, force: true }, () => {});
            return sendCompileFailure(
                res,
                410,
                {
                    error: 'ESP32/STM32 hardware flashing is not supported in this build.',
                    details: 'This backend build supports Arduino Uno (arduino:avr) and Raspberry Pi Pico (rp2040) targets only.',
                },
                { builder: 'arduino-cli', fqbn: targetFqbn, stage: 'request' }
            );
        }

        fs.writeFileSync(hexFile, hexContent, 'utf8');
    } catch (err) {
        console.error('Error creating flash temp files:', err);
        return res.status(500).json({ error: 'Failed to create temporary flash files.' });
    }

    const execArgs = [
        'upload',
        '--fqbn', targetFqbn,
        '-p', cleanPort,
        '--input-file', hexFile,
        '--verify',
    ];

    const isAvr = targetFqbn.toLowerCase().includes(':avr:');
    if (!isAvr && Number.isFinite(cleanBaud) && cleanBaud > 0) {
        execArgs.push('--upload-property', `upload.speed=${Math.trunc(cleanBaud)}`);
    }

    if (String(resetMethod || '').toLowerCase() === 'no-rts-dtr') {
        execArgs.push('--upload-property', 'upload.disable_flushing=true');
    }

    execFile(ARDUINO_CLI_PATH, execArgs, (error, stdout, stderr) => {
        fs.rm(flashDir, { recursive: true, force: true }, (rmErr) => {
            if (rmErr) console.error(`Failed to clean up flash dir: ${flashDir}`, rmErr);
        });

        if (error) {
            console.error('Flash error:', stderr || stdout || error.message);
            return res.status(400).json({
                error: 'Flashing failed',
                details: stderr || stdout || error.message,
            });
        }

        return res.json({
            ok: true,
            message: 'Firmware flashed successfully via arduino-cli.',
            output: stdout || stderr || '',
        });
    });
};

export const listSerialPorts = async (req, res) => {
    const showAll = String(req.query.showAll || 'false').toLowerCase() === 'true';
    try {
        const detected = await listDetectedArduinoPorts();
        if (!showAll) {
            return res.json({ ports: detected });
        }

        const system = await listSystemSerialPorts();
        const merged = new Map();
        [...detected, ...system].forEach((p) => {
            if (!p?.port) return;
            if (!merged.has(p.port)) merged.set(p.port, p);
            else if (merged.get(p.port).source !== 'detected' && p.source === 'detected') merged.set(p.port, p);
        });

        return res.json({ ports: Array.from(merged.values()) });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to list serial ports', details: err.message });
    }
};

export const getDefaultPicoMicroPythonUf2 = async (req, res) => {
    try {
        const asset = await fetchPicoMicropythonUf2Asset();

        res.setHeader('Content-Type', asset.contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${asset.fileName || 'pico-micropython.uf2'}"`);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('X-OpenHW-UF2-Cache', asset.cacheState || 'unknown');

        return res.status(200).send(asset.buffer);
    } catch (err) {
        return res.status(502).json({
            error: 'Failed to fetch default Pico MicroPython UF2',
            details: err?.message || 'Unknown error',
        });
    }
};

export const getDefaultPicoMicroPythonHex = async (req, res) => {
    try {
        const asset = await fetchPicoMicropythonHexAsset();

        res.setHeader('Content-Type', asset.contentType || 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${asset.fileName || 'rp2040-micropython-uart.hex'}"`);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('X-OpenHW-HEX-Cache', asset.cacheState || 'unknown');

        return res.status(200).send(asset.buffer);
    } catch (err) {
        return res.status(502).json({
            error: 'Failed to fetch default Pico MicroPython HEX',
            details: err?.message || 'Unknown error',
        });
    }
};

export const getDefaultPicoCircuitPythonUf2 = async (req, res) => {
    try {
        const asset = await fetchPicoCircuitPythonUf2Asset();

        res.setHeader('Content-Type', asset.contentType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${asset.fileName || 'adafruit-circuitpython-raspberry_pi_pico-en_US-8.2.7.uf2'}"`);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('X-OpenHW-UF2-Cache', asset.cacheState || 'unknown');

        return res.status(200).send(asset.buffer);
    } catch (err) {
        return res.status(502).json({
            error: 'Failed to fetch default Pico CircuitPython UF2',
            details: err?.message || 'Unknown error',
        });
    }
};
