import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function validateCircuitController(req, res) {
  try {
    const project = req.body?.project;
    if (!project || typeof project !== 'object') {
      return res.status(400).json({ error: 'Invalid request: project is required' });
    }

    // Import the emulator's full circuit validator dynamically
    const indexPath = path.resolve(__dirname, '..', '..', '..', 'openhw-studio-emulator', 'src', 'circuit-validation', 'index.js');
    const mod = await import(pathToFileURL(indexPath).href);
    const FullCircuitValidator = mod.FullCircuitValidator;

    if (!FullCircuitValidator) {
      return res.status(500).json({ error: 'FullCircuitValidator missing from emulator build' });
    }

    const validator = new FullCircuitValidator(project);
    const isSafe = validator.runValidation({ profile: 'balanced' });
    
    return res.json({ safe: isSafe, errors: validator.errors || [] });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
