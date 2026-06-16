/**
 * hotPoolManager.js  —  src/services/hotPoolManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages a pool of pre-warmed QEMU (ESP32) and Renode (STM32) VMs so that
 * users experience near-zero boot time on their first "Run".
 *
 * Strategy: keep exactly 1 idle instance per hardware target. When a compile
 * completes and a user needs a runner:
 *   1.  Pop the idle runner from the pool.
 *   2.  Immediately start a background replenishment (async, non-blocking).
 *   3.  Assign the session to the popped runner and hot-reload the firmware.
 *
 * If the pool is empty (e.g. the server just started and the idle VM has not
 * booted yet), the caller falls back to the normal cold-start path.
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { execFile, execFileSync } from 'child_process';
import { fileURLToPath }          from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────────────────────

const BUILDS_DIR       = path.resolve(__dirname, '../../builds');
const DATA_DIR         = path.resolve(__dirname, '../../data');
const ARDUINO_CLI_PATH = process.env.ARDUINO_CLI_PATH || 'arduino-cli';
const ESPTOOL_PATH     = process.env.ESPTOOL_PATH     || 'esptool.py';

const ESP32_FQBN = process.env.ESP32_FQBN || 'esp32:esp32:esp32:FlashMode=dio,FlashFreq=40,FlashSize=4M';
const STM32_FQBN = process.env.STM32_FQBN || 'STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8';

// Pre-built dummy firmware cached on disk so we don't recompile every restart
const ESP32_DUMMY_DIR    = path.join(DATA_DIR, 'hotpool/esp32');
const STM32_DUMMY_DIR    = path.join(DATA_DIR, 'hotpool/stm32');
const ESP32_DUMMY_FLASH  = path.join(ESP32_DUMMY_DIR, 'merged-flash.bin');
const STM32_DUMMY_ELF    = path.join(STM32_DUMMY_DIR, 'dummy.elf');

const COMPILE_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS || '120000', 10);

// ─── Dummy sketch source ──────────────────────────────────────────────────────

const ESP32_DUMMY_SKETCH = `
#define setup _sim_user_setup
#define loop  _sim_user_loop

void _sim_user_setup() {}
void _sim_user_loop() { delay(1000); }

#undef setup
#undef loop
#include "SimulatorBridge.h"

void setup() {
    _simBridgeInit_Early();
    _sim_user_setup();
    _simBridgeInit_Late();
    if (!_sim_ready_sent) sim_ready();
}

void loop() {
    _sim_user_loop();
}
`;

const STM32_DUMMY_SKETCH = `
#define setup _sim_user_setup
#define loop  _sim_user_loop
#include "SimulatorBridge.h"
#undef setup
#undef loop
void setup() {}
void loop() { delay(1000); }
`;

// ─── Shim headers to copy into sketch dir ─────────────────────────────────────

const ESP32_SHIMS = [
    { src: path.resolve(__dirname, '../esp32/utils/SimulatorBridge.h'),   dst: 'SimulatorBridge.h'   },
    { src: path.resolve(__dirname, '../esp32/utils/SimulatorBridge.cpp'), dst: 'SimulatorBridge.cpp'  },
    { src: path.resolve(__dirname, '../esp32/utils/SimulatorWire.h'),     dst: 'Wire.h'               },
    { src: path.resolve(__dirname, '../esp32/utils/SimulatorWire.cpp'),   dst: 'Wire.cpp'             },
    { src: path.resolve(__dirname, '../esp32/utils/SimulatorSPI.h'),      dst: 'SPI.h'                },
    { src: path.resolve(__dirname, '../esp32/utils/SimulatorSPI.cpp'),    dst: 'SPI.cpp'              },
];

const STM32_SHIMS = [
    { src: path.resolve(__dirname, '../stm32/utils/STM32SimulatorBridge.h'),   dst: 'SimulatorBridge.h'   },
    { src: path.resolve(__dirname, '../stm32/utils/STM32SimulatorBridge.cpp'), dst: 'SimulatorBridge.cpp'  },
    { src: path.resolve(__dirname, '../stm32/utils/STM32SimulatorWire.h'),     dst: 'Wire.h'               },
    { src: path.resolve(__dirname, '../stm32/utils/STM32SimulatorWire.cpp'),   dst: 'Wire.cpp'             },
    { src: path.resolve(__dirname, '../stm32/utils/STM32SimulatorSPI.h'),      dst: 'SPI.h'                },
    { src: path.resolve(__dirname, '../stm32/utils/STM32SimulatorSPI.cpp'),    dst: 'SPI.cpp'              },
];

// ─── Pool state ───────────────────────────────────────────────────────────────

/** @type {import('../esp32/utils/qemuRunner.js').default[]} */
let _esp32Pool = [];

