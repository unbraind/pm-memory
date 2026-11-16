/** Cover platform launch selection used by packed npm acceptance. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { packageManagerInvocation } from './support/package-manager.ts';

test('Windows npm uses a real JavaScript launcher and preserves shell-sensitive argv', () => {
  const launch = packageManagerInvocation('npm', 'win32');
  assert.equal(launch.command, process.execPath);
  assert.match(launch.prefix[0], /npm-cli\.js$/);
  const prefix = 'fixture path & literal %not_an_environment_variable%';
  const result = spawnSync(launch.command, [...launch.prefix, 'config', 'get', 'prefix', '--prefix', prefix], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().endsWith(prefix));
});

test('native package managers keep the executable and unmodified argument vector', () => {
  for (const [executable, platform] of [['npm', 'linux'], ['bun', 'win32'], [process.execPath, 'win32']] as const) {
    assert.deepEqual(packageManagerInvocation(executable, platform), { command: executable, prefix: [] });
  }
});
