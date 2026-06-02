import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logAdminAction } from './adminController.js';
import { searchLibrariesLocal, getLibraryMetadata } from '../services/libraryIndexService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARDUINO_CLI_PATH = 'arduino-cli';

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
    // Run: arduino-cli lib list --format json
    execFile(ARDUINO_CLI_PATH, ['lib', 'list', '--format', 'json'], (error, stdout, stderr) => {
        if (error) {
            console.error('Library list error:', stderr || stdout);
            return res.status(500).json({ error: 'Failed to list installed libraries.' });
        }

        try {
            const jsonStr = stdout.substring(stdout.indexOf('['), stdout.lastIndexOf(']') + 1);
            if (!jsonStr) {
                // If no brackets found, it might mean 0 libraries are installed. Let's return empty.
                return res.json({ libraries: [] });
            }
            const data = JSON.parse(jsonStr);
            return res.json({ libraries: data || [] });
        } catch (parseErr) {
            console.error('Failed to parse list results', parseErr);
            return res.status(500).json({ error: 'Failed to parse installed libraries list.' });
        }
    });
};

import { fetchAndExtractLibrary } from '../services/dynamicLibraryManager.js';

export const installLibrary = async (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Library "name" is required.' });
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
        await fetchAndExtractLibrary(name);
        return res.json({ success: true, message: `Successfully installed ${name} to cache.` });
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

    // Run: arduino-cli lib uninstall "name"
    execFile(ARDUINO_CLI_PATH, ['lib', 'uninstall', name], (error, stdout, stderr) => {
        if (error) {
            console.error('Library uninstall error:', stderr || stdout);
            return res.status(500).json({ error: 'Failed to uninstall library.' });
        }
        return res.json({ success: true, message: `Successfully uninstalled ${name}` });
    });
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