/** @type {import('../stm32/utils/renodeRunner.js').default[]} */
let _stm32Pool = [];

let _esp32Replenishing = false;
let _stm32Replenishing = false;
let _initialized       = false;

// ─── Helper: find esptool ─────────────────────────────────────────────────────

function _findEsptool() {
    const candidates = [
        { cmd: ESPTOOL_PATH,  args: [] },
        { cmd: 'esptool',     args: [] },
        { cmd: 'python',      args: ['-m', 'esptool'] },
        { cmd: 'python3',     args: ['-m', 'esptool'] },
    ];
    for (const runner of candidates) {
        try {
            execFileSync(runner.cmd, [...runner.args, 'version'], { stdio: 'pipe', timeout: 10_000 });
            return runner;
        } catch { /* try next */ }
    }
    return null;
}

// ─── Dummy firmware builders ──────────────────────────────────────────────────

async function _buildEsp32Dummy() {
    let cacheValid = fs.existsSync(ESP32_DUMMY_FLASH);
    if (cacheValid) {
        try {
            const flashStat = fs.statSync(ESP32_DUMMY_FLASH);
            for (const shim of ESP32_SHIMS) {
                if (fs.existsSync(shim.src)) {
                    const shimStat = fs.statSync(shim.src);
                    if (shimStat.mtime > flashStat.mtime) {
                        console.log(`[HotPool] ⚠️  Shim ${path.basename(shim.src)} is newer than cached ESP32 dummy flash. Invalidating cache...`);
                        cacheValid = false;
                        fs.unlinkSync(ESP32_DUMMY_FLASH);
                        break;
                    }
                }
            }
        } catch (err) {
            cacheValid = false;
        }
    }

    if (cacheValid) {
        console.log('[HotPool] ♻️  Reusing cached ESP32 dummy flash image');
        return ESP32_DUMMY_FLASH;
    }

    console.log('[HotPool] 🔨 Building ESP32 dummy firmware...');
    fs.mkdirSync(ESP32_DUMMY_DIR, { recursive: true });

    const sketchDir = path.join(ESP32_DUMMY_DIR, 'sketch', 'dummy');
    fs.mkdirSync(sketchDir, { recursive: true });

    // Write sketch
    fs.writeFileSync(path.join(sketchDir, 'dummy.ino'), ESP32_DUMMY_SKETCH);

    // Copy shims
    for (const { src, dst } of ESP32_SHIMS) {
        try {
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(sketchDir, dst));
        } catch { /* skip missing shim */ }
    }

    const buildDir = path.join(ESP32_DUMMY_DIR, 'build');
    fs.mkdirSync(buildDir, { recursive: true });

    const cliArgs = [
        'compile',
        '--fqbn',             ESP32_FQBN,
        '--build-cache-path', path.join(DATA_DIR, 'arduino-cache'),
        '--output-dir',       buildDir,
        '--libraries',        path.join(DATA_DIR, 'libraries/permanent'),
        '--libraries',        path.join(DATA_DIR, 'libraries/cache'),
        '--build-property',   'compiler.cpp.extra_flags=-include SimulatorBridge.h',
        path.join(sketchDir, 'dummy.ino'),
    ];

    await new Promise((resolve, reject) => {
        execFile(ARDUINO_CLI_PATH, cliArgs, { timeout: COMPILE_TIMEOUT_MS }, (err, stdout, stderr) => {
            if (err && !fs.existsSync(path.join(buildDir, 'dummy.ino.bin'))) {
                reject(new Error(`ESP32 dummy compile failed: ${stderr || err.message}`));
            } else {
                resolve();
            }
        });
    });

    // Merge flash
    const esptool = _findEsptool();
    if (!esptool) throw new Error('[HotPool] esptool not found — cannot build ESP32 dummy flash');

    const bootloader = path.join(buildDir, 'dummy.ino.bootloader.bin');
    const partTable  = path.join(buildDir, 'dummy.ino.partitions.bin');
    const appBin     = path.join(buildDir, 'dummy.ino.bin');

    execFileSync(esptool.cmd, [
        ...esptool.args,
        '--chip', 'esp32', 'merge_bin',
        '--output', ESP32_DUMMY_FLASH,
        '--fill-flash-size', '4MB',
        '--flash_mode', 'dio', '--flash_size', '4MB', '--flash_freq', '40m',
        '0x1000', bootloader, '0x8000', partTable, '0x10000', appBin,
    ], { stdio: 'pipe', timeout: 30_000 });

    console.log(`[HotPool] ✅ ESP32 dummy flash built → ${ESP32_DUMMY_FLASH}`);
    return ESP32_DUMMY_FLASH;
}

