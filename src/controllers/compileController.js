import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the arduino-cli executable relative to this backend project
const ARDUINO_CLI_PATH = path.resolve(__dirname, '../../../bin/arduino-cli.exe');
const TEMP_DIR = path.resolve(__dirname, '../../temp');

export const compileArduinoCode = (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'No code provided.' });
    }

    // Create a unique temporary directory for this sketch
    const sketchId = crypto.randomBytes(8).toString('hex');
    const sketchDir = path.join(TEMP_DIR, `sketch_${sketchId}`);
    const sketchFile = path.join(sketchDir, `sketch_${sketchId}.ino`);
    const buildDir = path.join(sketchDir, 'build');

    try {
        fs.mkdirSync(sketchDir, { recursive: true });
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(sketchFile, code);
    } catch (err) {
        console.error('Error creating temp files:', err);
        return res.status(500).json({ error: 'Failed to create temporary build environment.' });
    }

    // Compile using arduino-cli
    // We specify target FQBN as arduino:avr:uno
    const fqbn = 'arduino:avr:uno';
    execFile(ARDUINO_CLI_PATH, ['compile', '--fqbn', fqbn, '--build-path', buildDir, sketchFile], (error, stdout, stderr) => {
        // Read the resulting hex regardless of warnings, but handle hard errors
        let hexContent = '';
        const hexFilePath = path.join(buildDir, `sketch_${sketchId}.ino.hex`);

        if (fs.existsSync(hexFilePath)) {
            hexContent = fs.readFileSync(hexFilePath, 'utf8');
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
