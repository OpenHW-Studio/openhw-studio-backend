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

    if (lower.includes('missing fqbn')) {
        return {
            category: 'missing-platform',
            hint: 'Install the required Arduino core (arduino-cli core install arduino:avr).',
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
        || lower.includes('expected .hex in build output')) {
        return {
            category: 'artifact-missing',
            hint: 'Build completed without HEX output. Verify board selection and build output directory.',
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
                details: 'This compiler supports Arduino Uno (arduino:avr:uno). Add the board to src/compiler/boardRegistry.js to extend support.',
                supportedBoards: ['arduino:avr:uno'],
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

    // Parse and resolve libraries from the optional libraries_txt field
    const libraryEntries = parseLibrariesTxt(req.body?.libraries_txt);
    const libraryPaths   = await ensureLibrariesForCompile(libraryEntries);
    const libraryFlags   = libraryPaths.flatMap(p => ['--libraries', p]);

    // Determine target
    const isAVR  = String(targetFqbn).includes('avr');

    // Disabled for AVR because its platform.txt prepends compiler.path directly, which breaks the ccache command.
    const useCcache = process.platform !== 'win32' && !isAVR;

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
        ? ['--build-property', 'compiler.c.elf.extra_flags=-Wl,-Map,{build.path}/{build.project_name}.map']
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
                    details: 'This backend build supports Arduino Uno (arduino:avr) targets only.',
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



