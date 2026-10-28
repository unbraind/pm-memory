import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { getHistoryPath, readHistoryEntries, update, restore, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortableImportOptions, PortablePolicyManifest } from '../index.ts';
import { originCatalog } from '../src/portable-origin.ts';
import { previousOwnership } from '../src/portable-ownership.ts';
import { guardedCompensation } from '../src/portable-rollback.ts';
import { pendingImport } from '../src/portable-plan.ts';
import { policyBody, parsePolicy } from '../src/portable.ts';
import { validRelationship } from '../src/portable-relationships.ts';
import { validNativeProof, validWriteReceipt } from '../src/portable-write.ts';
import { tracker, clonedTracker, snapshot, assertClosedGraph, withoutGit } from './helpers.ts';

/** Keep one real native writer in another OS process; IPC separates lock entry from completion. */
async function peerWriter(t: TestContext, root: string) {
  const child = fork(fileURLToPath(new URL('./portable-peer.worker.ts', import.meta.url)), [], { env: { PATH: root, HOME: root, GIT_CEILING_DIRECTORIES: dirname(root), ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.connected) child.disconnect(); child.kill(); });
  let stderr = ''; child.stderr!.on('data', bytes => { stderr += String(bytes); });
  await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', (code, signal) => { reject(new Error(`Peer exited before readiness (${code ?? signal}): ${stderr}`)); }); });
  let token = 0;
  return (workspace: string, id: string, author: string, prefix: string, operation?: 'delete', options?: Record<string, unknown>) => {
    const current = ++token;
    let entered!: () => void; let entryFailed!: (error: Error) => void; let finish!: (item: unknown) => void; let fail!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { entered = resolve; entryFailed = reject; });
    const done = new Promise<unknown>((resolve, reject) => { finish = resolve; fail = reject; });
    void done.catch(() => {});
    /** A lost native worker is a test failure, never a silently pending promise. */
    const exited = (code: number | null, signal: string | null) => { const error = new Error(`Peer exited during request (${code ?? signal}): ${stderr}`); entryFailed(error); fail(error); child.off('message', receive); };
    child.once('exit', exited);
    /** Match this exact request without mixing two independent native transitions. */
    const receive = (value: { token?: number; state: string; item?: unknown; message?: string }) => {
      if (value.token !== current) return;
      if (value.state === 'started') entered();
      else { child.off('message', receive); child.off('exit', exited); if (value.state === 'done') finish(value.item); else { const error = new Error(value.message); entryFailed(error); fail(error); } }
    };
    child.on('message', receive); child.send({ workspace, id, author, prefix, token: current, operation, options }); return { started, done };
  };
}

/** A reusable native source/template pair, with independent tracker copies for each interleaving. */
async function fixture(t: TestContext, mode: 'create' | 'update' | 'rollback') {
  const source = await tracker(t); await remember('Alpha A', { ...source.options, slug: 'alpha', kind: 'reference' });
  const initial = join(source.root, 'initial'); await exportDir(initial, { ...source.options, to: 'agents-md' });
  const template = await tracker(t); await importDir(initial, { ...template.options, from: 'agents-md' });
  let path = initial;
  if (mode === 'create') { await remember('Beta A', { ...source.options, slug: 'beta', kind: 'project' }); path = join(source.root, 'creation'); await exportDir(path, { ...source.options, to: 'agents-md' }); }
  else {
    const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    await writeFile(join(path, manifest.guidance[0].path), policyBody(manifest.guidance[0], 'Alpha B'));
  }
  const id = (await template.client.listAllComplete()).items[0].id;
  const entry = (await readHistoryEntries(getHistoryPath(template.workspace, id), id)).at(-1)!;
  const prefix = /^bulk-item-transaction (\S+) /.exec(entry.message ?? '')![1].replace(/-nodes$/, '');
  return { template, path, id, prefix };
}

