/**
 * calibrationSuite.js  —  src/services/calibrationSuite.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Automated Calibration Suite. Runs worst-case compilations to measure peak RAM.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../../data');
const BUDGET_FILE = path.join(DATA_DIR, 'calibrated_budget.json');

const DEFAULT_BUDGET = {
    uno_compile: 150,
    uno_sim: 50,
    pico_compile: 300,
    pico_sim: 100,
    esp32_compile: 800,
    esp32_sim: 250,
    stm32_compile: 400,
    stm32_sim: 150
};

// Simple helper to get current used memory in MB
function getUsedMemoryMB() {
    return Math.round((os.totalmem() - os.freemem()) / (1024 * 1024));
}

/**
 * Runs a test compilation and measures peak RAM delta.
 */
async function measureCompileRAM(target, fqbn, sketchContent) {
    const testId = `calibrate-${target}-${Date.now()}`;
    const testDir = path.join(os.tmpdir(), testId);
    const sketchDir = path.join(testDir, 'sketch');
    const buildDir = path.join(testDir, 'build');

    try {
        fs.mkdirSync(sketchDir, { recursive: true });
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(path.join(sketchDir, 'sketch.ino'), sketchContent);

        const arduinoCli = process.env.ARDUINO_CLI_PATH || 'arduino-cli';
        const cmd = `"${arduinoCli}" compile --fqbn ${fqbn} --build-path "${buildDir}" "${sketchDir}"`;

        const startMem = getUsedMemoryMB();
        let peakMem = startMem;

        const interval = setInterval(() => {
            const current = getUsedMemoryMB();
            if (current > peakMem) {
                peakMem = current;
            }
        }, 50);

        console.log(`[Calibration] Running test compilation for ${target}...`);
        await new Promise((resolve) => {
            exec(cmd, { timeout: 60000 }, (error) => {
                clearInterval(interval);
                resolve();
            });
        });

        const delta = peakMem - startMem;
        // 20% safety margin, minimum of 100MB
        const calibratedCost = Math.max(100, Math.round(delta * 1.2));
        console.log(`[Calibration] Measured ${target} compile RAM: delta=${delta}MB, calibratedCost=${calibratedCost}MB`);
        return calibratedCost;
    } catch (err) {
        console.error(`[Calibration] Failed to measure compile RAM for ${target}, using fallback.`, err);
        return DEFAULT_BUDGET[`${target}_compile`] || 200;
    } finally {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (_) {}
    }
}

export async function runCalibration() {
    console.log('[Calibration] Starting Automated Calibration Suite...');
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const budget = { ...DEFAULT_BUDGET };

    // ESP32 test sketch
    const esp32Sketch = `
    #include <WiFi.h>
    #include <WiFiClient.h>
    #include <WebServer.h>
    WebServer server(80);
    void setup() {
        WiFi.begin("ssid", "pass");
        server.begin();
    }
    void loop() {
        server.handleClient();
    }
    `;

    // Uno test sketch
    const unoSketch = `
    void setup() {}
    void loop() {}
    `;

    // STM32 test sketch
    const stm32Sketch = `
    void setup() {}
    void loop() {}
    `;

    // Measure ESP32 compile cost if possible
    try {
        const espCost = await measureCompileRAM('esp32', 'esp32:esp32:esp32', esp32Sketch);
        budget.esp32_compile = espCost;
    } catch (_) {}

    // Measure Uno compile cost
    try {
        const unoCost = await measureCompileRAM('uno', 'arduino:avr:uno', unoSketch);
        budget.uno_compile = unoCost;
    } catch (_) {}

    // Measure STM32 compile cost
    try {
        const stm32Cost = await measureCompileRAM('stm32', 'STMicroelectronics:stm32:GenF1', stm32Sketch);
        budget.stm32_compile = stm32Cost;
    } catch (_) {}

    // Save calibrated budget
    try {
        fs.writeFileSync(BUDGET_FILE, JSON.stringify(budget, null, 4));
        console.log(`[Calibration] Calibration complete. Config saved to ${BUDGET_FILE}`);
    } catch (err) {
        console.error('[Calibration] Failed to save calibrated budget:', err);
    }

    return budget;
}

export function loadCalibratedBudget() {
    if (fs.existsSync(BUDGET_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
        } catch (_) {
            return DEFAULT_BUDGET;
        }
    }
    return DEFAULT_BUDGET;
}