async function _buildStm32Dummy() {
    let cacheValid = fs.existsSync(STM32_DUMMY_ELF);
    if (cacheValid) {
        try {
            const elfStat = fs.statSync(STM32_DUMMY_ELF);
            for (const shim of STM32_SHIMS) {
                if (fs.existsSync(shim.src)) {
                    const shimStat = fs.statSync(shim.src);
                    if (shimStat.mtime > elfStat.mtime) {
                        console.log(`[HotPool] ⚠️  Shim ${path.basename(shim.src)} is newer than cached STM32 dummy ELF. Invalidating cache...`);
                        cacheValid = false;
                        fs.unlinkSync(STM32_DUMMY_ELF);
                        break;
                    }
                }
            }
        } catch (err) {
            cacheValid = false;
        }
    }

    if (cacheValid) {
        console.log('[HotPool] ♻️  Reusing cached STM32 dummy ELF');
        return STM32_DUMMY_ELF;
    }

    console.log('[HotPool] 🔨 Building STM32 dummy firmware...');
    fs.mkdirSync(STM32_DUMMY_DIR, { recursive: true });

    const sketchDir = path.join(STM32_DUMMY_DIR, 'sketch', 'dummy');
    fs.mkdirSync(sketchDir, { recursive: true });

    fs.writeFileSync(path.join(sketchDir, 'dummy.ino'), STM32_DUMMY_SKETCH);

    for (const { src, dst } of STM32_SHIMS) {
        try {
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(sketchDir, dst));
        } catch { /* skip missing shim */ }
    }

    const buildDir = path.join(STM32_DUMMY_DIR, 'build');
    fs.mkdirSync(buildDir, { recursive: true });

    const cliArgs = [
        'compile',
        '--fqbn',             STM32_FQBN,
        '--build-cache-path', path.join(DATA_DIR, 'arduino-cache'),
        '--output-dir',       buildDir,
        '--libraries',        path.join(DATA_DIR, 'libraries/permanent'),
        '--libraries',        path.join(DATA_DIR, 'libraries/cache'),
        '--build-property',   'compiler.cpp.extra_flags=-include SimulatorBridge.h',
        path.join(sketchDir, 'dummy.ino'),
    ];

    await new Promise((resolve, reject) => {
        execFile(ARDUINO_CLI_PATH, cliArgs, { timeout: COMPILE_TIMEOUT_MS }, (err, stdout, stderr) => {
            const outFiles = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
            const elf      = outFiles.find(f => f.toLowerCase().endsWith('.elf'));
            if (!elf) {
                reject(new Error(`STM32 dummy compile failed: ${stderr || (err && err.message) || 'no elf produced'}`));
            } else {
                // Rename the .elf to a stable name
                fs.copyFileSync(path.join(buildDir, elf), STM32_DUMMY_ELF);
                resolve();
            }
        });
    });

    console.log(`[HotPool] ✅ STM32 dummy ELF built → ${STM32_DUMMY_ELF}`);
    return STM32_DUMMY_ELF;
}

// ─── Pool replenishment ───────────────────────────────────────────────────────

async function _replenishEsp32(flashImage) {
    if (_esp32Replenishing) return;
    _esp32Replenishing = true;
    try {
        // Lazy import to avoid circular dependency
        const { default: QemuRunner } = await import('../esp32/utils/qemuRunner.js');
        const poolId   = `pool-esp32-${crypto.randomUUID()}`;
        const pipesDir = path.join(os.tmpdir(), `openhw-pool-${poolId}`);
        fs.mkdirSync(pipesDir, { recursive: true });

        const runner = new QemuRunner(poolId, flashImage, pipesDir, null);
        runner._isPooled = true;

        try {
            runner.start();
        } catch (startErr) {
            console.error('[HotPool] ❌ ESP32 pool VM failed to start:', startErr.message);
            return; // finally will still run
        }

        // Give the VM a few seconds to boot before exposing it to traffic
        await new Promise(r => setTimeout(r, 3000));

        if (!runner._destroyed) {
            _esp32Pool.push(runner);
            console.log(`[HotPool] 🟢 ESP32 idle instance ready (pool size: ${_esp32Pool.length})`);
        } else {
            console.warn('[HotPool] ⚠️  ESP32 pool runner destroyed during boot, skipping');
        }
    } catch (err) {
        console.error('[HotPool] ❌ Failed to replenish ESP32 pool:', err.message);
    } finally {
        _esp32Replenishing = false;
    }
}

