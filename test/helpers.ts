import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, rm, readdir, readlink, readFile, mkdir, writeFile, cp, open, rmdir } from 'node:fs/promises';
import { tmpdir, availableParallelism } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { PmClient, WorkspaceTransactionInterruptedError, type Dependency, type WorkspaceTransactionTransitionContext } from '@unbrained/pm-cli/sdk';
import { Store } from '../src/store.ts';
import { testEnvironment } from '../scripts/environment.ts';
import { exportDir, POLICY_MANIFEST, type PortablePolicyManifest, importDir, MemoryError } from '../index.ts';
import type { ImportPlan } from '../src/portable-plan.ts';
import { digest } from '../src/core.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { assertSeedCoverage, type SeedExecution } from './property-seeds.ts';

/** A slot whose recorded owner process no longer exists was left by a hard-killed run and may be reclaimed. */
export async function ownerIsGone(file: string): Promise<boolean> {
  const owner = Number(await readFile(file, 'utf8').catch(() => ''));
  // An empty or unreadable file may belong to an owner still writing its PID.
  if (!Number.isInteger(owner) || owner <= 0) return false;
  try { process.kill(owner, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** Share the available cores across sibling test files without doubling their worker pools. */
async function workerSlot(t: TestContext): Promise<() => Promise<void>> {
  const directory = join(tmpdir(), `memory-worker-slots-${process.ppid}`);
  for (;;) {
    t.signal.throwIfAborted();
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < Math.min(4, availableParallelism()); index++) {
      const file = join(directory, String(index));
      try {
        const handle = await open(file, 'wx'); await handle.writeFile(String(process.pid)); await handle.close(); let released = false;
        const release = async () => {
          if (released) return; released = true;
          await rm(file, { force: true });
          try { await rmdir(directory); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!)) throw error; }
        };
        return release;
      } catch (error) {
        if (!['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!)) throw error;
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && await ownerIsGone(file)) { await rm(file, { force: true }); index--; }
      }
    }
    await delay(25, undefined, { signal: t.signal });
  }
}

/** Bound child model lifetimes, retain coverage and require their complete assertion receipt. */
export async function runModelWorker(t: TestContext, worker: URL, variables: Record<string, string>, receipt: string, suite?: string): Promise<SeedExecution[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'memory-worker-'));
  let release: (() => Promise<void>) | undefined;
  let cleanup = async () => { await release?.(); await rm(scratch, { recursive: true, force: true }); };
  try {
    release = await workerSlot(t);
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', fileURLToPath(worker)], { env: { ...testEnvironment(process.env), ...variables, TMPDIR: scratch, TMP: scratch, TEMP: scratch }, stdio: ['ignore', 'pipe', 'pipe'], signal: t.signal });
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    const ended = new Promise<number | null>(resolve => { child.once('close', resolve); });
    const closed = Promise.race([ended, new Promise<never>((_resolve, reject) => { child.once('error', reject); })]);
    cleanup = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await ended;
      await release?.();
      await rm(scratch, { recursive: true, force: true });
    };
    t.after(cleanup);
    const code = await closed;
    assert.equal(code, 0, output); assert.ok(output.includes(receipt), `Missing complete SDK-verified worker receipt: ${output}`);
    if (suite === undefined) return [];
    const matches = [...output.matchAll(/SEED_RECEIPT=(\{[^\n]+\})/g)];
    assert.equal(matches.length, 1, `Missing unique completed-seed receipt: ${output}`);
    const { suite: reported, executed } = JSON.parse(matches[0][1]) as { suite: string; executed: SeedExecution[] };
    const stem = variables.PM_MEMORY_LAW === undefined ? Object.keys(variables).find(key => key.endsWith('_START'))!.replace('PM_MEMORY_', '').replace('_START', '') : 'LAW';
    assert.equal(reported, suite);
    assertSeedCoverage(suite, executed, Number(variables[`PM_MEMORY_${stem}_START`]), Number(variables[`PM_MEMORY_${stem}_COUNT`]));
    return executed;
  } finally { await cleanup(); }
}

