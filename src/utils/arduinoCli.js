import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '../../..');

const localCliPath = process.platform === 'win32'
    ? path.join(workspaceRoot, 'tools', 'arduino-cli', 'arduino-cli.exe')
    : path.join(workspaceRoot, 'tools', 'arduino-cli', 'arduino-cli');

const localConfigDir = path.join(workspaceRoot, 'tools', 'arduino-cli-config');

export const ARDUINO_CLI_PATH = process.env.ARDUINO_CLI_PATH
    || (fs.existsSync(localCliPath) ? localCliPath : 'arduino-cli');

export const ARDUINO_CLI_CONFIG_ARGS = (() => {
    const configDir = process.env.ARDUINO_CLI_CONFIG_DIR
        || (fs.existsSync(localConfigDir) ? localConfigDir : '');

    return configDir ? ['--config-dir', configDir] : [];
})();

export function arduinoCliArgs(args) {
    return [...ARDUINO_CLI_CONFIG_ARGS, ...args];
}

export function formatArduinoCliError(error, stdout, stderr) {
    return [
        stderr,
        stdout,
        error?.message,
        error?.code ? `code: ${error.code}` : '',
        error?.path ? `path: ${error.path}` : '',
    ].filter(Boolean).join('\n');
}
