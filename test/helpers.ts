import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { PmClient, WorkspaceTransactionInterruptedError, type Dependency, type WorkspaceTransactionTransitionContext } from '@unbrained/pm-cli/sdk';
import { Store } from '../src/store.ts';
import { testEnvironment } from '../scripts/environment.ts';
import { exportDir, POLICY_MANIFEST, type PortablePolicyManifest, importDir, MemoryError } from '../index.ts';
import type { ImportPlan } from '../src/portable-plan.ts';
import { digest } from '../src/core.ts';

/** Bound child model lifetimes, retain coverage and require their complete assertion receipt. */
export async function runModelWorker(t: TestContext, worker: URL, variables: Record<string, string>, receipt: string): Promise<void> {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(worker)], { env: { ...testEnvironment(process.env), ...variables }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output); assert.ok(output.includes(receipt), `Missing complete SDK-verified worker receipt: ${output}`);
}

/** Initialize a real tracker and register cleanup before any mutations. */
export async function tracker(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'memory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, '.agents', 'pm');
  const client = new PmClient({ cwd: root, pmRoot: workspace, author: 'memory-test', noExtensions: true });
  await client.init('memory-test', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const options = { workspace, author: 'memory-test' }; const store = new Store(options);
  return { root, workspace, client, options, store };
}
/** Export one real policy directory and decode only its public wire inventory. */
export async function exportedPolicy(source: Pick<Awaited<ReturnType<typeof tracker>>, 'root' | 'options'>, name = 'export') {
  const path = join(source.root, name); await exportDir(path, { ...source.options, to: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  return { path, manifest };
}
/** Seed one raw intake with SDK creation provenance for reference-selection tests. */
export async function importText(target: Pick<Awaited<ReturnType<typeof tracker>>, 'root' | 'options'>, name: string, body: string, from: Parameters<typeof importDir>[1]['from'] = 'agents-md') {
  const file = join(target.root, name); await writeFile(file, body);
  await importDir(file, { ...target.options, from }); return file;
}
/** Seed immutable imported origins while retaining other rows for a later mixed creation batch. */
export async function importSubset(directory: string, target: Pick<Awaited<ReturnType<typeof tracker>>, 'root' | 'options'>, slugs: readonly string[]) {
  const subset = await mkdtemp(join(target.root, 'origin-subset-')); await cp(directory, subset, { recursive: true });
  const manifest = JSON.parse(await readFile(join(subset, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  manifest.guidance = manifest.guidance.filter(row => slugs.includes(row.slug));
  await writeFile(join(subset, POLICY_MANIFEST), JSON.stringify(manifest));
  return importDir(subset, { ...target.options, from: manifest.harness });
}
/** Alter only a fixture-owned checksummed recovery record, retaining its real SDK plan. */
export async function editIntent(file: string, change: (plan: ImportPlan) => ImportPlan): Promise<ImportPlan> {
  const envelope = JSON.parse(await readFile(file, 'utf8')) as { payload: string; checksum: string };
  const plan = change(JSON.parse(envelope.payload) as ImportPlan);
  envelope.payload = JSON.stringify(plan); envelope.checksum = digest(envelope.payload);
  await writeFile(file, JSON.stringify(envelope)); return plan;
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
/** Missing immutable origins refuse without any durable tracker mutation. */
export async function assertOriginRefused(run: () => ReturnType<typeof importDir>, workspace: string) {
  const before = await snapshot(workspace);
  await assert.rejects(run, error => error instanceof MemoryError && error.code === 'origin_missing');
  assert.deepEqual(await snapshot(workspace), before);
}
/** A deleted known lineage requires an explicit, independently observable create action. */
export async function explicitRecreation(directory: string, options: Parameters<typeof importDir>[1]) {
  await assert.rejects(importDir(directory, options), error => error instanceof MemoryError && error.code === 'origin_missing');
  return importDir(directory, { ...options, createMissingOrigins: true });
}
/** Serialized memory documents are distinct from their append-only SDK audit streams. */
export async function memoryDocuments(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(await snapshot(root)).filter(([path]) => path.startsWith('knowledge/')));
}
/** A native conflict receipt must retain every durable byte of the tracker. */
export async function assertSkippedUnchanged(run: () => ReturnType<typeof importDir>, workspace: string, count = 1): Promise<void> {
  const before = await snapshot(workspace); const result = await run();
  assert.ok('skipped' in result); assert.equal(result.skipped.length, count);
  assert.deepEqual(await snapshot(workspace), before);
}
/** Fail a real SDK write, then simulate process death after durable compensation. */
export function crashAfterCompensation(event: WorkspaceTransactionTransitionContext): void {
  if (event.transition === 'step_recorded') throw new Error('Begin SDK compensation');
  if (event.transition === 'compensated') throw new WorkspaceTransactionInterruptedError();
}
/** Stop at a named package boundary without running normal failure compensation. */
export function crashAtStep(boundary: string): (step: string) => void {
  return step => { if (step === boundary) throw new WorkspaceTransactionInterruptedError(); };
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

/** Require every local relationship in a closed SDK corpus to resolve. */
export function assertClosedGraph(items: readonly { id: string; dependencies?: Dependency[] }[]): void {
  assert.ok(items.every(item => (item.dependencies ?? []).every(edge => items.some(target => target.id === edge.id))), 'SDK state contains a dangling edge');
}