async function _replenishStm32(elfPath) {
    if (_stm32Replenishing) return;
    _stm32Replenishing = true;
    try {
        const { default: RenodeRunner }    = await import('../stm32/utils/renodeRunner.js');
        const { default: stm32WsManager } = await import('../stm32/utils/websocketManager.js');

        const poolId  = `pool-stm32-${crypto.randomUUID()}`;
        const buildDir = path.join(BUILDS_DIR, poolId);
        fs.mkdirSync(buildDir, { recursive: true });

        const runner = new RenodeRunner(poolId, elfPath, buildDir, stm32WsManager);
        runner._isPooled = true;

        try {
            runner.start();
            // Robust check: wait until the TCP connection is fully established and option handshake is complete
            await runner.connectionPromise;
        } catch (startErr) {
            console.error('[HotPool] ❌ STM32 pool VM failed to start or connect:', startErr.message);
            try { runner.kill(); } catch {}
            return;
        }

        if (!runner._destroyed) {
            _stm32Pool.push(runner);
            console.log(`[HotPool] 🟢 STM32 idle instance ready (pool size: ${_stm32Pool.length})`);
        } else {
            console.warn('[HotPool] ⚠️  STM32 pool runner destroyed during boot, skipping');
        }
    } catch (err) {
        console.error('[HotPool] ❌ Failed to replenish STM32 pool:', err.message);
    } finally {
        _stm32Replenishing = false;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * initPools()
 *
 * Called once by server.js after boot.  Compiles the dummy firmware on first
 * run (result cached to disk), then spawns one idle VM per target.
 * Non-blocking — any failure just means users get cold-boot instead.
 */
export async function initPools() {
    if (_initialized) return;
    _initialized = true;

    const role = process.env.ROLE;

    // In main/proxy mode, do not warm up any simulation VMs locally.
    if (role === 'main') {
        console.log('[HotPool] ℹ️ Main role: simulation pools skipped.');
        return;
    }

    console.log(`[HotPool] 🚀 Initialising hot pools for role: ${role || 'all'}...`);

    const tasks = [];

    // Only replenish ESP32 pool if we are esp32-worker or running everything locally without role set
    if (!role || role === 'esp32-worker') {
        tasks.push((async () => {
            try {
                const flash = await _buildEsp32Dummy();
                await _replenishEsp32(flash);
            } catch (err) {
                console.error('[HotPool] ESP32 init error:', err.message);
            }
        })());
    }

    // Only replenish STM32 pool if we are stm32-worker or running everything locally without role set
    if (!role || role === 'stm32-worker') {
        tasks.push((async () => {
            try {
                const elf = await _buildStm32Dummy();
                await _replenishStm32(elf);
            } catch (err) {
                console.error('[HotPool] STM32 init error:', err.message);
            }
        })());
    }

    await Promise.allSettled(tasks);
    console.log('[HotPool] ✅ Hot pool initialisation complete');
}

/**
 * acquireEsp32Runner()
 *
 * Pops a pre-warmed ESP32 runner from the pool.  Immediately triggers an
 * async background replenishment so the next user also gets a warm instance.
 * Returns null if the pool is empty.
 *
 * @returns {import('../esp32/utils/qemuRunner.js').default | null}
 */
export function acquireEsp32Runner() {
    while (_esp32Pool.length > 0) {
        const runner = _esp32Pool.shift();
        if (runner && !runner._destroyed) {
            console.log(`[HotPool] 🎯 Acquired ESP32 idle runner (pool size after: ${_esp32Pool.length})`);
            // Replenish in background — don't await
            _buildEsp32Dummy().then(flash => _replenishEsp32(flash)).catch(err => {
                console.error('[HotPool] ESP32 replenishment error:', err.message);
            });
            return runner;
        }
    }
    return null;
}

/**
 * acquireStm32Runner()
 *
 * Pops a pre-warmed STM32 runner from the pool and triggers background
 * replenishment.  Returns null if the pool is empty.
 *
 * @returns {import('../stm32/utils/renodeRunner.js').default | null}
 */
export function acquireStm32Runner() {
    while (_stm32Pool.length > 0) {
        const runner = _stm32Pool.shift();
        if (runner && !runner._destroyed) {
            console.log(`[HotPool] 🎯 Acquired STM32 idle runner (pool size after: ${_stm32Pool.length})`);
            _buildStm32Dummy().then(elf => _replenishStm32(elf)).catch(err => {
                console.error('[HotPool] STM32 replenishment error:', err.message);
            });
            return runner;
        }
    }
    return null;
}

/**
 * shutdown()
 *
 * Gracefully kills all idle pooled runners (called on SIGTERM/SIGINT).
 */
export function shutdown() {
    console.log('[HotPool] 🛑 Shutting down all idle pool runners...');
    for (const r of _esp32Pool) { try { r.kill(); } catch { /* ignore */ } }
    for (const r of _stm32Pool) { try { r.kill(); } catch { /* ignore */ } }
    _esp32Pool = [];
    _stm32Pool = [];
}