/** Bound fan-out by real cores; the shared slot budget also bounds sibling test files. */
export function modelWorkerPool(maximum = 2): number {
  const width = Number(process.env.PM_MEMORY_WORKER_POOL ?? maximum);
  if (![1, 2, 4].includes(width)) throw new Error('PM_MEMORY_WORKER_POOL must be 1, 2 or 4');
  return Math.min(width, availableParallelism());
}
/** Exercise independent fixture copies concurrently, awaiting every active case before cleanup or failure. */
export async function concurrentCases<T>(values: readonly T[], run: (value: T, index: number) => Promise<void>): Promise<void> {
  let next = 0; const errors: unknown[] = [];
  const lane = async () => {
    for (let index = next++; index < values.length && errors.length === 0; index = next++) {
      try { await run(values[index], index); } catch (error) { errors.push(error); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(modelWorkerPool(), values.length) }, lane));
  if (errors.length > 0) throw new AggregateError(errors, 'Independent fixture case failed');
}

/** Run independent model-worker batches concurrently through one bounded pool; every batch still reports its own receipt. */
export async function runModelWorkerPool(t: TestContext, worker: URL, configurations: readonly Record<string, string>[], receipts: readonly string[], suite?: string): Promise<void> {
  if (configurations.length !== receipts.length) throw new Error('Every pooled worker batch requires exactly one receipt');
  const shared: Record<string, string> = {};
  if (suite !== undefined) {
    const plain = await tracker(t); const registered = await clonedTracker(t, plain);
    await registered.store.register();
    // Schema is reusable configuration. A namespace belongs to one logical tracker,
    // so each copy allocates its own instead of inheriting the template's identity.
    await rm(join(registered.workspace, 'memory-origin.json'));
    Object.assign(shared, { PM_MEMORY_TRACKER_TEMPLATE: registered.workspace, PM_MEMORY_EMPTY_TEMPLATE: registered.workspace });
  }
  let next = 0; const failures: Error[] = []; const executed: SeedExecution[] = [];
  /** One pool lane claims batches by index until the list is exhausted or any lane has recorded a failure, as concurrentCases does. */
  const lane = async () => { for (let index = next++; index < configurations.length && failures.length === 0; index = next++) { try { executed.push(...await runModelWorker(t, worker, { ...shared, ...configurations[index] }, receipts[index], suite)); } catch (error) { failures.push(error as Error); return; } } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(modelWorkerPool(4), configurations.length)) }, lane));
  if (failures.length > 0) throw new Error(`${failures.length} pooled worker batch(es) failed; first failure follows`, { cause: failures[0] });
  if (suite !== undefined) {
    assertSeedCoverage(suite, executed);
    t.diagnostic(`PROPERTY_SEEDS=${JSON.stringify({ suite, executed: executed.sort((a, b) => a.sequence - b.sequence) })}`);
  }
}

/** Execute the complete fixed-size property budget without duplicating worker scheduling in each law. */
export async function modelBatches(t: TestContext, worker: URL, stem: string, batch: number, receipt: (start: number, count: number) => string): Promise<void> {
  const starts = Array.from({ length: 500 / batch }, (_, index) => index * batch);
  await runModelWorkerPool(t, worker, starts.map(start => ({ [`PM_MEMORY_${stem}_START`]: String(start), [`PM_MEMORY_${stem}_COUNT`]: String(batch) })), starts.map(start => receipt(start, batch)), stem);
  assert.equal(starts.length * batch, 500);
}

