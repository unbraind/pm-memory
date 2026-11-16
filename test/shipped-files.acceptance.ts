import { packageManagerInvocation } from './support/package-manager.ts';
/** Verify actual packed documentation in the release acceptance tier. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { test } from 'node:test';
import { testTime } from './support/time.ts';

const runtimePath = process.env.PATH;

test('published documentation includes credential policy and preserves the existing public files', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { files: string[]; pm: { docs: string[] } };
  assert.ok(manifest.pm.docs.includes('docs/sdk-adoption.md'));
  const safe = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|PASSWORD|SECRET|KEY|AUTH|CREDENTIAL|PAT(?:_|$)/i.test(key) && key !== 'NPM_MEDIA_SERVER'));
  const { command, prefix } = packageManagerInvocation('npm');
  const result = spawnSync(command, [...prefix, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', timeout: testTime(60000), env: { ...safe, PATH: runtimePath, NPM_CONFIG_USERCONFIG: devNull } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout) as { files: { path: string; size: number }[] }[];
  for (const path of ['docs/sdk-adoption.md', 'README.md', 'ARCHITECTURE.md', 'manifest.json', 'dist/index.js']) {
    const file = packed[0].files.find(file => file.path === path); assert.ok(file, path);
    assert.equal(file.size, (await readFile(path)).length);
  }
  assert.ok(packed[0].files.every(file => !file.path.startsWith('.agents/') && !file.path.startsWith('test/')));
});
