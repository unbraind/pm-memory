import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTransactionInterruptedError, commitItemMutations } from '@unbrained/pm-cli/sdk';
import { remember, renew, exportDir, importDir, MemoryError, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { digest } from '../src/core.ts';
import { policyBody } from '../src/portable.ts';
import { pendingImport, type ImportPlan } from '../src/portable-plan.ts';
import { tracker, snapshot, crashAtStep, assertSkippedUnchanged } from './helpers.ts';

/** Build one actual pending-data scenario without mocks or repository discovery. */
async function pendingScenario(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t); const target = await tracker(t);
  await remember('Public review policy', { ...source.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...source.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Reviewed' });
  const path = join(source.root, 'export'); await exportDir(path, { ...source.options, to: 'agents-md' });
  const row = (JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest).guidance[0];
  return { source, target, path, row, intent: join(target.workspace, 'runtime', 'memory-policy-import.json') };
}
/** Pause a real plan at intent before exercising its persisted recovery contract. */
async function interruptedScenario(t: Parameters<typeof tracker>[0]) {
  const scenario = await pendingScenario(t);
  await assert.rejects(importDir(scenario.path, { ...scenario.target.options, from: 'agents-md', onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
  return scenario;
}
/** Match a typed refusal while checking that it supplies a remedy. */
const refused = (error: unknown) => error instanceof MemoryError && error.remedy.length > 0;

test('foreign intents are skipped and checksummed package corruption refuses without writes', async t => {
  const { target, path, intent } = await pendingScenario(t); await mkdir(join(target.workspace, 'runtime'), { recursive: true });
  for (const value of ['{', '3', 'null', '[]', '{}', '{"owner":"another-package"}']) {
    await writeFile(intent, value); const before = await snapshot(target.workspace);
    const result = await importDir(path, { ...target.options, from: 'agents-md' });
    assert.ok('skipped' in result); assert.match(result.skipped[0].reason, /Foreign pending/);
    assert.equal(await readFile(intent, 'utf8'), value); assert.deepEqual(await snapshot(target.workspace), before);
  }
  for (const value of [{ owner: 'pm-memory-policy-plan:1' }, { owner: 'pm-memory-policy-plan:1', payload: 1 }, { owner: 'pm-memory-policy-plan:1', payload: '{}' }, { owner: 'pm-memory-policy-plan:1', payload: '{}', checksum: 'wrong' }]) {
    await writeFile(intent, JSON.stringify(value)); await assert.rejects(pendingImport(target.store), refused);
  }
  const base = { input: 'input', transactionId: `memory-policy-${'a'.repeat(40)}`, author: 'test', members: [], expected: [], mutations: [], result: {} };
  for (const value of ['{', 'null', '{}', JSON.stringify({ ...base, transactionId: '../foreign' }), JSON.stringify({ ...base, input: null }), JSON.stringify({ ...base, author: null }), JSON.stringify({ ...base, members: null }), JSON.stringify({ ...base, members: [3] }), JSON.stringify({ ...base, mutations: null }), JSON.stringify({ ...base, mutations: [{ op: 'close' }] }), JSON.stringify({ ...base, mutations: [{ op: 'update', id: 3 }] }), JSON.stringify({ ...base, mutations: [{ op: 'update', id: 'x', options: null }] }), JSON.stringify({ ...base, mutations: [{ op: 'create', id: 'x', options: 3 }] })]) {
    await writeFile(intent, JSON.stringify({ owner: 'pm-memory-policy-plan:1', payload: value, checksum: digest(value) }));
    await assert.rejects(pendingImport(target.store), refused);
  }
});

test('a native edit after interruption cannot be stamped as imported provenance', async t => {
  const { target, path } = await pendingScenario(t);
  let id = '';
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'readback') {
      id = (await target.client.listAllComplete()).items[0].id;
      await target.client.update(id, { body: 'Native peer edit' });
      throw new WorkspaceTransactionInterruptedError();
    }
  } }), WorkspaceTransactionInterruptedError);
  const retry = await importDir(path, { ...target.options, from: 'agents-md' }); assert.ok('skipped' in retry);
  assert.equal((await target.client.get(id, { full: true })).item.body, 'Native peer edit');
});

test('relationship inventory rejects malformed local edges and reports external targets', async t => {
  const { source, target, path } = await pendingScenario(t);
  const original = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  for (const relationships of [null, [null], [{ slug: 'policy', kind: 'unknown' }], [{ slug: 'policy', kind: 'related', unknown: true }], [{ slug: 'absent', kind: 'related' }]]) {
    const manifest = structuredClone(original); manifest.guidance[0].relationships = relationships as PortablePolicyManifest['guidance'][number]['relationships'];
    await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
    const before = await snapshot(target.workspace); await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), refused);
    assert.deepEqual(await snapshot(target.workspace), before);
  }
  const foreign = await source.client.create({ title: 'Native task' });
  const memory = (await source.client.listAllComplete()).items.find(item => item.memory_slug === 'policy')!;
  await source.store.link(memory.id, String(foreign.item.id));
  const exported = await exportDir(join(source.root, 'external'), { ...source.options, to: 'agents-md' });
  assert.ok(exported.omitted_links?.some(row => row.target === foreign.item.id && row.reason === 'missing'));
});

