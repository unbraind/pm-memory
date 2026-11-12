import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { importDir, POLICY_MANIFEST, MemoryError } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { nativeState } from '../src/native-revision.ts';
import { savePlan } from '../src/portable-plan.ts';
import { publishPending } from '../src/portable-write.ts';
import { verifiedSource, exportedPolicy, readImportPlan } from './helpers.ts';
import { nativeHost, nativePeer, nativeFixture } from './native-host-helpers.ts';

import { capturedPublication, applyCaptured } from './portable-publication-helpers.ts';

for (const mode of ['own', 'foreign', 'legacy', 'prefix', 'payload'] as const) test(`portable recovery proves exact publication identity before recording ownership: ${mode}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  const { target, plan, mutation, before } = await capturedPublication(t);
  const message = 'Unique frozen publication step';
  await target.client.run('update', { id: mutation.id, options: { ...mutation.options, message: mode === 'foreign' ? 'Independent native peer' : message } });
  const applied = await nativeState(target.store, mutation.id);
  assert.equal(applied.proof.version, before.proof.version, 'all SDK writes collide in modification time');
  plan.publication = { id: mutation.id, transactionId: plan.transactionId, stepId: 'publication-proof', before: mode === 'prefix' ? { ...before.proof, history: '0'.repeat(64) } : before.proof, proposed: mode === 'payload' ? '0'.repeat(64) : applied.proof.hash!, target: plan.ownership![0], ...(mode === 'legacy' ? {} : { message }) };
  const publication = plan.publication; let transitions = 0; const recoverySteps: string[] = [];
  await target.store.write(async () => {
    await savePlan(target.store, plan);
    const publish = () => publishPending(target.store, plan, { onTransition: () => { transitions++; }, onStep: step => { recoverySteps.push(step); } });
    if (mode === 'own') await publish();
    else await assert.rejects(publish, error => error instanceof MemoryError && error.code === 'history');
  });
  assert.equal(transitions > 0, mode === 'own', 'matching bytes and timestamp cannot authorize a foreign or unproven history step');
  assert.deepEqual(await nativeState(target.store, mutation.id), applied);
  assert.deepEqual(plan.publication, mode === 'own' ? undefined : publication); assert.equal(recoverySteps.includes('recover-recorded'), mode === 'own');
  plan.publication = publication;
  await target.store.write(async () => {
    await savePlan(target.store, plan);
    if (mode === 'own') await publishPending(target.store, plan);
    else await assert.rejects(publishPending(target.store, plan), error => error instanceof MemoryError && error.code === 'history');
  });
  assert.deepEqual(await nativeState(target.store, mutation.id), applied);
});

for (const field of ['why', 'kind'] as const) test(`peer-completed source unsets retain evidence while publishing the remaining artifact: ${field}`, async t => {
  const first = field === 'why' ? '---\nname: alpha\n---\nAlpha A\n**Why:** Prior rationale\n' : '---\nname: alpha\ntype: project\n---\nAlpha A\n';
  const target = await verifiedSource(t, first, 'Native evidence'); const { id, path, old } = target;
  await writeFile(path, '---\nname: alpha\n---\nAlpha A\n');
  const result = await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'intent') await target.client.update(id, { body: 'Alpha A', unset: [`memory_${field}`] });
  } });
  assert.equal(result.updated, 1);
  const item = (await target.client.get(id, { full: true })).item;
  assert.equal(item[`memory_${field}`], undefined);
  assert.deepEqual([item.memory_changed_at, item.memory_verdict, item.memory_verified_at, item.memory_reason], [old, 'verified', old, 'Native evidence']);
});


for (const refusal of ['policy', 'interruption'] as const) test(`revision retry ${refusal} retains completed native content and evidence`, async t => {
  const target = await verifiedSource(t, '---\nname: alpha\n---\nAlpha A', 'Retry policy evidence'); const { id, path, old } = target;
  const saved = await nativeState(target.store, id); await writeFile(path, '---\nname: alpha\n---\nAlpha B');
  let publishing = false; let attempts = 0; let guards = 0;
  await nativeHost(target.workspace, async client => {
    await assert.rejects(importDir(path, { ...target.options, client, from: 'agents-md', onStep: step => {
      if (step === 'intent') { publishing = true; nativePeer({ ...target, id }, saved.proof.version!, 'Alpha B'); }
      if (step === 'write-guard' && ++guards === 2 && refusal === 'interruption') throw new WorkspaceTransactionInterruptedError();
    } }), refusal === 'policy' ? /Portable import interrupted/ : WorkspaceTransactionInterruptedError);
  }, context => {
    if (publishing && context.after?.metadata.id === id && ++attempts === 2 && refusal === 'policy') return { allow: false, code: 'test_retry_policy', remediation: 'Retain completed native evidence' };
  });
  assert.equal(attempts, 2);
  const item = (await target.client.get(id, { full: true })).item;
  assert.equal(item.body, 'Alpha B');
  assert.deepEqual([item.memory_changed_at, item.memory_verdict, item.memory_verified_at, item.memory_reason], [old, 'verified', old, 'Retry policy evidence']);
});


test('revision retry accepts SDK requests without redundant verification unsets', async t => {
  const { target, plan, mutation } = await capturedPublication(t, true);
  await target.client.update(mutation.id, { body: 'Alpha B', title: 'Alpha B' });
  delete mutation.options!.unset;
  await applyCaptured(target, plan);
  const item = (await target.client.get(mutation.id, { full: true })).item;
  assert.equal(item.body, 'Alpha B'); assert.equal(item.title, 'Alpha B');
  assert.equal(item.memory_changed_at, '2020-01-01T00:00:00.000Z');
  assert.equal(item.memory_verified_at, undefined); assert.equal(item.memory_reason, undefined);
  assert.equal(JSON.parse(String(item.memory_document)).original, Buffer.from('Alpha B').toString('base64'));
});


test('SDK-normalized peer completion is a true no-op despite reported raw body hints', async t => {
  const { target, plan, mutation } = await capturedPublication(t, true, 'Alpha B\n');
  await target.client.run('update', { id: mutation.id, options: { body: 'Alpha B', title: 'Alpha B', memoryDocument: mutation.options!.memoryDocument } });
  const peer = await nativeState(target.store, mutation.id);
  await applyCaptured(target, plan);
  assert.equal(plan.outcomes![mutation.id], 'unchanged');
  assert.deepEqual(await nativeState(target.store, mutation.id), peer, 'a normalized no-op cannot append an SDK item write');
});


for (const [field, key, value] of [
  ['title', 'title', 'Native title B'], ['description', 'description', 'Native hook B'],
  ['body', 'body', 'Native body B'], ['kind', 'memory_kind', 'feedback'],
  ['why', 'memory_why', 'Native why B'], ['how', 'memory_how', 'Native how B'],
  ['pinned', 'memory_pinned', true], ['tags', 'tags', ['comma,tag', 'new-tag']],
] as const) test(`every semantic field accepts SDK-normalized peer completion without another item write: ${field}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  const target = await nativeFixture(t); const old = '2020-01-01T00:00:00.000Z';
  await target.store.fields(target.id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Completed native input evidence' });
  const { path, manifest } = await exportedPolicy(target, 'semantic-peer'); const row = manifest.guidance[0];
  if (field !== 'body') Object.assign(row, { [field]: value });
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
  await writeFile(join(path, row.path), policyBody(row, field === 'body' ? `${value}\n` : target.saved.document!.body));
  let peer: Awaited<ReturnType<typeof nativeState>> | undefined;
  const result = await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step !== 'intent') return;
    const request = (await readImportPlan(target.workspace)).mutations.find(mutation => mutation.id === target.id)!;
    const options = { ...request.options };
    for (const derived of ['memoryChangedAt', 'memoryVerdict', 'memoryVerifiedAt', 'memoryReason', 'unset']) delete options[derived];
    await target.client.run('update', { id: target.id, options });
    peer = await nativeState(target.store, target.id);
    assert.equal(peer.proof.version, target.saved.proof.version, 'collide SDK clocks for every semantic field');
    const actual = (await target.client.get(target.id, { full: true })).item;
    assert.deepEqual(actual[key], value, 'the independent native observation must satisfy the literal wire edit');
  } });
  assert.equal(result.updated, 0); assert.equal(result.unchanged, 1);
  assert.deepEqual(await nativeState(target.store, target.id), peer);
});
