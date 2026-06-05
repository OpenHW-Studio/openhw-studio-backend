import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logAdminAction } from './adminController.js';
import { searchLibrariesLocal, getLibraryMetadata } from '../services/libraryIndexService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARDUINO_CLI_PATH = process.env.ARDUINO_CLI_PATH || 'e:\\\\FOSSEE\\\\bin\\\\arduino-cli.exe';

// Simple in-memory cache for library searches to boost performance
const searchCache = new Map();
const CACHE_EXPIRY = 60 * 60 * 1000; // 1 hour

export const searchLibrary = (req, res) => {
    const query = req.query.q?.toLowerCase().trim();
    if (!query) {
        return res.status(400).json({ error: 'Search query "q" is required.' });
    }

    // Try fast local search first
    try {
        const localResults = searchLibrariesLocal(query);
        if (localResults && localResults.length > 0) {
            return res.json({ libraries: localResults });
        }
    } catch (err) {
        console.error('[LibrarySearch] Local fast search failed, falling back to cache/CLI:', err.message);
    }

    // Check Cache
    const cached = searchCache.get(query);
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRY)) {
        return res.json({ libraries: cached.data, cached: true });
    }

    // Run: arduino-cli lib search "query" --format json
    execFile(ARDUINO_CLI_PATH, ['lib', 'search', query, '--format', 'json'], { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
            console.error('Library search error:', stderr || stdout);
            return res.status(500).json({ error: 'Failed to search library.' });
        }

        try {
            const jsonStr = stdout.substring(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
            if (!jsonStr) throw new Error("No JSON found in stdout");

            const data = JSON.parse(jsonStr);
            const libraries = data.libraries || [];

            // Store in Cache
            searchCache.set(query, {
                timestamp: Date.now(),
                data: libraries
            });

            return res.json({ libraries });
        } catch (parseErr) {
            console.error('Failed to parse search results:', parseErr);
            return res.status(500).json({ error: 'Failed to parse search results.' });
        }
    });
};

export const listLibraries = (req, res) => {
    try {
        const PERM_DIR = path.resolve(__dirname, '../../../data/libraries/permanent');
        if (!fs.existsSync(PERM_DIR)) {
            return res.json({ libraries: [] });
        }
        
        // Scan PERM_DIR for folders and try to read library.properties to get the exact version
        const libs = [];
        for (const entry of fs.readdirSync(PERM_DIR, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const name = entry.name;
                let version = 'unknown';
                
                // Try reading library.properties for actual version
                const propPath = path.join(PERM_DIR, name, 'library.properties');
                if (fs.existsSync(propPath)) {
                    const props = fs.readFileSync(propPath, 'utf8');
                    const verMatch = props.match(/^version=(.*)/m);
                    if (verMatch) version = verMatch[1].trim();
                }
                
                libs.push({
                    library: {
                        name: name.replace(/@.*/, ''), // Strip version from folder name if present
                        version: version
                    }
                });
            }
        }
        
        return res.json({ libraries: libs });
    } catch (err) {
        console.error('Failed to list permanent libraries:', err);
        return res.status(500).json({ error: 'Failed to list installed libraries.' });
    }
};

import { fetchAndExtractLibrary, syncPermanentLibraries, syncLibrariesIndexFile } from '../services/dynamicLibraryManager.js';
import fs from 'fs';

const CONFIG_FILE = path.resolve(__dirname, '../config/libraries.json');
const CACHE_DIR = path.resolve(__dirname, '../../../data/libraries/cache');
const PERM_DIR = path.resolve(__dirname, '../../../data/libraries/permanent');

export const getLibrariesConfig = (req, res) => {
    try {
        const totalSize = getDirectorySize(PERM_DIR);
        if (!fs.existsSync(CONFIG_FILE)) {
            return res.json({ permanent: [], totalSize });
        }
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return res.json({ permanent: config.permanent || [], totalSize });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to read libraries.json' });
    }
};

export const updateLibrariesConfig = async (req, res) => {
    const { permanent } = req.body;
    if (!Array.isArray(permanent)) {
        return res.status(400).json({ error: 'Invalid config format: expected an array of permanent libraries' });
    }
    
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ permanent }, null, 4));
        // Trigger sync asynchronously in background
        syncPermanentLibraries().catch(err => console.error('Background sync failed:', err));
        return res.json({ success: true, message: 'Configuration updated and sync started.' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to write libraries.json' });
    }
};

