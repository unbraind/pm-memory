import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { consolidate, remember, MemoryError } from '../index.ts';
import { observeTargets, nativeState } from '../src/native-revision.ts';
import { performMerge } from '../src/merge-receipt.ts';
import { interrupted } from './merge-history-helpers.ts';
import { clonedTracker, snapshot, tracker } from './helpers.ts';

/** Persist synthetic recovery input through genuine SDK history, never by editing an audit stream. */
async function pending(t: Parameters<typeof tracker>[0], base: Awaited<ReturnType<typeof interrupted>>, change: (receipt: Record<string, unknown>) => void, mode = '') {
  const target = await clonedTracker(t, base);
  const source = base.source; const destination = base.destination;
  const receipt = JSON.parse(String((await target.client.get(source.id, { full: true })).item.memory_merge)) as Record<string, unknown>;
  await target.client.run('update', { id: source.id, options: { memoryMerge: '' } });
  Object.assign(receipt, { id: randomUUID(), source_before: (await nativeState(target.store, source.id)).proof, target_before: (await nativeState(target.store, destination.id)).proof });
  change(receipt);
  await target.client.run('update', { id: source.id, options: { memoryMerge: JSON.stringify(receipt), ...(mode === 'intent-content' ? { title: 'Intervening intent content' } : {}), message: `Memory merge ${receipt.id} intent` } });
  if (mode.startsWith('cancel')) await target.client.run('update', { id: source.id, options: { status: 'canceled', closeReason: 'Synthetic cancellation', ...(mode === 'cancel-content' ? { body: 'Intervening cancel content' } : {}), message: `Memory merge ${receipt.id} cancel` } });
  if (mode.startsWith('publish')) await target.client.run('update', { id: destination.id, options: { body: receipt.body, memoryEdited: true, memoryChangedAt: receipt.changed_at, memoryVerdict: 'unknown', unset: ['memory_verified_at', 'memory_reason'], ...(mode === 'publish-content' ? { title: 'Intervening publication content' } : {}), message: mode === 'publish-message' ? 'Native peer publication' : `Memory merge ${receipt.id} publish` } });
  return target;
}

test('merge receipt input and native generations fail closed before either preview or apply', async t => {
  const base = await interrupted(t, 'publish');
  const malformed: [string, unknown][] = [['version', 1], ['id', 1], ['id', 'invalid'], ['target_id', 'foreign-id'], ['body', 1], ['changed_at', 1], ['source_before', null], ['source_before', { ...(await nativeState(base.store, base.source.id)).proof, length: 0 }], ['target_before', null], ['target_after', 1], ['target_after', 'invalid']];
  for (const [field, value] of malformed) {
    const target = await pending(t, base, receipt => { receipt[field] = value; }); const before = await snapshot(target.workspace);
    for (const apply of [false, true]) { await assert.rejects(consolidate({ ...target.options, apply }), MemoryError); assert.deepEqual(await snapshot(target.workspace), before); }
  }
  for (const mode of ['intent-content', 'cancel-content', 'cancel-early', 'publish-content', 'publish-message', 'hash', 'prefix']) {
    const target = await pending(t, base, receipt => {
      if (mode === 'hash' || mode === 'prefix') receipt.target_before = { ...receipt.target_before as object, [mode === 'hash' ? 'hash' : 'history']: '0'.repeat(64) };
    }, mode);
    const before = await snapshot(target.workspace);
    await assert.rejects(consolidate({ ...target.options, apply: true }), error => error instanceof MemoryError && error.code === 'conflict');
    assert.deepEqual(await snapshot(target.workspace), before);
  }
});

test('merge admission refuses incomplete observations and stale native generations', async t => {
  const target = await tracker(t);
  const source = await remember('Repeated merge admission', { ...target.options, kind: 'reference', slug: 'source' });
  const destination = await remember('Repeated merge admission', { ...target.options, kind: 'reference', slug: 'target', forceNew: true });
  const corpus = (await target.client.listAllComplete({ includeBody: true })).items;
  const observed = await observeTargets(target.store, corpus); const memories = await target.store.read(corpus); const original = memories.find(item => item.id === source.id)!;
  await performMerge(target.store, original, memories, observed, false);
  await assert.rejects(performMerge(target.store, original, memories, observed, true, 'missing'), MemoryError);
  for (const id of [source.id, destination.id]) { const partial = new Map(observed); partial.delete(id); await assert.rejects(performMerge(target.store, original, memories, partial, true, 'target'), MemoryError); }
  await target.client.update(destination.id, { body: 'Native C' });
  await assert.rejects(target.store.write(() => performMerge(target.store, original, memories, observed, true, 'target')), MemoryError);
  assert.equal((await target.client.get(destination.id, { full: true })).item.body, 'Native C');
});