/** Initialize a real tracker and register cleanup before any mutations. */
export async function tracker(t: TestContext) {
  const result = await trackerFixture(t);
  await result.client.init('memory-test', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  return result;
}
/** Clone prepared schema for property workers without inheriting a logical tracker namespace. */
export async function propertyTracker(t: TestContext) {
  const source = process.env.PM_MEMORY_TRACKER_TEMPLATE;
  assert.ok(source, 'Property worker requires its parent-owned tracker template');
  const result = await trackerFixture(t);
  await cp(source, result.workspace, { recursive: true });
  return result;
}
/** Allocate one independently owned temporary SDK fixture before initialization or cloning. */
async function trackerFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'memory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, '.agents', 'pm');
  const client = new PmClient({ cwd: root, pmRoot: workspace, author: 'memory-test', noExtensions: true });
  const options = { workspace, author: 'memory-test' }; const store = new Store(options);
  return { root, workspace, client, options, store };
}
/** Reuse initialized schema through a native copy while preserving independent tracker state. */
export async function clonedTracker(t: TestContext, source: Pick<Awaited<ReturnType<typeof tracker>>, 'workspace' | 'options'>) {
  const result = await trackerFixture(t); await cloneTracker(source, result.workspace); return result;
}
/** Keep native SDK tests outside ancestor Git discovery and restore only the variables we changed. */
export function withoutGit(t: TestContext, root: string): void {
  for (const [key, value] of Object.entries({ PATH: root, GIT_CEILING_DIRECTORIES: dirname(root) })) {
    const prior = process.env[key]; process.env[key] = value;
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  }
}
/** Export one real policy directory and decode only its public wire inventory. */
export async function exportedPolicy(source: Pick<Awaited<ReturnType<typeof tracker>>, 'root' | 'options'>, name = 'export', to: 'agents-md' | 'claude-code' = 'agents-md') {
  const path = join(source.root, name); await exportDir(path, { ...source.options, to });
  const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  return { path, manifest };
}
/** Seed one raw intake with SDK creation provenance for reference-selection tests. */
export async function importText(target: Pick<Awaited<ReturnType<typeof tracker>>, 'root' | 'options'>, name: string, body: string, from: Parameters<typeof importDir>[1]['from'] = 'agents-md') {
  const file = join(target.root, name); await writeFile(file, body);
  await importDir(file, { ...target.options, from }); return file;
}
/** Seed a complete legacy harness inventory with an unchanged index where required. */
export async function importHarness(target: Pick<Awaited<ReturnType<typeof tracker>>, 'root' | 'options'>, from: 'agents-md' | 'claude-code', body: string) {
  const directory = join(target.root, 'source'); await mkdir(directory);
  const name = from === 'agents-md' ? 'AGENTS.md' : 'alpha.md'; await writeFile(join(directory, name), body);
  if (from === 'claude-code') await writeFile(join(directory, 'MEMORY.md'), '- [Alpha](alpha.md)\n');
  await importDir(directory, { ...target.options, from }); return { directory, name };
}
/** Clone native documents and configuration for an independent SDK reference update. */
export async function cloneTracker(target: Pick<Awaited<ReturnType<typeof tracker>>, 'workspace' | 'options'>, destination: string): Promise<PmClient> {
  await cp(target.workspace, destination, { recursive: true, filter: path => !['runtime', 'locks', 'transactions', 'checkpoints', 'search'].includes(relative(target.workspace, path).split('/')[0]) });
  return new PmClient({ pmRoot: destination, author: target.options.author, noExtensions: true });
}
/** Require a complete export/import round trip to preserve every SDK-returned native field. */
export async function assertExportIdentity(target: Awaited<ReturnType<typeof tracker>>, directory: string, to: Parameters<typeof exportDir>[1]['to']): Promise<void> {
  const expected = (await target.client.listAllComplete({ includeBody: true })).items;
  await exportDir(directory, { ...target.options, to });
  assert.equal((await importDir(directory, { ...target.options, from: to })).updated, 0);
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, expected);
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
      if (entry.isDirectory()) await walk(path); else result[relative(root, path)] = entry.isSymbolicLink() ? 'link:' + await readlink(path) : (await readFile(path)).toString('base64');
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
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pm-memory', version: '2026.10.19', entry: 'entry.js', capabilities: ['commands', 'schema', 'hooks'] }));
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

/** Seed an imported raw source with old native verification for peer-completion controls. */
export async function verifiedSource(t: TestContext, text: string, reason: string) {
  const target = await tracker(t); withoutGit(t, target.root); const path = join(target.root, 'alpha.md');
  await writeFile(path, text); await importDir(path, { ...target.options, from: 'agents-md' });
  const id = (await target.client.listAllComplete()).items[0].id; const old = '2020-01-01T00:00:00.000Z';
  await target.store.fields(id, { changed_at: old, verdict: 'verified', verified_at: old, reason });
  return { ...target, path, id, old };
}

/** Read this package's actual durable intent after admission, without synthesizing SDK requests. */
export async function readImportPlan(workspace: string): Promise<ImportPlan> {
  const { payload } = JSON.parse(await readFile(join(workspace, 'runtime', 'memory-policy-import.json'), 'utf8')) as { payload: string };
  return JSON.parse(payload) as ImportPlan;
}
