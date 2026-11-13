import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitWorkspaceTransaction, readWorkspaceTransaction, setActiveExtensionHooks, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import type { WorkspaceTransactionJsonValue, WorkspaceTransactionStep } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook } from '@unbrained/pm-cli/sdk/authoring';
import { importDir, MemoryError } from '../index.ts';
import { Store } from '../src/store.ts';
import { documentHash, nativeState, trackerSchema } from '../src/native-revision.ts';
import { pendingImport, savePlan, retainForwardWrites, applyImport, importIdentity } from '../src/portable-plan.ts';
import { commitPortableBatch } from '../src/portable-write.ts';
import type { Publication } from '../src/portable-write.ts';
import { tracker, readImportPlan, withoutGit } from './helpers.ts';
import { capturedPublication } from './portable-publication-helpers.ts';
import { nativeHost } from './native-host-helpers.ts';

/** Interrupt an actual unmarked SDK coordinator after its native write and before its receipt. */
async function interruptSnapshot(fixture: Awaited<ReturnType<typeof capturedPublication>>, base: string, stepId: string, options: Record<string, unknown>, foreign?: 'author' | 'step' | 'steps') {
  const { target, plan, mutation } = fixture; const transactionId = `${base}-snapshot`;
  const message = `bulk-item-transaction ${base} forward ${mutation.id}`;
  const schema = await trackerSchema(target.workspace);
  const capture: BeforeMutationHook = async context => {
    if (context.operation !== 'update' || context.after?.metadata.id !== mutation.id) return;
    const before = await nativeState(target.store, mutation.id);
    plan.publication = { id: mutation.id, transactionId: base, stepId, message, before: before.proof, proposed: documentHash(context.after, schema)!, target: plan.ownership![0] };
    await savePlan(target.store, plan);
  };
  const publish = () => nativeHost(target.workspace, async (client, hooks) => {
    setActiveExtensionHooks({ ...hooks, beforeMutation: [...hooks.beforeMutation.slice(1), hooks.beforeMutation[0]] });
    await savePlan(target.store, plan);
    const steps: WorkspaceTransactionStep[] = [{ id: foreign === 'step' ? 'foreign-step' : stepId, inspect: async () => ({ state: 'pending' }), apply: async () => {
      assert.ok((await readImportPlan(target.workspace)).publication === undefined);
      await client.run('update', { id: mutation.id, options: { ...options, author: plan.author, message } });
      assert.ok((await readImportPlan(target.workspace)).publication);
      return null;
    }, compensate: retainForwardWrites }];
    if (foreign === 'steps') steps.push({ id: 'another-step', inspect: async () => ({ state: 'pending' }), apply: retainForwardWrites, compensate: retainForwardWrites });
    await commitWorkspaceTransaction({ pmRoot: target.workspace, transactionId, author: foreign === 'author' ? 'foreign-owner' : plan.author, steps, onTransition: event => { if (event.transition === 'step_applied') throw new WorkspaceTransactionInterruptedError(); } });
  }, capture);
  await assert.rejects(target.store.leases.getStore() === undefined ? target.store.write(publish) : publish(), WorkspaceTransactionInterruptedError);
  const journal = await readWorkspaceTransaction(target.workspace, transactionId);
  assert.equal(journal?.status, 'applying'); assert.equal(journal.recoveryData, undefined);
  assert.deepEqual(journal.completedStepIds, []);
  const native = await nativeState(target.store, mutation.id); assert.equal(native.document!.body, 'Alpha B');
  return { ...fixture, transactionId, stepId, native, intent: join(target.workspace, 'runtime', 'memory-policy-import.json') };
}

/** Produce the interrupted snapshot shape written by the previous SDK adoption code in a non-git tracker. */
async function interruptedLegacy(t: Parameters<typeof tracker>[0], foreign?: 'author' | 'step' | 'steps') {
  const fixture = await capturedPublication(t); withoutGit(t, fixture.target.root);
  return interruptSnapshot(fixture, fixture.plan.transactionId, 'legacy-publication', fixture.mutation.options!, foreign);
}

