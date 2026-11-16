/** Select npm's JavaScript entry on Windows so consumer paths remain discrete argv. */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Avoid batch-file shell parsing while preserving native executables. */
export function packageManagerInvocation(executable: string, platform: NodeJS.Platform = process.platform, npmEntry = process.env.npm_execpath) {
  if (platform !== 'win32' || executable !== 'npm') return { command: executable, prefix: [] as string[] };
  const entry = [npmEntry, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
    .find(candidate => candidate?.endsWith('npm-cli.js') && existsSync(candidate));
  if (!entry) throw new Error('Windows packed acceptance requires the installed npm JavaScript entrypoint');
  return { command: process.execPath, prefix: [entry] };
}