/** Inject one native edit at every observed boundary; the oracle is the peer's complete SDK read-back. */
for (const mode of ['create', 'update', 'rollback'] as const) test(`cross-process exact ownership at every ${mode} boundary`, { timeout: 1200000 }, async t => {
  const base = await fixture(t, mode); withoutGit(t, base.template.root);
  const peer = await peerWriter(t, base.template.root);
  const boundaries: string[] = [];
  /** Run the real adapter while optionally injecting the one competing native transition. */
  const run = async (target: Awaited<ReturnType<typeof tracker>>, boundary?: number) => {
    let index = 0; let injected = false; let inRollback = false; let pending: ReturnType<typeof peer> | undefined; const captured: { value?: unknown } = {};
    /** Plain native SDK writes can enter the item lock independently of the workspace lock. */
    const step = async (label: string, prefix = base.prefix) => {
      if (mode === 'rollback' && !inRollback) return;
      if (boundary === undefined) { boundaries.push(label); return; }
      if (index++ !== boundary) return;
      injected = true;
      try { const plan = JSON.parse(JSON.parse(await readFile(join(target.workspace, 'runtime', 'memory-policy-import.json'), 'utf8')).payload); prefix = plan.invocationId ?? plan.transactionId; } catch { /* Before intent, copy the existing committed import's prefix. */ }
      pending = peer(target.workspace, base.id, target.options.author, prefix); await pending.started;
      if (label !== 'write-guard') Object.assign(captured, { value: await pending.done });
    };
    const options: PortableImportOptions = { ...target.options, from: 'agents-md', onStep: step, onTransition: async event => {
      if (pending !== undefined && captured.value === undefined) Object.assign(captured, { value: await pending.done });
      if (event.transactionId.endsWith('-rollback')) inRollback = true;
      await step(`${event.transition}:${event.stepId ?? ''}`, event.transactionId);
      if (mode === 'rollback' && event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Refuse publication to exercise compensation');
    } };
    try { await importDir(base.path, options); } catch (error) { if (boundary === undefined && mode !== 'rollback') throw error; assert.ok(error instanceof MemoryError || error instanceof WorkspaceTransactionInterruptedError, String(error)); }
    if (pending !== undefined) Object.assign(captured, { value: await pending.done });
    if (boundary !== undefined) {
      assert.equal(injected, true, `${mode} boundary ${boundary}: ${boundaries[boundary]}`);
      assert.deepEqual((await target.client.get(base.id, { full: true })).item, captured.value, `${mode} boundary ${boundary}: peer write was lost`);
      try { await importDir(base.path, { ...target.options, from: 'agents-md' }); } catch (error) { assert.ok(error instanceof MemoryError); }
      assert.deepEqual((await target.client.get(base.id, { full: true })).item, captured.value, `${mode} boundary ${boundary}: retry lost peer state`);
      assertClosedGraph((await target.client.listAllComplete()).items);
    }
  };
  await run(await clonedTracker(t, base.template)); assert.ok(boundaries.length > 0);
  for (let boundary = 0; boundary < boundaries.length; boundary++) {
    if (process.env.PM_MEMORY_CRITICAL_PROGRESS === '1') process.stderr.write(`CROSS_PROCESS_PROGRESS mode=${mode} boundary=${boundary + 1}/${boundaries.length} label=${boundaries[boundary]}\n`);
    await run(await clonedTracker(t, base.template), boundary);
  }
  t.diagnostic(`CROSS_PROCESS mode=${mode} boundaries=${boundaries.length} same_author=true same_prefix=true`);
});

test('all relationship provenance fields refuse in the pure first pass and preserve the whole tracker', async t => {
  const { path, template } = await fixture(t, 'create');
  const manifestPath = join(path, POLICY_MANIFEST); const original = JSON.parse(await readFile(manifestPath, 'utf8')) as PortablePolicyManifest;
  const target = await tracker(t); withoutGit(t, target.root);
  const malformed: Record<string, unknown[]> = { created_at: [{ invalid: true }, [], null, false, 3, 'invalid', '', 'now'], author: [{ invalid: true }, [], null, false, 3], source_kind: [{ invalid: true }, [], null, false, 3], author_source: [{ invalid: true }, ['legacy'], null, false, 3, 'unknown'] };
  let cases = 0;
  for (const [field, values] of Object.entries(malformed)) for (const value of values) for (const baseline of [false, true]) {
    const manifest = structuredClone(original); const edge = { slug: 'beta', kind: 'related', [field]: value };
    if (baseline) Object.assign(manifest.guidance[0].baseline!, { relationships: [edge] }); else Object.assign(manifest.guidance[0], { relationships: [edge] });
    assert.throws(() => parsePolicy(manifest), error => error instanceof MemoryError);
    await writeFile(manifestPath, JSON.stringify(manifest)); const before = await snapshot(target.workspace);
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.remedy.length > 0);
    assert.deepEqual(await snapshot(target.workspace), before); cases++;
  }
  for (const provenance of [{}, { created_at: '2026-01-01' }, { created_at: '2026-01-01T00:00:00+02:00', author: '', source_kind: 'local', author_source: 'legacy' }, { created_at: '2026-01-02T12:00:00.000Z', author: 'agent', author_source: 'asserted' }, { author_source: 'detected' }]) {
    const manifest = structuredClone(original); manifest.guidance[0].relationships = [{ slug: 'beta', kind: 'related', ...provenance }] as PortablePolicyManifest['guidance'][number]['relationships']; assert.doesNotThrow(() => parsePolicy(manifest));
  }
  await writeFile(manifestPath, JSON.stringify(original)); assert.equal((await importDir(path, { ...template.options, from: 'agents-md' })).imported, 1);
  for (const value of [null, [], 3, {}, Object.create({ id: 'x', kind: 'related' }), { id: 'x', kind: 'related', created_at: {} }, { id: 'x', kind: 'related', author_source: ['legacy'] }]) assert.equal(validRelationship(value, 'id'), false);
  for (const value of [null, [], {}, { hash: null, history: 'bad', length: 0, version: null }]) { assert.equal(validNativeProof(value), false); assert.equal(validWriteReceipt(value), false); }
  t.diagnostic(`PROVENANCE_REFUSALS cases=${cases} before_schema_origin_history=true`);
});