/** A refusal must preserve both its durable intent bytes and the complete SDK journal. */
async function assertRetainedIntent(target: Awaited<ReturnType<typeof tracker>>, transactionId: string, intent: string, code: 'history' | 'foreign_intent'): Promise<void> {
  const [bytes, journal] = await Promise.all([readFile(intent), readWorkspaceTransaction(target.workspace, transactionId)]);
  await assert.rejects(pendingImport(new Store(target.options)), error => error instanceof MemoryError && error.code === code);
  assert.deepEqual(await readFile(intent), bytes); assert.deepEqual(await readWorkspaceTransaction(target.workspace, transactionId), journal);
}

test('unmarked snapshot publication survives two process-boundary interruptions and commits exactly once after restart', async t => {
  const { target, transactionId, stepId, native, intent, before } = await interruptedLegacy(t);
  const bytes = await readFile(intent);
  await assert.rejects(pendingImport(new Store(target.options), undefined, event => { if (event.transition === 'committing') throw new WorkspaceTransactionInterruptedError(); }), WorkspaceTransactionInterruptedError);
  assert.deepEqual(await readFile(intent), bytes);
  assert.ok((await readImportPlan(target.workspace)).publication);
  assert.equal((await readWorkspaceTransaction(target.workspace, transactionId))?.status, 'applying');
  let committed = 0;
  assert.equal(await pendingImport(new Store(target.options), undefined, event => { if (event.transition === 'committed') committed++; }), undefined);
  assert.equal(committed, 1); await assert.rejects(access(intent), { code: 'ENOENT' });
  const receipt = await readWorkspaceTransaction(target.workspace, transactionId);
  assert.equal(receipt?.status, 'committed'); assert.equal(receipt.recoveryData, undefined);
  const result = receipt.results[stepId] as { owner: string; targets: { proof: { length: number } }[] };
  assert.equal(result.owner, 'pm-memory-policy-ownership:1'); assert.equal(result.targets[0].proof.length, before.proof.length + 1);
  assert.deepEqual(await nativeState(target.store, native.document!.metadata.id), native);
  assert.equal(await pendingImport(new Store(target.options), undefined, () => { committed++; }), undefined);
  assert.equal(committed, 1); assert.deepEqual(await readWorkspaceTransaction(target.workspace, transactionId), receipt);
});

test('a completed import clears its publication and durable intent after the receipt commits', async t => {
  const { target } = await capturedPublication(t); let checked = false;
  const result = await importDir(join(target.root, 'input'), { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'published') { checked = true; assert.equal((await readImportPlan(target.workspace)).publication, undefined); }
  } });
  assert.equal(result.updated, 1); assert.equal(checked, true);
  await assert.rejects(access(join(target.workspace, 'runtime', 'memory-policy-import.json')), { code: 'ENOENT' });
});

for (const foreign of ['author', 'step', 'steps'] as const) test(`unmarked ${foreign} collisions retain the publication intent and journal`, async t => {
  const { target, transactionId, intent, native } = await interruptedLegacy(t, foreign);
  await assertRetainedIntent(target, transactionId, intent, 'foreign_intent');
  assert.deepEqual(await nativeState(target.store, native.document!.metadata.id), native);
});

test('a committed unrelated receipt cannot discard the matching native publication intent', async t => {
  const { target, plan, transactionId, stepId, intent } = await interruptedLegacy(t);
  await commitWorkspaceTransaction({ pmRoot: target.workspace, transactionId, author: plan.author, steps: [{ id: stepId, inspect: async () => ({ state: 'applied', result: { owner: 'foreign-receipt' } }), apply: retainForwardWrites, compensate: retainForwardWrites }] });
  await assertRetainedIntent(target, transactionId, intent, 'history');
});

