import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..', '..');
const localDataPath = path.resolve(backendRoot, 'data/components');

const resolveFromBackendRoot = (candidate) => (
    path.isAbsolute(candidate) ? candidate : path.resolve(backendRoot, candidate)
);

const resolveFirstExisting = (candidates) => {
    for (const candidate of candidates) {
        const resolvedCandidate = resolveFromBackendRoot(candidate);
        if (fs.existsSync(resolvedCandidate)) {
            return resolvedCandidate;
        }
    }
    return null;
};

const emulatorComponentsPath = (() => {
    if (process.env.EMULATOR_COMPONENTS_PATH) {
        return resolveFromBackendRoot(process.env.EMULATOR_COMPONENTS_PATH);
    }

    if (process.env.EMULATOR_PATH) {
        return path.join(resolveFromBackendRoot(process.env.EMULATOR_PATH), 'src/components');
    }

    const resolvedRoot = resolveFirstExisting([
        '../openhw-studio-emulator-danish',
        '../openhw-studio-emulator',
    ]);

    if (resolvedRoot) {
        return path.join(resolvedRoot, 'src/components');
    }

    return localDataPath;
})();

const EMULATOR_COMPONENTS_PATH = emulatorComponentsPath;
const NORMALIZED_COMPONENTS_ROOT = path.resolve(EMULATOR_COMPONENTS_PATH);
const COMPONENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const sanitizeComponentId = (id) => {
    if (typeof id !== 'string') return null;
    const normalizedId = id.trim();
    if (!normalizedId || !COMPONENT_ID_PATTERN.test(normalizedId)) return null;
    if (path.basename(normalizedId) !== normalizedId) return null;
    return normalizedId;
};

const isValidComponentId = (id) => Boolean(sanitizeComponentId(id));

const resolveSafeComponentDir = (id) => {
    const safeId = sanitizeComponentId(id);
    if (!safeId) {
        const err = new Error('Invalid component id. Use 1-64 characters, start with a letter/number, and only use letters, numbers, hyphens, or underscores.');
        err.statusCode = 400;
        throw err;
    }

    const componentDir = path.normalize(path.join(NORMALIZED_COMPONENTS_ROOT, safeId));
    const withinRoot = componentDir === NORMALIZED_COMPONENTS_ROOT || componentDir.startsWith(`${NORMALIZED_COMPONENTS_ROOT}${path.sep}`);
    if (!withinRoot) {
        const err = new Error('Invalid component id path characters.');
        err.statusCode = 400;
        throw err;
    }

    return { safeId, componentDir };
};

// Ensure the directory exists to prevent ENOENT crashes
if (!fs.existsSync(EMULATOR_COMPONENTS_PATH)) {
    console.log(`Creating component directory at: ${EMULATOR_COMPONENTS_PATH}`);
    fs.mkdirSync(EMULATOR_COMPONENTS_PATH, { recursive: true });
} else {
    console.log(`Using component directory: ${EMULATOR_COMPONENTS_PATH}`);
}

let pendingComponentsStore = [];

export const submitComponent = (req, res) => {
    try {
        const { id, manifest, ui, logic, validation, index } = req.body;
        if (!id || !manifest) return res.status(400).json({ error: 'Invalid component submission.' });
        if (!isValidComponentId(id)) return res.status(400).json({ error: 'Invalid component id. Use 1-64 characters, start with a letter/number, and only use letters, numbers, hyphens, or underscores.' });

        // submissionId is unique per upload so rejecting one copy never drops other submissions
        const submissionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        pendingComponentsStore.push({
            submissionId,
            id,
            manifest,
            uiRaw: ui,
            logicRaw: logic,
            validationRaw: validation,
            indexRaw: index,
            status: 'pending',
            timestamp: new Date().toISOString()
        });

        return res.json({ success: true, message: 'Component submitted successfully for admin review.' });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to submit component.' });
    }
}

export const getPendingComponents = (req, res) => {
    return res.json({ components: pendingComponentsStore });
}

export const rejectComponent = (req, res) => {
    try {
        // Match by submissionId (unique per upload) — never removes sibling submissions of same component id
        const { submissionId } = req.params;
        pendingComponentsStore = pendingComponentsStore.filter(c => c.submissionId !== submissionId);
        return res.json({ success: true, message: `Submission ${submissionId} rejected and removed.` });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to reject component.' });
    }
}

