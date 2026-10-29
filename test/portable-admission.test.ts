import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTransactionInterruptedError, getItemPath, getItemAt, readSettings, resolveItemTypeRegistry, locateItem, getHistoryPath, readHistoryEntries, commitItemMutations, serializeItemDocument, canonicalDocument, type WorkspaceTransactionTransitionContext } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, renew, MemoryError, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { policyBody, skipOccupiedIdentities } from '../src/portable.ts';
import { commitPortableBatch } from '../src/portable-write.ts';
import { digest } from '../src/core.ts';
import { importIdentity, validateImportPlan, pendingImport, applyImport, type ImportPlan } from '../src/portable-plan.ts';
import { tracker, memoryDocuments, assertClosedGraph, crashAfterCompensation, crashAtStep, importSubset, explicitRecreation } from './helpers.ts';

/** A real two-target import plus a bounded unchanged read-set dependency. */
async function admissionScenario(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t); const target = await tracker(t);
  await remember('Alpha A', { ...source.options, slug: 'alpha', kind: 'project' });
  await remember('Beta A', { ...source.options, slug: 'beta', kind: 'reference' });
  await remember('Policy A', { ...source.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...source.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Admission scenario' });
  const path = join(source.root, 'admission-export'); await exportDir(path, { ...source.options, to: 'agents-md' });
  await importDir(path, { ...target.options, from: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  for (const row of manifest.guidance.filter(row => row.slug !== 'policy')) await writeFile(join(path, row.path), policyBody(row, `${row.slug} B`));
  const items = (await target.client.listAllComplete({ includeBody: true })).items;
  return { source, target, path, items, intent: join(target.workspace, 'runtime', 'memory-policy-import.json') };
}
/** Read the frozen creation request without using the importer's field projection. */
async function plannedCreation(target: Awaited<ReturnType<typeof tracker>>, stage: 'nodes' | 'mutations' = 'nodes') {
  const envelope = JSON.parse(await readFile(join(target.workspace, 'runtime', 'memory-policy-import.json'), 'utf8')) as { payload: string };
  const plan = JSON.parse(envelope.payload) as ImportPlan; return plan[stage]?.[0] ?? plan.mutations[0];
}
test('committed attempts are skipped by allocation and by stale-intent recovery after deletion', async t => {
  const { target, path, intent } = await admissionScenario(t);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'published') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const plan = JSON.parse(JSON.parse(await readFile(intent, 'utf8')).payload) as ImportPlan;
  const next = await target.store.write(() => importIdentity(target.store, plan.input, plan.attempt));
  assert.notEqual(next.transactionId, plan.transactionId); assert.notEqual(next.attempt, plan.attempt);
  for (const item of (await target.client.listAllComplete()).items) await target.client.run('delete', { id: item.id, options: { force: true } });
  assert.equal((await explicitRecreation(path, { ...target.options, from: 'agents-md' })).imported, 3);
  const blocked = await tracker(t); await mkdir(join(blocked.workspace, 'transactions'), { recursive: true });
  await writeFile(join(blocked.workspace, 'transactions', 'sdk'), 'Foreign non-directory');
  await assert.rejects(importIdentity(blocked.store, plan.input), error => error instanceof MemoryError && error.code === 'transaction');
});


test('legacy exports also report excluded canceled links', async t => {
  const source = await tracker(t);
  const alpha = await remember('Alpha', { ...source.options, slug: 'alpha', kind: 'reference' });
  const beta = await remember('Beta', { ...source.options, slug: 'beta', kind: 'reference' });
  await source.store.link(alpha.id, beta.id); await source.client.update(beta.id, { status: 'canceled' });
  const result = await exportDir(join(source.root, 'legacy'), { ...source.options, to: 'agents-md' });
  assert.deepEqual(result.omitted_links?.map(row => row.reason), ['canceled']);
});


test('occupied identity selection uses complete SDK inventories and preserves foreign records', async t => {
  const { source } = await admissionScenario(t); const target = await tracker(t);
  const manifestPath = join(source.root, 'admission-export', POLICY_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PortablePolicyManifest;
  const foreign = await target.client.create({ title: 'Foreign task' });
  const ids = new Map(manifest.guidance.map(row => [row.slug, foreign.item.id]));
  const occupied = new Set((await target.client.listAllComplete()).items.map(row => row.id));
  const skipped = new Map<string, string>();
  skipOccupiedIdentities(manifest.guidance, new Set(), occupied, ids, skipped);
  assert.equal(skipped.size, 3); assert.ok([...skipped.values()].every(reason => reason.includes('Foreign')));
  const native = new Set((await source.store.read()).map(row => row.slug)); const admitted = new Map<string, string>();
  skipOccupiedIdentities(manifest.guidance, native, occupied, ids, admitted); assert.equal(admitted.size, 0);
  assert.equal((await target.client.get(foreign.item.id, { full: true })).item.title, 'Foreign task');
});


test('foreign serialized records without package history are retained at reserved identities', async t => {
  const { path } = await admissionScenario(t); const target = await tracker(t);
  const base = await target.client.create({ title: 'Native foreign template' }); let id = '';
  const result = await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step !== 'intent') return;
    const envelope = JSON.parse(await readFile(join(target.workspace, 'runtime', 'memory-policy-import.json'), 'utf8')) as { payload: string };
    const plan = JSON.parse(envelope.payload) as ImportPlan; id = plan.mutations[0].id;
    const document = canonicalDocument({ metadata: { ...base.item, id, title: 'Foreign serialized record' }, body: 'Foreign body' });
    await writeFile(getItemPath(target.workspace, 'Task', id, 'toon'), serializeItemDocument(document, { format: 'toon' }));
  } });
  assert.ok('skipped' in result); assert.ok(result.skipped.every(row => row.reason.includes('Foreign')));
  assert.equal((await target.client.get(id, { full: true })).item.body, 'Foreign body');
});