test('legacy whole-plan retirement retains interrupted native writes until their coordinator commits', async t => {
  const { target, plan, transactionId, stepId, native, intent } = await interruptedLegacy(t);
  delete plan.forwardOnly; delete plan.publication;
  await target.store.write(() => savePlan(target.store, plan)); const bytes = await readFile(intent);
  await assert.rejects(pendingImport(new Store(target.options)), error => error instanceof MemoryError && error.code === 'history');
  assert.deepEqual(await readFile(intent), bytes);
  await commitWorkspaceTransaction({ pmRoot: target.workspace, transactionId, author: plan.author, steps: [{ id: stepId, inspect: async () => ({ state: 'applied', result: { owner: 'pm-memory-policy-ownership:1', targets: [{ ...plan.ownership![0], proof: native.proof }] } as unknown as WorkspaceTransactionJsonValue }), apply: retainForwardWrites, compensate: retainForwardWrites }] });
  assert.equal(await pendingImport(new Store(target.options)), undefined);
  await assert.rejects(access(intent), { code: 'ENOENT' }); assert.deepEqual(await nativeState(target.store, native.document!.metadata.id), native);
});

test('a later forward write settles the earlier publication before replacing its intent', async t => {
  const { target, plan, transactionId, native } = await interruptedLegacy(t);
  await target.store.write(() => commitPortableBatch(target.store, plan, plan.transactionId, 'data', plan.mutations, { ...target.options, from: 'agents-md' }));
  assert.equal((await readWorkspaceTransaction(target.workspace, transactionId))?.status, 'committed');
  assert.equal(plan.publication, undefined); assert.deepEqual(await nativeState(target.store, native.document!.metadata.id), native);
});

test('a post-write conflict publishes the completed native step before the whole plan is retired', async t => {
  const { target } = await capturedPublication(t); let publication: Publication | undefined;
  await importDir(join(target.root, 'input'), { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'written') { publication = (await readImportPlan(target.workspace)).publication; throw new MemoryError('conflict', 'Synthetic post-write conflict', 'Retain completed work'); }
  } });
  assert.ok(publication); assert.equal((await readWorkspaceTransaction(target.workspace, `${publication.transactionId}-snapshot`))?.status, 'committed');
  await assert.rejects(access(join(target.workspace, 'runtime', 'memory-policy-import.json')), { code: 'ENOENT' });
});

test('whole-plan deletion cannot bypass a durable publication introduced at its final boundary', async t => {
  const fixture = await capturedPublication(t); const { target, plan } = fixture; let publication: Publication | undefined;
  await assert.rejects(target.store.write(() => applyImport(target.store, plan, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'published') {
      const identity = await importIdentity(target.store, 'later-publication');
      await interruptSnapshot(fixture, identity.transactionId, 'later-step', { memoryRecalls: 1 });
      publication = (await readImportPlan(target.workspace)).publication;
    }
  } })), error => error instanceof MemoryError && error.code === 'history');
  assert.ok(publication); assert.equal((await readWorkspaceTransaction(target.workspace, `${publication.transactionId}-snapshot`))?.status, 'applying');
  assert.deepEqual((await readImportPlan(target.workspace)).publication, publication);
  assert.equal(await pendingImport(new Store(target.options)), undefined);
});

test('an unchanged native generation proves a proposal never wrote and needs no publication receipt', async t => {
  const { target, plan, mutation, before } = await capturedPublication(t);
  plan.publication = { id: mutation.id, transactionId: plan.transactionId, stepId: 'unwritten', message: 'No native write occurred', before: before.proof, proposed: before.proof.hash!, target: plan.ownership![0] };
  await target.store.write(() => savePlan(target.store, plan));
  assert.equal(await pendingImport(new Store(target.options)), undefined);
  assert.equal(await readWorkspaceTransaction(target.workspace, `${plan.transactionId}-snapshot`), undefined);
  assert.deepEqual(await nativeState(target.store, mutation.id), before);
});
