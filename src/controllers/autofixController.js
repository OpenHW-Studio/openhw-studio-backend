import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runAutofixController(req, res) {
  try {
    const project = req.body?.project;
    const issue = req.body.issue || { message: 'missing_ground_connection', compIds: [] };

    if (!project || typeof project !== 'object') {
      return res.status(400).json({ error: 'Invalid request: project is required' });
    }

    const indexPath = path.resolve(__dirname, '..', '..', '..', 'openhw-studio-emulator', 'src', 'circuit-validation', 'index.js');
    const mod = await import(pathToFileURL(indexPath).href);
    const runAutoFix = mod.runAutoFix;
    if (!runAutoFix) {
      return res.status(500).json({ error: 'runAutoFix not available from autofix engine' });
    }

    const result = runAutoFix(project, issue, { appliedBy: 'mcp', quiet: true });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