test('copied creation bookkeeping never grants ownership over a foreign birth at any CAS boundary', async t => {
  const source = await tracker(t); await remember('Owned instructions', { ...source.options, slug: 'alpha', kind: 'reference' });
  const path = join(source.root, 'policy'); await exportDir(path, { ...source.options, to: 'agents-md' });
  const raw = join(source.root, 'alpha.md'); await writeFile(raw, 'Owned instructions');
  for (const input of [path, raw]) for (const recovery of [false, true]) for (const boundary of ['intent', 'item-read']) for (const type of ['Task', 'Knowledge']) {
    const target = await tracker(t); let injected = false; let id = '';
    if (recovery) await assert.rejects(importDir(input, { ...target.options, from: 'agents-md', onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
    const inject = async (step: string) => {
      if (step !== boundary || injected) return;
      let text: string;
      try { text = await readFile(join(target.workspace, 'runtime', 'memory-policy-import.json'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const envelope = JSON.parse(text) as { payload: string };
      const plan = JSON.parse(envelope.payload) as ImportPlan;
      const mutation = plan.mutations[0]; id = mutation.id;
      if (injected) return;
      injected = true;
      await target.client.create({ ...mutation.options, id, type, body: 'Peer native body' });
    };
    // Recovery validates before publishing intent again, so its equivalent intent boundary is cas-read.
    const hook = inject;
    const outcome = await importDir(input, { ...target.options, from: 'agents-md', onStep: hook }).then(receipt => ({ receipt }), (error: unknown) => ({ error }));
    assert.equal(injected, true, `${input === raw ? 'raw' : 'policy'} ${recovery} ${boundary} ${type}`);
    const rows = (await target.client.listAllComplete({ includeBody: true })).items;
    assert.ok(rows.some(row => row.id === id && row.type === type && row.body === 'Peer native body'), 'SDK read-back must retain the foreign creation');
    assert.ok('receipt' in outcome, 'Foreign births must be skipped without throwing');
    assert.ok('skipped' in outcome.receipt); assert.ok(outcome.receipt.skipped.every(row => row.reason.includes('Foreign')));
    const before = (await target.client.get(id, { full: true })).item;
    assert.equal(before.type, type); assert.equal(before.body, 'Peer native body');
    await importDir(input, { ...target.options, from: 'agents-md' });
    assert.deepEqual((await target.client.get(id, { full: true })).item, before);
  }
});


test('foreign metadata is excluded from exports and wrong-type identities skip on import', async t => {
  const { source, path } = await admissionScenario(t);
  const alpha = (await source.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!;
  await source.client.run('create', { options: { title: 'Foreign knowledge', type: 'Knowledge', memorySlug: 'foreign', memorySource: 'foreign-tool', memoryKind: 'unsupported', memoryValidity: 'invalid' } });
  const foreign = (await source.client.listAllComplete()).items.find(row => row.memory_slug === 'foreign')!;
  await source.store.link(alpha.id, foreign.id);
  const output = join(source.root, 'foreign-export');
  const receipt = await exportDir(output, { ...source.options, to: 'agents-md' });
  assert.deepEqual(receipt.skipped?.map(row => row.slug), [foreign.id]);
  assert.ok(receipt.omitted_links?.some(row => row.target === foreign.id));
  const target = await tracker(t); await target.store.register();
  await target.client.run('create', { options: { title: 'Foreign task identity', type: 'Task', memorySlug: 'policy', memorySource: 'native:item', memoryKind: 'unsupported' } });
  const imported = await importDir(path, { ...target.options, from: 'agents-md' });
  assert.ok('skipped' in imported); assert.ok(imported.skipped.some(row => row.slug === 'policy'));
  assert.equal(imported.imported, 2);
});


test('copied node markers with unplanned full-document data never authorize cancellation or replay', async t => {
  let cases = 0;
  for (const from of ['agents-md', 'claude-code'] as const) for (const recovery of [false, true]) for (const shape of ['priority', 'custom', 'dependencies']) {
    const target = await tracker(t); const input = join(target.root, 'alpha.md'); await writeFile(input, '# Alpha\nInstructions');
    if (shape === 'custom') await target.client.schemaAddField('foreign_note', { type: 'string', required: false, requiredOnCreate: false, allowUnset: true, commands: ['create', 'update'], cliFlag: 'foreign-note', description: 'Foreign creation evidence' });
    const task = shape === 'dependencies' ? (await target.client.create({ title: 'Peer dependency' })).item.id : undefined;
    if (recovery) await assert.rejects(importDir(input, { ...target.options, from, onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
    let injected = false; let before: unknown;
    const result = await importDir(input, { ...target.options, from, onStep: async step => {
      if (injected || step !== 'intent') return;
      injected = true; const node = await plannedCreation(target);
      const extra = shape === 'priority' ? { priority: 1 } : shape === 'custom' ? { foreignNote: 'Peer evidence' } : { dep: [`id=${task!},kind=related`] };
      // Copy the actual node request INCLUDING its author and transaction marker.
      await target.client.create({ ...node.options, id: node.id, ...extra });
      before = (await target.client.listAllComplete({ includeBody: true })).items;
    } });
    assert.ok(injected); assert.ok('skipped' in result); assert.match(result.skipped[0].reason, /Foreign/);
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before, `${from}/${recovery}/${shape}`);
    await importDir(input, { ...target.options, from });
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before, 'Retry preserves every peer value and edge');
    await writeFile(input, 'A later harness revision must not acquire the foreign birth');
    const editedRetry = await importDir(input, { ...target.options, from });
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before, 'Edited retry cannot adopt the foreign item');
    assert.ok('skipped' in editedRetry); assert.match(editedRetry.skipped[0].reason, /Foreign/);
    cases++;
  }
  t.diagnostic(`Independent SDK read-back: ${cases} copied-marker adversaries; priority, custom metadata, dependency across both adapters and fresh/recovery paths`);
});


