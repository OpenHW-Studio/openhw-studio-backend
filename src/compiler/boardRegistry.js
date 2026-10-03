/**
 * boardRegistry.js — src/compiler/boardRegistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for every board the compiler-worker can build.
 *
 * Each board entry declares:
 *   - fqbn matchers (lowercase substrings that identify the board family)
 *   - default builder ('arduino-cli')
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
        id: 'nano',
        label: 'Arduino Nano (ATmega328P, old bootloader)',
        // Same arduino:avr core as Uno (already installed); the
        // atmega328old cpu option only selects the bootloader, which the
        // simulator does not model — the hex is chip-identical to Uno.
        fqbnMatchers: ['arduino:avr:nano'],
        defaultBuilder: 'arduino-cli',
        supportedArtifacts: Object.freeze(['hex', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['hex', 'elf']),
        costTarget: 'uno',
    },
    {
        id: 'mega',
        label: 'Arduino Mega 2560',
        // Same arduino:avr core as Uno (already installed); ATmega2560
        // hex runs on the AVRRunner mega peripheral set (mega-timers).
        fqbnMatchers: ['arduino:avr:mega'],
        defaultBuilder: 'arduino-cli',
        supportedArtifacts: Object.freeze(['hex', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['hex', 'elf']),
        costTarget: 'uno',
    },
    {
        id: 'pico2',
        label: 'Raspberry Pi Pico 2 (RP2350)',
        // BEFORE pico: 'rpipico2' also contains 'rpipico', and
        // 'wiznet_5500_evb_pico2' contains 'wiznet_5500_evb_pico' —
        // resolveBoard uses find(), so this entry must precede the pico
        // entry for Pico 2 FQBNs to resolve here.
        fqbnMatchers: ['rpipico2', 'rp2350', 'rpipico2w', 'wiznet_5500_evb_pico2', 'pico2'],
        defaultBuilder: 'arduino-cli',
        supportedArtifacts: Object.freeze(['uf2', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['uf2', 'elf']),
        costTarget: 'pico',
    },
    {
        id: 'pico',
        label: 'Raspberry Pi Pico (RP2040)',
        fqbnMatchers: ['rp2040:rp2040', 'rpipico', 'rpipicow', 'wiznet_5500_evb_pico', 'wiznet_6300'],
        defaultBuilder: 'arduino-cli',
        supportedArtifacts: Object.freeze(['uf2', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['uf2', 'elf']),
        costTarget: 'pico',
    },
    {
        id: 'esp32',
        label: 'ESP32 DevKit',
        fqbnMatchers: ['esp32:esp32'],
        defaultBuilder: 'arduino-cli',
        supportedArtifacts: Object.freeze(['bin', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['bin', 'elf']),
        costTarget: 'esp32',
    },
    {
        id: 'stm32f1',
        label: 'STM32F1 Blue Pill',
        // GenF1 pnum parts + Nucleo-64 F103RB (all compile via arduino-cli,
        // same STM32 core). GD32 parts have no core entry — they compile as
        // the closest STM32F103 part; the runner still applies the GD32
        // IDCODE via the chip opt (see gapStm32f1.md).
        fqbnMatchers: [':genf1', 'bluepill', 'maplemini', 'nucleo_64', 'nucleo_f103rb', 'generic_f103'],
        defaultBuilder: 'arduino-cli',
        supportedArtifacts: Object.freeze(['bin', 'hex', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['bin', 'elf']),
        costTarget: 'stm32f1',
    },
    {
        id: 'stm32f4',
        label: 'STM32F4 Discovery',
        fqbnMatchers: ['stmicroelectronics:stm32:disco', 'disco_f407vg', 'disco_f429zi', ':genf4', 'blackpill_f401', 'blackpill_f411', 'black_f407ve', 'f407', 'f401', 'f411', 'f429'],
        defaultBuilder: 'arduino-cli',
        supportedArtifacts: Object.freeze(['bin', 'hex', 'elf', 'map']),
        defaultArtifacts: Object.freeze(['bin', 'elf']),
        costTarget: 'stm32f4',
    },
    {
        // Retro 8/16-bit boards (8086emu): no arduino FQBN — the frontend
        // assembles .asm in-WASM and never calls /compile for these kinds.
        // The entry exists so isSupportedFqbn('retro:8086') is true for
        // validation/routing code that gates on registry membership.
        id: 'retro',
        label: 'Retro 8/16-bit (8086emu assembler)',
        fqbnMatchers: ['retro:'],
        defaultBuilder: 'retro-asm',
        supportedArtifacts: Object.freeze(['asm']),
        defaultArtifacts: Object.freeze(['asm']),
        costTarget: 'retro',
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
