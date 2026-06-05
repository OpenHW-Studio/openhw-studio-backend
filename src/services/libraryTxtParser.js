/**
 * libraryTxtParser.js  —  src/services/libraryTxtParser.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses the optional `libraries_txt` field sent with every compile request.
 *
 * Format (one library per line):
 *   ArduinoJson@6.21.3      → { name: "ArduinoJson", version: "6.21.3" }
 *   PubSubClient            → { name: "PubSubClient", version: null }
 *   # This is a comment     → ignored
 *   (blank line)            → ignored
 *
 * Rules:
 *  - Leading/trailing whitespace is stripped.
 *  - Lines starting with '#' are comments.
 *  - The '@version' suffix is optional; absence means "use latest available".
 *  - Library names are validated: must be non-empty strings of printable ASCII.
 *  - Version strings are validated: must match SemVer-ish e.g. "1.2.3" or "1.4".
 *  - Duplicate entries (same name) are de-duplicated; the LAST specified version wins.
 */

const VALID_NAME_RE    = /^[\w][\w\s.\-()]*$/;    // Arduino library naming rules
const VALID_VERSION_RE = /^\d+(\.\d+){0,3}$/;     // e.g. "1", "1.4", "6.21.3"
const MAX_LIBRARIES    = 50;                       // safety cap

/**
 * @typedef {{ name: string, version: string | null }} LibraryEntry
 */

/**
 * Parse a `libraries.txt`-formatted string into an array of library entries.
 *
 * @param {string | null | undefined} txt
 * @returns {LibraryEntry[]}
 */
export function parseLibrariesTxt(txt) {
    if (!txt || typeof txt !== 'string') return [];

    const seen   = new Map(); // name (lowercase) → LibraryEntry (de-dup)
    const lines  = txt.split(/\r?\n/);

    for (const raw of lines) {
        const line = raw.trim();

        // Skip blanks and comments
        if (!line || line.startsWith('#')) continue;

        let name, version;

        const atIdx = line.indexOf('@');
        if (atIdx !== -1) {
            name    = line.slice(0, atIdx).trim();
            version = line.slice(atIdx + 1).trim() || null;
        } else {
            name    = line;
            version = null;
        }

        // Validate name
        if (!name || !VALID_NAME_RE.test(name)) {
            console.warn(`[LibraryParser] Skipping invalid library name: "${name}"`);
            continue;
        }

        // Validate version if provided
        if (version && !VALID_VERSION_RE.test(version)) {
            console.warn(`[LibraryParser] Skipping invalid version "${version}" for "${name}"`);
            version = null; // fall back to latest
        }

        seen.set(name.toLowerCase(), { name, version });

        if (seen.size >= MAX_LIBRARIES) {
            console.warn(`[LibraryParser] Reached max library limit (${MAX_LIBRARIES}), truncating.`);
            break;
        }
    }

    return Array.from(seen.values());
}
