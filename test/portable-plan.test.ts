import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { remember, renew, exportDir, importDir, MemoryError, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { digest } from '../src/core.ts';
import { policyBody } from '../src/portable.ts';
import { pendingImport } from '../src/portable-plan.ts';
import { tracker, snapshot } from './helpers.ts';

/** Build one actual pending-data scenario without mocks or repository discovery. */
async function pendingScenario(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t); const target = await tracker(t);
  await remember('Public review policy', { ...source.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...source.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Reviewed' });
  const path = join(source.root, 'export'); await exportDir(path, { ...source.options, to: 'agents-md' });
  return { source, target, path, intent: join(target.workspace, 'runtime', 'memory-policy-import.json') };
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
  const base = { input: 'input', transactionId: `memory-policy-${'a'.repeat(40)}`, author: 'test', members: [], mutations: [], result: {} };
  for (const value of ['{', 'null', '{}', JSON.stringify({ ...base, transactionId: '../foreign' }), JSON.stringify({ ...base, input: null }), JSON.stringify({ ...base, author: null }), JSON.stringify({ ...base, members: null }), JSON.stringify({ ...base, members: [3] }), JSON.stringify({ ...base, mutations: null }), JSON.stringify({ ...base, mutations: [{ op: 'close' }] }), JSON.stringify({ ...base, mutations: [{ op: 'update', id: 3 }] }), JSON.stringify({ ...base, mutations: [{ op: 'update', id: 'x', options: null }] }), JSON.stringify({ ...base, mutations: [{ op: 'create', id: 'x', options: 3 }] })]) {
    await writeFile(intent, JSON.stringify({ owner: 'pm-memory-policy-plan:1', payload: value, checksum: digest(value) }));
    await assert.rejects(pendingImport(target.store), refused);
  }
});

test('a different input cannot bypass an interrupted plan and malformed SDK journals stay preserved', async t => {
  const { target, path, intent } = await pendingScenario(t);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'intent') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const row = (JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest).guidance[0];
  const bodyPath = join(path, row.path); const body = await readFile(bodyPath);
  await writeFile(bodyPath, policyBody(row, 'Different input'));
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), refused);
  await writeFile(bodyPath, body);
  const plan = JSON.parse(JSON.parse(await readFile(intent, 'utf8')).payload) as { transactionId: string };
  await mkdir(join(target.workspace, 'transactions', 'sdk'), { recursive: true });
  const journal = join(target.workspace, 'transactions', 'sdk', `${plan.transactionId}-snapshot.json`);
  await writeFile(journal, '{'); await assert.rejects(pendingImport(target.store), refused); assert.equal(await readFile(journal, 'utf8'), '{');
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
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), refused);
  assert.equal((await target.client.get(id, { full: true })).item.body, 'Native peer edit');
});

test('relationship inventory rejects malformed edges and unavailable targets before writes', async t => {
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
  await assert.rejects(exportDir(join(source.root, 'refused'), { ...source.options, to: 'agents-md' }), refused);
});
