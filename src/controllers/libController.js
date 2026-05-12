import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logAdminAction } from './adminController.js';

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

    // Run: arduino-cli lib install "name"
    execFile(ARDUINO_CLI_PATH, ['lib', 'install', name], (error, stdout, stderr) => {
        if (error) {
            console.error('Library install error:', stderr || stdout);
            return res.status(500).json({ error: 'Failed to install library.' });
        }
        return res.json({ success: true, message: `Successfully installed ${name}` });
    });
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