test('same-author copied prefix never authorizes rollback after CAS refusal', async t => {
  const base = await fixture(t, 'update'); const target = base.template; withoutGit(t, target.root);
  const peer = await peerWriter(t, target.root); let captured: unknown; let injected = false;
  await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md', onTransition: async event => {
    if (!injected && event.transition === 'step_recorded' && !/-nodes$|-snapshot$|-rollback$/.test(event.transactionId)) {
      injected = true; captured = await peer(target.workspace, base.id, target.options.author, event.transactionId).done;
    }
  } }), error => error instanceof MemoryError && error.code === 'conflict');
  assert.equal(injected, true); assert.deepEqual((await target.client.get(base.id, { full: true })).item, captured);
  await importDir(base.path, { ...target.options, from: 'agents-md' });
  assert.deepEqual((await target.client.get(base.id, { full: true })).item, captured);
});

test('malformed relationship timestamp leaves an unregistered tracker byte-identical', async t => {
  const base = await fixture(t, 'create'); const target = await tracker(t); withoutGit(t, target.root);
  const file = join(base.path, POLICY_MANIFEST); const manifest = JSON.parse(await readFile(file, 'utf8')) as PortablePolicyManifest;
  Object.assign(manifest.guidance[0], { relationships: [{ slug: 'beta', kind: 'related', created_at: { invalid: true } }] });
  await writeFile(file, JSON.stringify(manifest)); const before = await snapshot(target.workspace);
  await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md' }), MemoryError);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('copied committed markers remain native edits in every provenance channel', async t => {
  const base = await fixture(t, 'update'); const target = base.template; withoutGit(t, target.root);
  const task = await target.client.create({ title: 'Native task' });
  const peer = await peerWriter(t, target.root);
  const document = { version: 1, format: 'legacy', harness: 'agents-md', path: 'alpha.md', original: Buffer.from('---\ncustom: native\n---\nNative source').toString('base64') };
  await peer(target.workspace, base.id, target.options.author, base.prefix, undefined, { memoryDocument: JSON.stringify(document), memoryPolicyBody: JSON.stringify({ ...document, format: 'policy' }), dep: [`id=${task.item.id},kind=related`] }).done;
  const memory = (await target.store.read())[0]; const owned = await previousOwnership(target.store, memory, new Map([[memory.slug, memory.id]]));
  assert.ok(owned); assert.equal(owned.fields.body, undefined); assert.equal(owned.sourceEdited, true); assert.equal(owned.bodyEdited, true);
  assert.ok(owned.nativeRelationships?.some(edge => edge.id === task.item.id));
});

