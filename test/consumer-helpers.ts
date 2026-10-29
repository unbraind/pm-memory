import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { gitEnvironment, npmEnvironment } from '../scripts/environment.ts';

/** Execute a real consumer command against only its isolated package/settings directory. */
export function execute(cwd: string, args: string[], executable: string, env: NodeJS.ProcessEnv, expected = 0): string {
  const child = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(child.error, undefined); assert.equal(child.status, expected, child.stderr + child.stdout);
  return expected === 0 ? child.stdout : child.stderr + child.stdout;
}
/** Capture one real built archive and retain the existing strict shipped-file assertions. */
export function consumerFixture(t: TestContext) {
  const repository = resolve(import.meta.dirname, '..'); const scratch = mkdtempSync(join(tmpdir(), 'memory-consumer-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string; devDependencies: Record<string, string> };
  const publicEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION|CREDENTIAL)(?:_|$)/i.test(key) && key !== 'NPM_MEDIA_SERVER'));
  const env = { ...npmEnvironment(gitEnvironment(publicEnv)), HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: scratch, PM_AUTHOR: 'memory-consumer' };
  const packed = JSON.parse(execute(repository, ['pack', '--json', '--pack-destination', scratch, '--ignore-scripts'], 'npm', env)) as { filename: string; integrity: string; files: { path: string }[] }[];
  const allowed = /^(dist\/|manifest\.json$|package\.json$|README\.md$|ARCHITECTURE\.md$|LICENSE$|CHANGELOG\.md$)/;
  assert.ok(packed[0].files.every(file => allowed.test(file.path)), 'Packed file allowlist'); assert.ok(packed[0].files.some(file => file.path === 'dist/index.js'));
  assert.ok(packed[0].files.filter(file => file.path.startsWith('dist/')).every(file => existsSync(join(repository, file.path.replace(/^dist\//, '').replace(/\.(?:js|d\.ts)(?:\.map)?$/, '.ts')))), 'Every packed module requires current TypeScript source; remove obsolete generated outputs and rebuild');
  return { repository, scratch, manifest, env, packed };
}
/** Install the same captured bytes through either package manager, preserving the pinned SDK. */
export function installConsumer(fixture: ReturnType<typeof consumerFixture>, manager: string) {
  const { scratch, manifest, env, packed } = fixture;
  const consumer = join(scratch, manager); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'memory-consumer-fixture', private: true, type: 'module', dependencies: { 'pm-memory': `file:${join(scratch, packed[0].filename)}`, '@unbrained/pm-cli': manifest.devDependencies['@unbrained/pm-cli'] } }));
  execute(consumer, manager === 'npm' ? ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts'], manager, env);
  return consumer;
}
