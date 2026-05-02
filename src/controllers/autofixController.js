import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runAutofixController(req, res) {
  try {
    const project = req.body.project;
    const issue = req.body.issue || { message: 'missing_ground_connection', compIds: [] };

    const indexPath = path.resolve(__dirname, '..', '..', '..', 'openhw-studio-emulator', 'src', 'circuit-validation', 'index.js');
    const mod = await import(pathToFileURL(indexPath).href);
    const applyCircuitFix = mod.applyCircuitFix;
    if (!applyCircuitFix) {
      return res.status(500).json({ error: 'Autofix engine not available' });
    }

    const engineConnections = (project.connections || []).map(wire => ({
      from: String(wire.from || '').replace(':', '.'),
      to:   String(wire.to || '').replace(':', '.'),
    }));

    const projectData = { components: project.components || [], connections: engineConnections };

    const result = applyCircuitFix(projectData, issue, { appliedBy: 'mcp' });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

function pathToFileURL(p) { return new URL('file://' + p); }
