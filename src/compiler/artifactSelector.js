/**
 * artifactSelector.js — src/compiler/artifactSelector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads a finished arduino-cli / cmake build directory and extracts exactly
 * the artifacts the frontend asked for.
 *
 * Contract:
 *   selectArtifacts(buildDir, wanted)
 *     → { artifacts: { [name]: { fileName, encoding, data } }, outputFiles }
 *
 * Encodings:
 *   - text artifacts (hex, map) are returned as utf8 strings
 *   - binary artifacts (uf2, bin, elf) are returned as base64 strings
 *
 * The caller (compileController) decides how to surface these: primary
 * payload fields for the legacy contract + the full `artifacts` map.
 */

import fs from 'fs';
import path from 'path';

const TEXT_ARTIFACTS = new Set(['hex', 'map']);
const BINARY_ARTIFACTS = new Set(['uf2', 'bin', 'elf']);

const EXTENSIONS_BY_ARTIFACT = Object.freeze({
    hex: ['.hex'],
    uf2: ['.uf2'],
    bin: ['.bin'],
    elf: ['.elf'],
    map: ['.map'],
});

function newestMatch(outFiles, buildDir, extensions, nameHint = '') {
    const loweredExts = extensions.map((ext) => ext.toLowerCase());
    const hint = String(nameHint || '').toLowerCase();
    const matches = outFiles
        .filter((name) => loweredExts.some((ext) => name.toLowerCase().endsWith(ext)))
        .filter((name) => !hint || name.toLowerCase().includes(hint))
        .map((name) => {
            const filePath = path.join(buildDir, name);
            let mtimeMs = 0;
            try {
                mtimeMs = fs.statSync(filePath).mtimeMs;
            } catch {
                mtimeMs = 0;
            }
            return { name, filePath, mtimeMs };
        })
        .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
    return matches[0] || null;
}

/**
 * @param {string} buildDir - absolute path to the finished build output dir
 * @param {string[]} wanted - normalized artifact names (see boardRegistry)
 * @param {string} [sketchHint] - sketch file base name to prefer (avoids
 *   picking bootloader/partitions/boot_app0 siblings for `bin`)
 * @returns {{ artifacts: Record<string, { fileName: string, encoding: 'utf8'|'base64', data: string }>, outputFiles: string[] }}
 */
export function selectArtifacts(buildDir, wanted, sketchHint = '') {
    const outFiles = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
    const artifacts = {};

    for (const name of wanted || []) {
        const extensions = EXTENSIONS_BY_ARTIFACT[name];
        if (!extensions) continue;
        // ESP32 builds emit several .bin siblings (bootloader, partitions,
        // boot_app0, merged). Prefer the sketch's own image:
        //   <sketch>.ino.merged.bin > <sketch>.ino.bin (app only).
        // The merged image is what esptool flashes (bootloader @0x1000,
        // partitions @0x8000, app @0x10000); esp32-emu boots it at offset 0.
        let match = null;
        if (name === 'bin' && sketchHint) {
            const safe = String(sketchHint).replace(/[^a-zA-Z0-9._-]/g, '_');
            match = newestMatch(outFiles, buildDir, [`.ino.merged.bin`], safe)
                || newestMatch(outFiles, buildDir, [`.ino.bin`], safe);
        }
        if (!match) match = newestMatch(outFiles, buildDir, extensions);
        if (!match) continue;

        try {
            if (TEXT_ARTIFACTS.has(name)) {
                artifacts[name] = {
                    fileName: match.name,
                    encoding: 'utf8',
                    data: fs.readFileSync(match.filePath, 'utf8'),
                };
            } else if (BINARY_ARTIFACTS.has(name)) {
                artifacts[name] = {
                    fileName: match.name,
                    encoding: 'base64',
                    data: fs.readFileSync(match.filePath).toString('base64'),
                };
            }
        } catch {
            // unreadable file → treat as missing, caller reports artifact-missing
        }
    }

    return { artifacts, outputFiles: outFiles };
}

/**
 * Back-compat helper: keep the legacy prefixed payloads (`UF2BASE64:…`,
 * `ELFBASE64:…`) for the artifacts map so older simulator code that reads
 * `compiled.hex` keeps working while new code reads `artifacts`.
 */
export function toLegacyPayload(artifactName, entry) {
    if (!entry) return '';
    if (artifactName === 'uf2') return `UF2BASE64:${entry.data}`;
    if (artifactName === 'elf') return `ELFBASE64:${entry.data}`;
    return entry.data;
}
