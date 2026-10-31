import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { TestContext } from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { Store } from '../src/store.ts';

/** Initialize a real tracker and register cleanup before any mutations. */
export async function tracker(t: TestContext) {
  const result = await trackerFixture(t);
  await result.client.init('memory-test', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  return result;
}
/** Allocate a fixture without initializing caches before an independent clone. */
async function trackerFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'memory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, '.agents', 'pm');
  const client = new PmClient({ cwd: root, pmRoot: workspace, author: 'memory-test', noExtensions: true });
  const options = { workspace, author: 'memory-test' }; const store = new Store(options);
  return { root, workspace, client, options, store };
}
/** Copy genuine SDK records into an independently owned plain-directory tracker. */
export async function clonedTracker(t: TestContext, source: Awaited<ReturnType<typeof tracker>>) {
  const target = await trackerFixture(t);
  await cp(source.workspace, target.workspace, { recursive: true, filter: path => !['runtime', 'locks', 'transactions', 'checkpoints', 'search'].includes(relative(source.workspace, path).split('/')[0]) });
  return target;
}
/** Snapshot durable tracker bytes while excluding disposable caches and locks. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  /** Collect durable files recursively from the bounded test tracker. */
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['runtime', 'locks', 'search', 'transactions', 'checkpoints'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path); else result[relative(root, path)] = (await readFile(path)).toString('base64');
    }
  }
  await walk(root); return result;
}

/** Require a successful child test run, a positive pass count and the expected test name. */
export function assertTestsPassed(result: SpawnSyncReturns<string>, expectedName: string): void {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\bpass [1-9]\d*\b/, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(expectedName), result.stdout + result.stderr);
}

/** Install the source extension in a genuine temporary CLI host. */
export async function installExtension(workspace: string): Promise<void> {
  const dir = join(workspace, 'extensions', 'pm-memory'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pm-memory', version: '2026.10.19', entry: 'entry.js', capabilities: ['commands', 'schema'] }));
  await writeFile(join(dir, 'entry.js'), `export { default } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};\n`);
}

/** Build a runner for the installed pm host with git absent from PATH and ancestor discovery fenced. */
export function gitlessCli(root: string, workspace: string): (args: string[]) => SpawnSyncReturns<string> {
  return args => spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'memory', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PM_PATH: workspace, PM_AUTHOR: 'memory-test', GIT_CEILING_DIRECTORIES: dirname(root), PATH: root } });
}
