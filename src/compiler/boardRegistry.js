/**
 * boardRegistry.js — src/compiler/boardRegistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for every board the compiler-worker can build.
 *
 * Each board entry declares:
 *   - fqbn matchers (lowercase substrings that identify the board family)
 *   - default builder ('arduino-cli' or 'pico-sdk')
 *   - supported artifacts (subset of: hex, uf2, bin, elf, map)
 *   - default artifacts returned when the frontend omits `artifacts`
 *   - resource cost tag passed to the resource manager / compile queue
 *
 * To add a board later (e.g. esp32s3, stm32):
 *   1. add an entry here with its fqbn matcher + artifact table
 *   2. add its arduino core to Dockerfile.compiler
 *   3. add a compile handler in src/controllers/compileController.js
 *      (or a per-board module under src/compiler/boards/)
 * No route, proxy, or frontend-contract change is needed.
 */

export const SUPPORTED_ARTIFACTS = Object.freeze(['hex', 'uf2', 'bin', 'elf', 'map']);

const BOARD_DEFINITIONS = Object.freeze([
    {
        id: 'uno',
        label: 'Arduino Uno',
        fqbnMatchers: ['arduino:avr:uno'],
        defaultBuilder: 'arduino-cli',
        supportedArtifacts: Object.freeze(['hex', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['hex', 'elf']),
        costTarget: 'uno',
    },
    {
        id: 'pico',
        label: 'Raspberry Pi Pico',
        fqbnMatchers: ['rp2040:rp2040'],
        defaultBuilder: 'arduino-cli',
        // pico-sdk builder resolves to the same family; switching builder
        // does not change which fqbn strings match this entry.
        supportedArtifacts: Object.freeze(['uf2', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['uf2', 'elf']),
        costTarget: 'pico',
    },
]);

/**
 * Find the board definition matching an fqbn string.
 * @param {string} fqbn
 * @returns {object|null}
 */
export function resolveBoard(fqbn) {
    const lowered = String(fqbn || '').trim().toLowerCase();
    if (!lowered) return null;
    return BOARD_DEFINITIONS.find((board) =>
        board.fqbnMatchers.some((matcher) => lowered.includes(matcher)),
    ) || null;
}

/**
 * Validate + normalize a frontend `artifacts` request list.
 * Unknown names are dropped (never hard-fail: old frontends keep working).
 * Empty/omitted input falls back to the board's default artifacts.
 *
 * @param {string|string[]} requested
 * @param {object} board - board definition from resolveBoard()
 * @returns {string[]} normalized artifact list (non-empty)
 */
export function normalizeArtifactRequest(requested, board) {
    const supported = board?.supportedArtifacts || SUPPORTED_ARTIFACTS;
    const defaults = board?.defaultArtifacts || ['hex'];

    const list = Array.isArray(requested) ? requested : (
        typeof requested === 'string' && requested.trim()
            ? requested.split(',').map((s) => s.trim())
            : []
    );

    const normalized = [...new Set(
        list
            .map((name) => String(name || '').trim().toLowerCase())
            .filter((name) => supported.includes(name)),
    )];

    return normalized.length > 0 ? normalized : [...defaults];
}

/**
 * Check whether an fqbn belongs to a board family this worker can compile.
 * @param {string} fqbn
 * @returns {boolean}
 */
export function isSupportedFqbn(fqbn) {
    return resolveBoard(fqbn) !== null;
}

export function listBoards() {
    return BOARD_DEFINITIONS.map((board) => ({
        id: board.id,
        label: board.label,
        fqbnMatchers: [...board.fqbnMatchers],
        defaultBuilder: board.defaultBuilder,
        supportedArtifacts: [...board.supportedArtifacts],
        defaultArtifacts: [...board.defaultArtifacts],
    }));
}