export const approveComponent = async (req, res) => {
    try {
        const { submissionId, id, manifest, ui, logic, validation, index } = req.body;

        if (!submissionId || !id || !manifest || !ui || !logic || !index) {
            return res.status(400).json({ error: 'Missing required component files. Ensure submissionId, id, manifest, ui, logic, and index are provided.' });
        }

        const { safeId, componentDir } = resolveSafeComponentDir(id);

        // 1. Create directory if not exists
        if (!fs.existsSync(componentDir)) {
            fs.mkdirSync(componentDir, { recursive: true });
        }

        // 2. Write files
        fs.writeFileSync(path.join(componentDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        fs.writeFileSync(path.join(componentDir, 'ui.tsx'), ui);
        fs.writeFileSync(path.join(componentDir, 'logic.ts'), logic);
        fs.writeFileSync(path.join(componentDir, 'index.ts'), index);
        if (validation) {
            fs.writeFileSync(path.join(componentDir, 'validation.ts'), validation);
        }

        // 3. Update the emulator's root components/index.ts to export this new component
        const mainIndexFile = path.join(EMULATOR_COMPONENTS_PATH, 'index.ts');
        let indexContent = '';

        if (fs.existsSync(mainIndexFile)) {
            indexContent = fs.readFileSync(mainIndexFile, 'utf8');
        } else {
            console.log(`Creating missing main index file at: ${mainIndexFile}`);
            indexContent = '// OpenHW Studio Component Index\n';
        }

        // Clean ID for valid ES6 export identifier
        const safeExportName = (manifest.exportName || safeId).replace(/-([a-z0-9])/g, (g) => g[1].toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
        const exportLine = `export { default as ${safeExportName} } from './${safeId}';`;
        if (!indexContent.includes(`./${safeId}'`) && !indexContent.includes(`./${safeId}"`)) {
            indexContent += `\n${exportLine}\n`;
            fs.writeFileSync(mainIndexFile, indexContent);
        }

        // 4. Remove from pending store
        pendingComponentsStore = pendingComponentsStore.filter(c => c.submissionId !== submissionId);

        return res.json({ success: true, message: `Successfully installed component ${safeId} to backend.` });
    } catch (error) {
        console.error('CRITICAL: Component approval error:', error);
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).json({
            error: 'Failed to approve component.',
            details: error.message,
            path: EMULATOR_COMPONENTS_PATH
        });
    }
};

export const getInstalledComponents = (req, res) => {
    try {
        const components = [];
        const items = fs.readdirSync(EMULATOR_COMPONENTS_PATH);
        for (const item of items) {
            const itemPath = path.join(EMULATOR_COMPONENTS_PATH, item);
            if (fs.statSync(itemPath).isDirectory()) {
                const manifestPath = path.join(itemPath, 'manifest.json');
                if (fs.existsSync(manifestPath)) {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                    components.push({ id: item, manifest });
                }
            }
        }
        return res.json({ components });
    } catch (error) {
        console.error('CRITICAL: Fetch installed components error:', error);
        return res.status(500).json({
            error: 'Failed to fetch installed components.',
            details: error.message,
            path: EMULATOR_COMPONENTS_PATH
        });
    }
};

export const deleteInstalledComponent = (req, res) => {
    try {
        const { id } = req.params;
        const { safeId, componentDir } = resolveSafeComponentDir(id);
        if (fs.existsSync(componentDir)) {
            fs.rmSync(componentDir, { recursive: true, force: true });
        }

        const mainIndexFile = path.join(EMULATOR_COMPONENTS_PATH, 'index.ts');
        if (fs.existsSync(mainIndexFile)) {
            let indexContent = fs.readFileSync(mainIndexFile, 'utf8');
            const lines = indexContent.split('\n').filter(line => !line.includes(`'./${safeId}'`) && !line.includes(`"./${safeId}"`));
            fs.writeFileSync(mainIndexFile, lines.join('\n'));
        }

        return res.json({ success: true, message: `Component ${safeId} deleted successfully.` });
    } catch (error) {
        console.error('CRITICAL: Delete component error:', error);
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).json({
            error: 'Failed to delete component.',
            details: error.message
        });
    }
};

export const backupInstalledComponents = (req, res) => {
    try {
        const components = [];
        const items = fs.readdirSync(EMULATOR_COMPONENTS_PATH);
        for (const item of items) {
            const itemPath = path.join(EMULATOR_COMPONENTS_PATH, item);
            if (fs.statSync(itemPath).isDirectory()) {
                const manifestPath = path.join(itemPath, 'manifest.json');
                if (fs.existsSync(manifestPath)) {
                    const files = {};
                    const dirFiles = fs.readdirSync(itemPath);
                    for (const file of dirFiles) {
                        const filePath = path.join(itemPath, file);
                        if (!fs.statSync(filePath).isFile()) continue; // skip subdirs like doc/
                        files[file] = fs.readFileSync(filePath, 'utf8');
                    }
                    components.push({ id: item, files });
                }
            }
        }
        return res.json({ components });
    } catch (error) {
        console.error('CRITICAL: Backup components error:', error);
        return res.status(500).json({
            error: 'Failed to backup components.',
            details: error.message
        });
    }
};
