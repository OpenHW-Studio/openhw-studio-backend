/**
 * libraryBoot.js — src/compiler/libraryBoot.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Boot-time setup owned by whichever process runs the compiler:
 *   - ROLE=compiler  → compiler-worker boot
 *   - ROLE unset     → single-service local dev boot
 *   - ROLE=main      → SKIPPED (the worker owns the library pool + compile
 *                      cache; the main backend only proxies execution paths)
 *
 * Creates temp/data dirs, loads the library index, and syncs permanent libs.
 */

import fs from 'fs';
import path from 'path';
import { syncPermanentLibraries } from '../services/dynamicLibraryManager.js';
import { initLibraryIndexService } from '../services/libraryIndexService.js';
import { getBackendRoot, getCacheDir, getPermanentDir, ensureDir } from './paths.js';

/** @returns {boolean} true when this process should own library + compile boot */
export function ownsCompilerBoot() {
    return process.env.ROLE === 'compiler' || !process.env.ROLE;
}

export async function initCompilerBoot() {
    if (!ownsCompilerBoot()) {
        console.log('[Compiler] ROLE=main: library pool + compile cache owned by compiler-worker — skipping local boot.');
        return;
    }

    // Ensure required directories and files exist
    const backendRoot = getBackendRoot();
    const tempDir = path.join(backendRoot, 'temp');
    const dataDir = path.join(backendRoot, 'data/components');
    const indexFile = path.join(dataDir, 'index.ts');

    [tempDir, dataDir].forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Created directory: ${dir}`);
        }
    });

    // --- Boot Synchronization for Shared Library Pool ---
    // Same DATA_ROOT as the compiler services (src/compiler/paths.js),
    // so boot-created dirs are the dirs compiles actually read.
    [getPermanentDir(), getCacheDir()].forEach((dir) => {
        ensureDir(dir);
    });

    // Initialize Library Index Service (loads / updates library_index.json)
    initLibraryIndexService();

    // Synchronize libraries listed in data/libraries.json
    console.log('Boot Sync: Checking permanent libraries pool...');
    await syncPermanentLibraries();

    if (!fs.existsSync(indexFile)) {
        fs.writeFileSync(indexFile, '\n');
        console.log(`Initialized: ${indexFile}`);
    }
}
