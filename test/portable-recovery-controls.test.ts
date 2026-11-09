import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { commitWorkspaceTransaction, WorkspaceTransactionInterruptedError, deleteItem, getHistoryPath, readSettings, locateItem, resolveItemTypeRegistry, serializeItemDocument, createHistoryEntry, appendHistoryEntry } from '@unbrained/pm-cli/sdk';
import type { WorkspaceTransactionJsonValue } from '@unbrained/pm-cli/sdk';
import { importDir, exportDir, remember, MemoryError } from '../index.ts';
import { digest } from '../src/core.ts';
import { nativeState } from '../src/native-revision.ts';
import { pendingImport, recoverInput, applyImport, savePlan, validateImportPlan, retainForwardWrites } from '../src/portable-plan.ts';
import { captureBirths } from '../src/portable-preview.ts';
import { assertBase, commitPortableBatch } from '../src/portable-write.ts';
import { capturedPublication } from './portable-publication-helpers.ts';
import { tracker, snapshot, readImportPlan } from './helpers.ts';
import { nativeHost } from './native-host-helpers.ts';

/** Persist adversarial recovery input using the same owned envelope as genuine plans. */
async function fixtureIntent(workspace: string, value: unknown): Promise<string> {
  const payload = JSON.stringify(value); const file = join(workspace, 'runtime', 'memory-policy-import.json');
  await writeFile(file, JSON.stringify({ owner: 'pm-memory-policy-plan:1', payload, checksum: digest(payload) }));
  return file;
}

/** Build a genuine SDK graph shared by admission and post-no-op dependency controls. */
async function linkedFixture(t: Parameters<typeof tracker>[0], cyclic = false) {
  const target = await tracker(t); const input = join(target.root, 'input'); await mkdir(input);
  await writeFile(join(input, 'alpha.md'), 'Alpha A [[beta]]');
  await writeFile(join(input, 'beta.md'), cyclic ? 'Beta A [[alpha]]' : 'Beta A');
  await importDir(input, { ...target.options, from: 'agents-md' });
  return { target, input };
}

test('proofless legacy receipts cannot turn a copied marker and recurring content into write authority', async t => {
  const { target, plan, mutation, before } = await capturedPublication(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(before.proof.version!) });
  const message = `bulk-item-transaction ${plan.transactionId} forward ${mutation.id}`;
  const legacy = { ...plan.ownership![0] }; delete legacy.proof;
  await target.client.run('update', { id: mutation.id, options: { ...mutation.options, message } });
  await commitWorkspaceTransaction({ pmRoot: target.workspace, author: plan.author, transactionId: `${plan.transactionId}-snapshot`, steps: [{ id: 'legacy-publication', inspect: async () => ({ state: 'pending' }), apply: async () => JSON.parse(JSON.stringify({ owner: 'pm-memory-policy-ownership:1', targets: [legacy] })) as WorkspaceTransactionJsonValue, compensate: retainForwardWrites }] });
  await target.client.update(mutation.id, { body: 'Native C', title: 'Native C' });
  await target.client.run('update', { id: mutation.id, options: { ...mutation.options, message } });
  const recurring = await nativeState(target.store, mutation.id);
  assert.equal(recurring.proof.version, before.proof.version);
  const input = join(target.root, 'input'); await writeFile(join(input, 'alpha.md'), 'Alpha A');
  const kept = await snapshot(target.workspace);
  const refused = await importDir(input, { ...target.options, from: 'agents-md' });
  assert.equal(refused.updated, 0); assert.ok('skipped' in refused && refused.skipped.some(row => row.slug === 'alpha'));
  assert.deepEqual(await snapshot(target.workspace), kept);
  await writeFile(join(input, 'alpha.md'), 'Alpha B');
  assert.equal((await importDir(input, { ...target.options, from: 'agents-md' })).unchanged, 1);
  const output = join(target.root, 'legacy-readable'); await exportDir(output, { ...target.options, to: 'agents-md' });
  const fresh = await tracker(t); assert.equal((await importDir(output, { ...fresh.options, from: 'agents-md' })).imported, 1);
  assert.equal((await fresh.client.listAllComplete({ includeBody: true })).items[0].body, 'Alpha B');
});

