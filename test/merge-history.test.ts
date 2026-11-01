import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidate, MemoryError } from '../index.ts';
import { nativeState } from '../src/native-revision.ts';
import { nativePeer } from './native-host-helpers.ts';
import { snapshot } from './helpers.ts';
import { interrupted } from './merge-history-helpers.ts';


for (const boundary of ['publish', 'cancel', 'finish'] as const) test(`immutable merge history resumes only its own ${boundary} boundary`, async t => {
  const target = await interrupted(t, boundary);
  const preview = await consolidate(target.options); assert.equal(preview.proposals.length, 1);
  await consolidate({ ...target.options, apply: true });
  const result = (await target.client.get(target.destination.id, { full: true })).item;
  assert.equal(String(result.body).split('### Consolidated context').length, 2);
  const source = (await target.client.get(target.source.id, { full: true })).item;
  assert.equal(source.status, 'canceled'); assert.equal(source.memory_merge, '');
  const stable = await snapshot(target.workspace);
  await consolidate({ ...target.options, apply: true }); assert.deepEqual(await snapshot(target.workspace), stable);
});

for (const endpoint of ['source', 'destination'] as const) for (const boundary of ['publish', 'cancel', 'finish'] as const) test(`immutable merge history refuses same-timestamp ${endpoint} ABA at ${boundary}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  const target = await interrupted(t, boundary); const item = target[endpoint];
  const before = await nativeState(target.store, item.id);
  nativePeer({ ...target, id: item.id }, before.proof.version!, before.document!.body);
  const after = await nativeState(target.store, item.id);
  assert.equal(after.proof.hash, before.proof.hash); assert.equal(after.proof.length, before.proof.length + 2);
  const stable = await snapshot(target.workspace);
  for (const apply of [false, true]) {
    await assert.rejects(consolidate({ ...target.options, apply }), error => error instanceof MemoryError && error.code === 'conflict');
    assert.deepEqual(await snapshot(target.workspace), stable);
  }
});
