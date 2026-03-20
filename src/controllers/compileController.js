import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find arduino-cli globally via system PATH
const ARDUINO_CLI_PATH = 'arduino-cli';
const TEMP_DIR = path.resolve(__dirname, '../../temp');

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

export const compileArduinoCode = (req, res) => {
    const { code, files, sketchName, fqbn } = req.body || {};

    if (!code && (!Array.isArray(files) || files.length === 0)) {
        return res.status(400).json({ error: 'No code or files provided.' });
    }

    // Create a unique temporary directory for this sketch
    const sketchId = crypto.randomBytes(8).toString('hex');
    const safeSketchName = sanitizeSketchName(sketchName || `sketch_${sketchId}`);
    const sketchFolderName = `${safeSketchName}_${sketchId}`;
    const sketchDir = path.join(TEMP_DIR, sketchFolderName);
    // Arduino CLI requires the primary .ino name to match the sketch folder name.
    const mainSketchFile = path.join(sketchDir, `${sketchFolderName}.ino`);
    const buildDir = path.join(sketchDir, 'build');

    try {
        fs.mkdirSync(sketchDir, { recursive: true });
        fs.mkdirSync(buildDir, { recursive: true });

        const validFiles = Array.isArray(files) ? files
            .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string')
            .map((f) => ({
                name: sanitizeFileName(f.name),
                content: f.content,
            }))
            .filter((f) => ensureAllowedSourceExt(f.name))
            : [];

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
        console.error('Error creating temp files:', err);
        return res.status(500).json({ error: 'Failed to create temporary build environment.' });
    }

    // Compile using arduino-cli
    // We specify target FQBN as arduino:avr:uno
    const targetFqbn = typeof fqbn === 'string' && fqbn.trim() ? fqbn.trim() : 'arduino:avr:uno';
    execFile(ARDUINO_CLI_PATH, ['compile', '--fqbn', targetFqbn, '--output-dir', buildDir, sketchDir], (error, stdout, stderr) => {
        // Read the resulting hex regardless of warnings, but handle hard errors
        let hexContent = '';

        try {
            const outFiles = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
            const hexName = outFiles.find((name) => name.toLowerCase().endsWith('.hex'));
            if (hexName) {
                hexContent = fs.readFileSync(path.join(buildDir, hexName), 'utf8');
            }
        } catch {
            hexContent = '';
        }

        // Cleanup temp directory asynchronously
        fs.rm(sketchDir, { recursive: true, force: true }, (rmErr) => {
            if (rmErr) console.error(`Failed to clean up sketch dir: ${sketchDir}`, rmErr);
        });

        if (error && !hexContent) {
            console.error('Compile error:', stderr || stdout);
            return res.status(400).json({
                error: 'Compilation failed',
                details: stderr || stdout
            });
        }

        if (!hexContent) {
            return res.status(500).json({ error: 'Compilation finished but no hex file was produced.' });
        }

        return res.json({ hex: hexContent, stdout: stdout });
    });
};

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
        fs.writeFileSync(hexFile, hexContent, 'utf8');
    } catch (err) {
        console.error('Error creating flash temp files:', err);
        return res.status(500).json({ error: 'Failed to create temporary flash files.' });
    }

    const args = [
        'upload',
        '--fqbn', targetFqbn,
        '-p', cleanPort,
        '--input-file', hexFile,
        '--verify',
    ];

    if (Number.isFinite(cleanBaud) && cleanBaud > 0) {
        args.push('--upload-property', `upload.speed=${Math.trunc(cleanBaud)}`);
    }
    if (String(resetMethod || '').toLowerCase() === 'no-rts-dtr') {
        // Core-dependent, may be ignored by some board packages.
        args.push('--upload-property', 'upload.disable_flushing=true');
    }

    execFile(ARDUINO_CLI_PATH, args, (error, stdout, stderr) => {
        fs.rm(flashDir, { recursive: true, force: true }, (rmErr) => {
            if (rmErr) console.error(`Failed to clean up flash dir: ${flashDir}`, rmErr);
        });

        if (error) {
            console.error('Flash error:', stderr || stdout);
            return res.status(400).json({
                error: 'Flashing failed',
                details: stderr || stdout,
            });
        }

        return res.json({
            ok: true,
            message: 'Firmware flashed successfully via bootloader uploader.',
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
