import { execFile } from 'child_process';

const ARDUINO_CLI_PATH = 'arduino-cli';

export const searchLibrary = (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Search query "q" is required.' });
    }

    // Run: arduino-cli lib search "query" --format json
    // Use a large maxBuffer (50MB) because the Arduino library index is massive
    execFile(ARDUINO_CLI_PATH, ['lib', 'search', query, '--format', 'json'], { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
        if (error) {
            console.error('Library search error:', stderr || stdout);
            return res.status(500).json({ error: 'Failed to search library.' });
        }

        try {
            // Arduino-CLI sometimes leaks warning text before the JSON payload.
            // We use Regex to extract just the outermost {} wrapper.
            const jsonStr = stdout.substring(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1);
            if (!jsonStr) throw new Error("No JSON found in stdout");

            const data = JSON.parse(jsonStr);
            return res.json({ libraries: data.libraries || [] });
        } catch (parseErr) {
            console.error('Failed to parse search results:', parseErr);
            console.error('Raw stdout was:', stdout.substring(0, 500) + '...');
            return res.status(500).json({ error: 'Failed to parse search results from arduino-cli.' });
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

export const installLibrary = (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Library "name" is required.' });
    }

    // Run: arduino-cli lib install "name"
    execFile(ARDUINO_CLI_PATH, ['lib', 'install', name], (error, stdout, stderr) => {
        if (error) {
            console.error('Library install error:', stderr || stdout);
            return res.status(500).json({ error: 'Failed to install library.' });
        }
        return res.json({ success: true, message: `Successfully installed ${name}` });
    });
};