test('SDK captured-revision refusals remain typed and never publish stale data', async t => {
  const { source, target, path } = await pendingScenario(t);
  const native = (await source.client.listAllComplete({ includeBody: true })).items[0];
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onTransition: async event => {
    if (event.transition === 'prepared') await commitItemMutations({ pmRoot: source.workspace, author: 'memory-test', transactionId: 'public-cas-refusal', mutations: [{ op: 'update', id: native.id, match: { key: 'updated_at', value: 'stale-revision' }, options: { body: 'Must not publish' } }] });
  } }), error => error instanceof MemoryError && ['conflict', 'transaction'].includes(error.code) && error.remedy.length > 0);
  assert.equal((await source.client.get(native.id, { full: true })).item.body, native.body);
  assert.equal((await target.client.listAllComplete()).items.length, 0);
});

test('failed publication keeps successful forward writes and retains later native edits on retry', async t => {
  for (const peer of [false, true]) {
    const { target, path, row } = await pendingScenario(t);
    await importDir(path, { ...target.options, from: 'agents-md' });

    await writeFile(join(path, row.path), policyBody(row, 'Retry B'));
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onTransition: event => {
      if (event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Provenance publication failure');
    } }), error => error instanceof MemoryError && error.code === 'transaction');
    const native = (await target.client.listAllComplete({ includeBody: true })).items[0];
    assert.equal(native.body, 'Retry B');
    if (peer) {
      await target.client.update(native.id, { body: 'Peer C' });
      const before = (await target.client.listAllComplete({ includeBody: true })).items; const retry = await importDir(path, { ...target.options, from: 'agents-md' }); assert.ok('skipped' in retry); assert.equal(retry.skipped.length, 1); assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
    } else {
      await importDir(path, { ...target.options, from: 'agents-md' });
      assert.equal((await target.client.get(native.id, { full: true })).item.body, 'Retry B');
      assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 1);
    }
  }
});

test('foreign intent replacements at publication boundaries are retained and can be cleared by their owner', async t => {
  for (const boundary of ['previewed', 'intent', 'nodes', 'readback', 'published', 'retire-audit']) {
    const { target, path, row, intent } = await pendingScenario(t);
    await writeFile(join(path, row.path), policyBody(row, 'Harness B'));
    const foreign = JSON.stringify({ owner: 'foreign:tool', untouched: true }); let injected = false;
    if (boundary === 'retire-audit') await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'published') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    const result = await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
      if (step === boundary) { await writeFile(intent, foreign); injected = true; }
    } });
    assert.equal(injected, true); assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.reason.includes('Foreign pending')));
    assert.equal(await readFile(intent, 'utf8'), foreign);
    if (boundary === 'readback' || boundary === 'published') assert.equal(result.imported, 1);
    // The simulated foreign owner removes its own file. The importer never does.
    await rm(intent);
    const retried = await importDir(path, { ...target.options, from: 'agents-md' }); assert.ok('skipped' in retried); assert.deepEqual(retried.skipped, []);
    assert.equal((await target.client.listAllComplete({ includeBody: true })).items[0].body, 'Harness B');
    assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 1);
  }
});

test('late malformed or changed intent tokens are foreign and never overwritten', async t => {
  const { target, path, intent } = await interruptedScenario(t);
  const owned = JSON.parse(await readFile(intent, 'utf8')) as { owner: string; payload: string; checksum: string };
  await rm(intent);
  const values = ['{', '3', 'null', '{}',
    JSON.stringify({ owner: owned.owner, payload: 3, checksum: '' }),
    JSON.stringify({ ...owned, checksum: 'wrong' }), JSON.stringify({ ...owned, foreign: true }),
    JSON.stringify({ ...owned, owner: 'another-package' }), JSON.stringify(owned),
  ];
  for (const value of values) {
    const result = await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => { if (step === 'previewed') await writeFile(intent, value); } });
    assert.ok('skipped' in result); assert.match(result.skipped[0].reason, /Foreign pending/);
    assert.equal(await readFile(intent, 'utf8'), value); await rm(intent);
    assert.equal((await target.client.listAllComplete()).items.length, 0);
  }
  const changed = await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'published') {
      const current = JSON.parse(await readFile(intent, 'utf8')) as typeof owned;
      current.payload = JSON.stringify({ ...JSON.parse(current.payload), foreignAmendment: true }); current.checksum = digest(current.payload);
      await writeFile(intent, JSON.stringify(current));
    }
  } });
  assert.ok('skipped' in changed); assert.ok(changed.skipped.some(row => row.slug === 'pending-import'));
  assert.ok((await readFile(intent, 'utf8')).includes('foreignAmendment'));
});

test('an already-drained completed intent reports success without a false foreign receipt', async t => {
  const { target, path, intent } = await pendingScenario(t);
  const result = await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => { if (step === 'published') await rm(intent); } });
  assert.equal(result.imported, 1); assert.ok('skipped' in result); assert.deepEqual(result.skipped, []);
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 1);
});