test('native deletion inside a write observer is not journaled as the import publication', async t => {
  const { target, mutation } = await capturedPublication(t); const input = join(target.root, 'input'); let deleted = false;
  const other = (await target.client.create({ title: 'Independent native task' })).item;
  await assert.rejects(importDir(input, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step !== 'write-guard' || deleted) return;
    deleted = true; await deleteItem(other.id, { force: true }, { pmRoot: target.workspace });
    throw new WorkspaceTransactionInterruptedError();
  } }), WorkspaceTransactionInterruptedError);
  assert.equal(deleted, true); assert.equal((await readImportPlan(target.workspace)).publication, undefined);
  assert.equal((await target.client.get(mutation.id, { full: true })).item.body, 'Alpha A');
  assert.equal((await importDir(input, { ...target.options, from: 'agents-md' })).updated, 1);
  assert.equal((await target.client.listAllComplete()).items.length, 1);
});

test('ordinary SDK compensation retains a completed forward item and recovery makes no second item write', async t => {
  const { target, plan, mutation } = await capturedPublication(t); const transitions: string[] = [];
  await assert.rejects(target.store.write(async () => {
    await savePlan(target.store, plan);
    await commitPortableBatch(target.store, plan, plan.transactionId, 'data', plan.mutations, { ...target.options, from: 'agents-md', onTransition: event => {
      transitions.push(event.transition); if (event.transition === 'step_recorded') throw new Error('Ordinary post-write failure');
    } });
  }), /Ordinary post-write failure/);
  assert.ok(transitions.includes('compensated'));
  const kept = await nativeState(target.store, mutation.id); assert.equal(kept.document!.body, 'Alpha B');
  await importDir(join(target.root, 'input'), { ...target.options, from: 'agents-md' });
  assert.deepEqual(await nativeState(target.store, mutation.id), kept);
});

