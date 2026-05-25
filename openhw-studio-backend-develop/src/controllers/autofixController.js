import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runAutofixController(req, res) {
  try {
    let project = req.body?.project;
    let currentIssue = req.body.issue || { message: 'missing_ground_connection', compIds: [] };

    if (!project || typeof project !== 'object') {
      return res.status(400).json({ error: 'Invalid request: project is required' });
    }

    const indexPath = path.resolve(__dirname, '..', '..', '..', 'openhw-studio-emulator', 'src', 'circuit-validation', 'index.js');
    const mod = await import(pathToFileURL(indexPath).href);
    const { runAutoFix, FullCircuitValidator } = mod;
    
    if (!runAutoFix || !FullCircuitValidator) {
      return res.status(500).json({ error: 'runAutoFix or FullCircuitValidator not available from emulator' });
    }

    let iterations = 0;
    let lastResult = null;
    let totalFixesApplied = [];

    // Setup an internal loop using the validator dynamically
    while (currentIssue && iterations < 5) {
      iterations++;
      lastResult = runAutoFix(project, currentIssue, { appliedBy: 'backend', quiet: true });
      
      if (!lastResult?.applied) break;
      totalFixesApplied.push(lastResult.appliedFixes?.[0]?.description);
      
      // Update state for re-validation
      project.components = lastResult.components;
      project.connections = lastResult.connections;

      // Ensure new issues aren't introduced
      const validator = new FullCircuitValidator(project);
      const isSafe = validator.runValidation();
      
      if (isSafe || !validator.errors?.length) break; 
      currentIssue = validator.errors[0]; // Feed the newly discovered error back in
    }

    return res.json({
        ...lastResult, 
        loopIterations: iterations, 
        totalFixesApplied, 
        applied: totalFixesApplied.length > 0 
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