function getDirectorySize(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        total += entry.isDirectory() ? getDirectorySize(full) : fs.statSync(full).size;
    }
    return total;
}

export const getCachedLibraries = (req, res) => {
    try {
        if (!fs.existsSync(CACHE_DIR)) return res.json({ cached: [] });
        const libs = fs.readdirSync(CACHE_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => {
                const p = path.join(CACHE_DIR, d.name);
                return {
                    name: d.name,
                    size: getDirectorySize(p),
                    lastUsed: fs.statSync(p).atimeMs
                };
            })
            .sort((a, b) => b.size - a.size);
        return res.json({ cached: libs });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to read cache directory' });
    }
};

export const clearCache = (req, res) => {
    const { name } = req.body;
    try {
        if (name) {
            const target = path.join(CACHE_DIR, name);
            if (fs.existsSync(target)) {
                fs.rmSync(target, { recursive: true, force: true });
            }
            syncLibrariesIndexFile();
            return res.json({ success: true, message: `Cleared cached library: ${name}` });
        } else {
            if (fs.existsSync(CACHE_DIR)) {
                fs.rmSync(CACHE_DIR, { recursive: true, force: true });
                fs.mkdirSync(CACHE_DIR, { recursive: true });
            }
            syncLibrariesIndexFile();
            return res.json({ success: true, message: 'Cleared all cached libraries.' });
        }
    } catch (err) {
        return res.status(500).json({ error: 'Failed to clear cache' });
    }
};

export const installLibrary = async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Library name is required.' });
    }

    // SECURITY: Log install attempt
    await logAdminAction(
        req.user?.email || 'unknown-admin',
        'INSTALL_LIBRARY',
        `Installing library: ${name}`,
        { library: name },
        req.ip
    );

    try {
        // Read config
        let config = { permanent: [] };
        if (fs.existsSync(CONFIG_FILE)) {
            config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
        if (!config.permanent.includes(name)) {
            config.permanent.push(name);
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));
        }

        let baseName = name;
        let version = null;
        if (name.includes('@')) {
            const parts = name.split('@');
            baseName = parts[0];
            version = parts[1];
        }

        await fetchAndExtractLibrary(baseName, PERM_DIR, version);
        syncLibrariesIndexFile();
        return res.json({ success: true, message: `Successfully installed ${name} to permanent pool.` });
    } catch (error) {
        console.error('Library install error:', error);
        return res.status(500).json({ error: 'Failed to install library: ' + error.message });
    }
};

export const uninstallLibrary = async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Library "name" is required for uninstallation.' });
    }

    // SECURITY: Log uninstall attempt
    await logAdminAction(
        req.user?.email || 'unknown-admin',
        'UNINSTALL_LIBRARY',
        `Uninstalling library: ${name}`,
        { library: name },
        req.ip
    );

    try {
        // Update config
        if (fs.existsSync(CONFIG_FILE)) {
            let config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            if (config.permanent.includes(name)) {
                config.permanent = config.permanent.filter(n => n !== name);
                fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));
            }
        }
        
        // Remove directory
        const libPath = path.join(PERM_DIR, name);
        if (fs.existsSync(libPath)) {
            fs.rmSync(libPath, { recursive: true, force: true });
        }
        
        syncLibrariesIndexFile();
        return res.json({ success: true, message: `Successfully uninstalled ${name}.` });
    } catch (error) {
        console.error('Library uninstall error:', error);
        return res.status(500).json({ error: 'Failed to uninstall library: ' + error.message });
    }
};

export const getLibrariesInfo = (req, res) => {
    const namesQuery = req.query.names;
    if (!namesQuery) {
        return res.status(400).json({ error: 'Query parameter "names" is required.' });
    }
    const names = namesQuery.split(',').map(n => n.trim()).filter(Boolean);
    const libraries = {};
    for (const name of names) {
        try {
            const meta = getLibraryMetadata(name);
            if (meta) {
                libraries[name.toLowerCase()] = {
                    name: meta.name,
                    sentence: meta.sentence,
                    author: meta.author,
                    website: meta.website,
                    version: meta.latest?.version
                };
            }
        } catch (err) {
            console.error(`[LibraryInfo] Failed to resolve metadata for "${name}":`, err.message);
        }
    }
    return res.json({ libraries });
};
