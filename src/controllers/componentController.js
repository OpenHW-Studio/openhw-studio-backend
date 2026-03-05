import fs from 'fs';
import path from 'path';

const EMULATOR_COMPONENTS_PATH = path.resolve(process.cwd(), '../openhw-studio-emulator-danish/src/components');

let pendingComponentsStore = [];

export const submitComponent = (req, res) => {
    try {
        const { id, manifest, ui, logic, validation, index } = req.body;
        if (!id || !manifest) return res.status(400).json({ error: 'Invalid component submission.' });

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
        const { id, manifest, ui, logic, validation, index } = req.body;

        if (!id || !manifest || !ui || !logic || !index) {
            return res.status(400).json({ error: 'Missing required component files. Ensure id, manifest, ui, logic, and index are provided.' });
        }

        const componentDir = path.join(EMULATOR_COMPONENTS_PATH, id);

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
        let indexContent = fs.readFileSync(mainIndexFile, 'utf8');

        // Clean ID for valid ES6 export identifier
        const safeExportName = (manifest.exportName || id).replace(/-([a-z0-9])/g, (g) => g[1].toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
        const exportLine = `export { default as ${safeExportName} } from './${id}';`;
        if (!indexContent.includes(`./${id}'`) && !indexContent.includes(`./${id}"`)) {
            indexContent += `\n${exportLine}\n`;
            fs.writeFileSync(mainIndexFile, indexContent);
        }

        // 4. Remove from pending store
        pendingComponentsStore = pendingComponentsStore.filter(c => c.id !== id);

        return res.json({ success: true, message: `Successfully installed component ${id} to backend.` });
    } catch (error) {
        console.error('Component approval error:', error);
        return res.status(500).json({ error: 'Failed to approve component.' });
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
        return res.status(500).json({ error: 'Failed to fetch installed components.' });
    }
};

export const deleteInstalledComponent = (req, res) => {
    try {
        const { id } = req.params;
        const componentDir = path.join(EMULATOR_COMPONENTS_PATH, id);
        if (fs.existsSync(componentDir)) {
            fs.rmSync(componentDir, { recursive: true, force: true });
        }

        const mainIndexFile = path.join(EMULATOR_COMPONENTS_PATH, 'index.ts');
        if (fs.existsSync(mainIndexFile)) {
            let indexContent = fs.readFileSync(mainIndexFile, 'utf8');
            const lines = indexContent.split('\n').filter(line => !line.includes(`'./${id}'`) && !line.includes(`"./${id}"`));
            fs.writeFileSync(mainIndexFile, lines.join('\n'));
        }

        return res.json({ success: true, message: `Component ${id} deleted successfully.` });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to delete component.' });
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
                        files[file] = fs.readFileSync(path.join(itemPath, file), 'utf8');
                    }
                    components.push({ id: item, files });
                }
            }
        }
        return res.json({ components });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to backup components.' });
    }
};