test('owned malformed recovery shapes refuse before native data or the intent is changed', async t => {
  const { target, plan, before } = await capturedPublication(t);
  const row = plan.expected[0];
  const publication = { id: row.id, transactionId: plan.transactionId, stepId: 'old-step', before: before.proof, proposed: before.proof.hash, target: plan.ownership![0] };
  const variants = [
    { expected: [null] }, { expected: [{ ...row, version: 4 }] }, { expected: [{ ...row, origin: {} }] },
    { mutations: [null] }, { mutations: [[]] }, { forwardOnly: 2 },
    { publication: { ...publication, id: 3 } }, { publication: { ...publication, proposed: null } },
    { publication, forwardOnly: undefined },
  ];
  for (const variant of variants) {
    const file = await fixtureIntent(target.workspace, { ...plan, ...variant }); const bytes = await readFile(file, 'utf8');
    const kept = await snapshot(target.workspace);
    await assert.rejects(pendingImport(target.store), error => error instanceof MemoryError && error.code === 'history');
    assert.equal(await readFile(file, 'utf8'), bytes); assert.deepEqual(await snapshot(target.workspace), kept);
  }
  await assert.rejects(recoverInput(target.store, 'current-input', { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'history');
  const file = await fixtureIntent(target.workspace, { ...plan, forwardOnly: undefined });
  assert.equal(await pendingImport(target.store), undefined);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.deepEqual(await nativeState(target.store, row.id), before);
});

test('a foreign intent replacing a proven interrupted publication is retained with a typed skip', async t => {
  const { target } = await capturedPublication(t); const input = join(target.root, 'input');
  await assert.rejects(importDir(input, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'written') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const foreign = '{"owner":"independent-peer"}';
  const result = await recoverInput(target.store, 'fresh-input', { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'recover-publication') await writeFile(join(target.workspace, 'runtime', 'memory-policy-import.json'), foreign);
  } });
  assert.ok(result?.skipped.some(row => row.slug === 'pending-import'));
  assert.equal(await readFile(join(target.workspace, 'runtime', 'memory-policy-import.json'), 'utf8'), foreign);
  assert.equal((await target.client.listAllComplete({ includeBody: true })).items[0].body, 'Alpha B');
});

test('a mismatched attempt marker returns the foreign result while retries preserve the intent and journal', async t => {
  const { target, plan } = await capturedPublication(t);
  await target.store.write(async () => { await savePlan(target.store, plan); });
  const intentFile = join(target.workspace, 'runtime', 'memory-policy-import.json');
  const intent = await readFile(intentFile, 'utf8');
  // A foreign coordinator marker occupies the exact attempt slot under the same author and step identity.
  await assert.rejects(commitWorkspaceTransaction({ pmRoot: target.workspace, author: plan.author, transactionId: plan.transactionId, recoveryData: { owner: 'another-package' }, steps: [{ id: 'attempt', inspect: async () => ({ state: 'pending' }), apply: async () => null, compensate: retainForwardWrites }], onTransition: event => { if (event.transition === 'prepared') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const journalFile = join(target.workspace, 'transactions', 'sdk', `${plan.transactionId}.json`);
  const journal = await readFile(journalFile, 'utf8');
  const kept = await snapshot(target.workspace);
  for (const retry of [1, 2]) {
    const result = await recoverInput(target.store, 'current-input', { ...target.options, from: 'agents-md' });
    assert.deepEqual(result, { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: [{ slug: 'pending-import', reason: 'Foreign pending import record retained' }] }, `retry ${retry} must report the retained foreign attempt marker`);
    assert.equal(await readFile(intentFile, 'utf8'), intent, `retry ${retry} must preserve the owned intent`);
    assert.equal(await readFile(journalFile, 'utf8'), journal, `retry ${retry} must preserve the foreign journal`);
  }
  assert.deepEqual(await snapshot(target.workspace), kept);
});

test('unsealed and sealed birth captures derive only the requested SDK creation and preserve an earlier independent document', async t => {
  const { target: source } = await capturedPublication(t); const fresh = await tracker(t); const input = join(source.root, 'input');
  await assert.rejects(importDir(input, { ...fresh.options, from: 'agents-md', onStep: step => { if (step === 'intent') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const plan = await readImportPlan(fresh.workspace); const original = plan.births![0];
  await pendingImport(fresh.store);
  delete plan.nodes; plan.births = [{ id: original.id, document: original.document }];
  const kept = await snapshot(fresh.workspace);
  await captureBirths(fresh.store, plan); assert.equal(plan.births[0].document, original.document); assert.equal(typeof plan.births[0].message, 'string');
  await captureBirths(fresh.store, plan); assert.equal(plan.births[0].document, original.document);
  plan.births = [{ id: 'unrelated-birth', document: 'Never adopt this unrelated document' }];
  await captureBirths(fresh.store, plan); assert.equal(plan.births[0].id, original.id); assert.equal(plan.births[0].document, original.document);
  assert.deepEqual(await snapshot(fresh.workspace), kept);
  await fresh.store.write(() => applyImport(fresh.store, plan, { ...fresh.options, from: 'agents-md' }));
  assert.equal((await fresh.client.listAllComplete({ includeBody: true })).items[0].body, 'Alpha B');
});

test('legacy typed plans and empty creation capture retain SDK state and validate complete read sets', async t => {
  const { target, plan, mutation, before } = await capturedPublication(t);
  const missing = { ...plan, expected: [] };
  const kept = await snapshot(target.workspace);
  await assert.rejects(validateImportPlan(target.store, missing), error => error instanceof MemoryError && error.code === 'history');
  assert.deepEqual(await snapshot(target.workspace), kept);
  const empty = { ...plan }; delete empty.nodes; delete empty.births;
  await captureBirths(target.store, empty); assert.deepEqual(empty.births, []);
  assert.throws(() => assertBase(mutation.id, before.document, null, before.document), /base changed/);
  delete plan.outcomes;
  const result = await target.store.write(() => applyImport(target.store, plan, { ...target.options, from: 'agents-md' }));
  assert.equal(result.updated, 1); assert.equal((await target.client.get(mutation.id, { full: true })).item.body, 'Alpha B');
});

test('a native deletion at item admission skips the observed identity and never recreates it', async t => {
  const { target, mutation } = await capturedPublication(t); let deleted = false;
  const result = await importDir(join(target.root, 'input'), { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'item-read' && !deleted) { deleted = true; await target.client.run('delete', { id: mutation.id, options: { force: true } }); }
  } });
  assert.equal(result.updated, 0); assert.ok('skipped' in result && result.skipped.some(row => row.conflict?.fields.includes('id')));
  assert.equal((await target.client.listAllComplete()).items.length, 0);
});

test('an unreadable dependency history aborts admission without changing native items and remains retryable', async t => {
  const target = await tracker(t); const input = join(target.root, 'input'); await mkdir(input);
  await writeFile(join(input, 'alpha.md'), '# Alpha A [[beta]]'); await writeFile(join(input, 'beta.md'), '# Beta A');
  await importDir(input, { ...target.options, from: 'agents-md' });
  const rows = (await target.client.listAllComplete({ includeBody: true })).items;
  const beta = rows.find(row => row.memory_slug === 'beta')!; const history = getHistoryPath(target.workspace, beta.id); const mode = (await stat(history)).mode & 0o777;
  await writeFile(join(input, 'alpha.md'), '# Alpha B [[beta]]');
  try {
    await assert.rejects(importDir(input, { ...target.options, from: 'agents-md', onStep: async step => { if (step === 'item-read') await chmod(history, 0); } }), error => error instanceof MemoryError && error.code === 'transaction');
  } finally { await chmod(history, mode); }
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, rows);
  assert.equal((await importDir(input, { ...target.options, from: 'agents-md' })).updated, 1);
});

test('a changed native type default cannot replace the independently captured complete birth', async t => {
  const { target: source } = await capturedPublication(t); const target = await tracker(t);
  const result = await importDir(join(source.root, 'input'), { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'intent') await target.client.schemaAddType('Knowledge', { defaultStatus: 'in_progress', force: true });
  } });
  assert.equal(result.imported, 0); assert.ok('skipped' in result && result.skipped.some(row => row.conflict?.fields.includes('birth')));
  assert.equal((await target.client.listAllComplete()).items.length, 0);
});

test('a native history append after SDK capture cannot publish against its stale before image', async t => {
  const { target, mutation } = await capturedPublication(t); let peer: Awaited<ReturnType<typeof nativeState>> | undefined; let injected = false;
  const result = await importDir(join(target.root, 'input'), { ...target.options, from: 'agents-md', onStep: async step => {
    if (step !== 'write-guard' || injected) return;
    injected = true;
    const before = (await nativeState(target.store, mutation.id)).document!;
    const settings = await readSettings(target.workspace);
    const located = await locateItem(target.workspace, mutation.id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder); assert.ok(located);
    const after = { ...before, metadata: { ...before.metadata, updated_at: '2001-01-01T00:00:00.000Z' } };
    await appendHistoryEntry(getHistoryPath(target.workspace, mutation.id), createHistoryEntry({ nowIso: after.metadata.updated_at, author: 'independent-native-writer', op: 'update', before, after }));
    await writeFile(located.itemPath, serializeItemDocument(after, { format: settings.item_format }));
    peer = await nativeState(target.store, mutation.id);
  } });
  assert.ok(peer); assert.equal(result.updated, 0); assert.ok('skipped' in result && result.skipped.some(row => row.conflict?.fields.includes('revision')));
  assert.deepEqual(await nativeState(target.store, mutation.id), peer);
});

test('SDK no-op read-back rechecks dependency revisions after a host retry dispatch', async t => {
  const { target, input } = await linkedFixture(t);
  const alpha = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!;
  const beta = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'beta')!;
  await writeFile(join(input, 'alpha.md'), 'Alpha B [[beta]]'); let guarded = false; let attempts = 0;
  const result = await nativeHost(target.workspace, async (client, hooks) => {
    hooks.onRead.push({ layer: 'project', name: 'test-dependency-peer', run: async context => {
      if (guarded && attempts === 0 && context.path.endsWith(`${alpha.id}.toon`)) {
        attempts++; await target.client.update(beta.id, { body: 'Native beta C' });
      }
    } });
    return importDir(input, { ...target.options, client, from: 'agents-md', onStep: async step => {
      if (step === 'write-guard') guarded = true;
      if (step !== 'intent') return;
      const request = (await readImportPlan(target.workspace)).mutations.find(row => row.id === alpha.id)!;
      const fields = { ...request.options };
      for (const key of ['memoryChangedAt', 'memoryVerdict', 'memoryVerifiedAt', 'memoryReason', 'unset']) delete fields[key];
      await target.client.run('update', { id: alpha.id, options: fields });
    } });
  });
  assert.equal(attempts, 1); assert.equal(result.updated, 0);
  assert.ok('skipped' in result && result.skipped.some(row => row.conflict?.item === beta.id));
  assert.equal((await target.client.get(beta.id, { full: true })).item.body, 'Native beta C');
  assert.equal((await target.client.get(alpha.id, { full: true })).item.body, 'Alpha B [[beta]]');
});

test('SDK compensation calls the shared forward retention policy after a later native step refuses', async t => {
  const { target, mutation } = await capturedPublication(t); let applied = false;
  await assert.rejects(commitWorkspaceTransaction({ pmRoot: target.workspace, author: target.options.author, transactionId: 'forward-retention-control', steps: [
    { id: 'native-forward-write', inspect: async () => ({ state: (await target.client.get(mutation.id, { full: true })).item.body === 'Completed forward B' ? 'applied' : 'pending' }), apply: async () => { await target.client.update(mutation.id, { body: 'Completed forward B' }); applied = true; return null; }, compensate: retainForwardWrites },
    { id: 'refused-next-step', inspect: async () => ({ state: 'pending' }), apply: async () => { throw new Error('Later step refused'); }, compensate: retainForwardWrites },
  ] }), /Later step refused/);
  assert.equal(applied, true); assert.equal((await target.client.get(mutation.id, { full: true })).item.body, 'Completed forward B');
});

test('a dependency conflict at admission closes a cyclic graph without publishing either item', async t => {
  const { target, input } = await linkedFixture(t, true);
  const rows = (await target.client.listAllComplete({ includeBody: true })).items;
  const alpha = rows.find(row => row.memory_slug === 'alpha')!; const beta = rows.find(row => row.memory_slug === 'beta')!;
  const before = await nativeState(target.store, alpha.id);
  await writeFile(join(input, 'alpha.md'), 'Alpha B [[beta]]'); let injected = false;
  const result = await importDir(input, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step !== 'item-read' || injected) return;
    injected = true; await target.client.update(beta.id, { body: 'Native beta C' });
  } });
  assert.equal(result.updated, 0); assert.ok('skipped' in result); assert.deepEqual(result.skipped.map(row => row.slug).sort(), ['alpha', 'beta']);
  assert.deepEqual(await nativeState(target.store, alpha.id), before);
  assert.equal((await target.client.get(beta.id, { full: true })).item.body, 'Native beta C');
});