test('copied compensation markers cannot recreate a natively deleted origin', async t => {
  const base = await fixture(t, 'create'); const target = base.template; withoutGit(t, target.root);
  await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md', onTransition: event => { if (event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Ordinary refusal'); } }), MemoryError);
  const catalog = await originCatalog(target.store, new Set((await target.client.listAllComplete()).items.map(row => row.id)));
  const beta = catalog.creators.find(row => row.metadata.memory_slug === 'beta')!; assert.equal(beta.compensated, true);
  const deleted = (await readHistoryEntries(getHistoryPath(target.workspace, beta.id), beta.id)).at(-1)!;
  const prefix = /^bulk-item-transaction (\S+) /.exec(deleted.message!)![1];
  const peer = await peerWriter(t, target.root); await peer(target.workspace, base.id, target.options.author, prefix, 'delete').done;
  const current = await originCatalog(target.store, new Set((await target.client.listAllComplete()).items.map(row => row.id)));
  const before = await snapshot(target.workspace);
  await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'origin_missing');
  assert.equal(current.creators.find(row => row.id === base.id)!.compensated, false);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('native write and compensation hooks never borrow ownership from another tracker with the same id', async t => {
  const base = await fixture(t, 'update'); const target = base.template; const other = await clonedTracker(t, target); withoutGit(t, target.root);
  let injected = false;
  const result = await importDir(base.path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (!injected && step === 'write-guard') { injected = true; await update(base.id, { body: 'Other project C', author: target.options.author }, { pmRoot: other.workspace }); }
  } });
  assert.equal(injected, true); assert.equal(result.updated, 1);
  assert.equal((await target.client.get(base.id, { full: true })).item.body, 'Alpha B');
  assert.equal((await other.client.get(base.id, { full: true })).item.body, 'Other project C');
  // Freeze a different real input, without granting that pending plan any native-write receipt.
  const file = join(base.path, POLICY_MANIFEST); const manifest = JSON.parse(await readFile(file, 'utf8')) as PortablePolicyManifest;
  await writeFile(join(base.path, manifest.guidance[0].path), policyBody(manifest.guidance[0], 'Alpha D'));
  await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'intent') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const plan = await pendingImport(target.store); assert.ok(plan && plan !== 'foreign');
  await guardedCompensation(target.store, plan, () => restore(base.id, '1', { author: target.options.author, force: true }, { pmRoot: other.workspace }));
  assert.equal((await other.client.get(base.id, { full: true })).item.body, 'Alpha A');
  assert.equal((await target.client.get(base.id, { full: true })).item.body, 'Alpha B');
});

test('recovery of committed data retains publication ownership for later edits and older replays', async t => {
  for (const boundary of ['readback', 'data-committed']) {
    const base = await fixture(t, 'update'); const target = base.template;
    await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md', onStep: step => {
      if (boundary === 'readback' && step === 'readback') throw new WorkspaceTransactionInterruptedError();
    }, onTransition: event => {
      if (boundary === 'data-committed' && event.transition === 'committed' && !/-nodes$|-snapshot$|-rollback$/.test(event.transactionId)) throw new WorkspaceTransactionInterruptedError();
    } }), WorkspaceTransactionInterruptedError);
    assert.equal((await importDir(base.path, { ...target.options, from: 'agents-md' })).updated, 1);
    const manifest = JSON.parse(await readFile(join(base.path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    const row = manifest.guidance[0];
    for (const body of ['Alpha C', 'Alpha A']) {
      await writeFile(join(base.path, row.path), policyBody(row, body));
      const result = await importDir(base.path, { ...target.options, from: 'agents-md' });
      assert.equal(result.updated, 1, `${boundary}: a package recovery is not a native edit`);
      assert.equal((await target.client.get(base.id, { full: true })).item.body, body);
      assert.equal((await importDir(base.path, { ...target.options, from: 'agents-md' })).unchanged, 1);
    }
  }
});

test('native item-lock guard interruptions remain crash-recoverable', async t => {
  for (const mode of ['create', 'update', 'rollback'] as const) {
    const base = await fixture(t, mode); const target = base.template; let rollingBack = false;
    await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md', onStep: step => {
      if (step === 'write-guard' && (mode !== 'rollback' || rollingBack)) throw new WorkspaceTransactionInterruptedError();
    }, onTransition: event => {
      if (event.transactionId.endsWith('-rollback')) rollingBack = true;
      if (mode === 'rollback' && event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Exercise native rollback interruption');
    } }), WorkspaceTransactionInterruptedError);
    assert.equal((await target.client.get(base.id, { full: true })).item.body, mode === 'rollback' ? 'Alpha B' : 'Alpha A');
    const result = await importDir(base.path, { ...target.options, from: 'agents-md' });
    assert.equal(result.imported, mode === 'create' ? 1 : 0); assert.equal(result.updated, mode === 'create' ? 0 : 1);
    assert.equal((await target.client.get(base.id, { full: true })).item.body, mode === 'create' ? 'Alpha A' : 'Alpha B');
    assert.equal((await importDir(base.path, { ...target.options, from: 'agents-md' })).unchanged, mode === 'create' ? 2 : 1);
    assertClosedGraph((await target.client.listAllComplete()).items);
  }
});
