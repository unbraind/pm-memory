import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { consolidate, remember, MemoryError } from '../index.ts';
import { observeTargets, nativeState, commitNativeFields } from '../src/native-revision.ts';
import { performMerge } from '../src/merge-receipt.ts';
import { interrupted } from './merge-history-helpers.ts';
import { nativeHost, nativePeer } from './native-host-helpers.ts';
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
  const malformed: [string, unknown][] = [['version', 1], ['id', 1], ['id', 'invalid'], ['target_id', 'foreign-id'], ['body', 1], ['changed_at', 1], ['changed_at', 'not a canonical instant'], ['target_after', 1], ['target_after', 'invalid'], ['source_before', null], ['source_before', { ...(await nativeState(base.store, base.source.id)).proof, length: 0 }], ['target_before', null]];
  for (const [field, value] of malformed) {
    const target = await pending(t, base, receipt => { receipt[field] = value; }); const before = await snapshot(target.workspace);
    for (const apply of [false, true]) { await assert.rejects(consolidate({ ...target.options, apply }), error => error instanceof MemoryError && error.code === 'conflict', `${field} apply=${apply}`); assert.deepEqual(await snapshot(target.workspace), before, `${field} apply=${apply}`); }
  }
  for (const mode of ['intent-content', 'cancel-content', 'cancel-early', 'publish-content', 'publish-message', 'hash', 'prefix']) {
    const target = await pending(t, base, receipt => {
      if (mode === 'hash' || mode === 'prefix') receipt.target_before = { ...receipt.target_before as object, [mode === 'hash' ? 'hash' : 'history']: '0'.repeat(64) };
    }, mode);
    const before = await snapshot(target.workspace);
    for (const apply of [false, true]) {
      await assert.rejects(consolidate({ ...target.options, apply }), error => error instanceof MemoryError && error.code === 'conflict', `${mode} apply=${apply}`);
      assert.deepEqual(await snapshot(target.workspace), before, `${mode} apply=${apply}`);
    }
  }
});

test('merge admission refuses incomplete observations and stale native generations', async t => {
  const target = await tracker(t);
  const source = await remember('Repeated merge admission', { ...target.options, kind: 'reference', slug: 'source' });
  const destination = await remember('Repeated merge admission', { ...target.options, kind: 'reference', slug: 'target', forceNew: true });
  const corpus = (await target.client.listAllComplete({ includeBody: true })).items;
  const observed = await observeTargets(target.store, corpus); const memories = await target.store.read(corpus); const original = memories.find(item => item.id === source.id)!;
  await performMerge(target.store, original, memories, observed, false);
  await assert.rejects(performMerge(target.store, original, memories, observed, true, 'missing'), error => error instanceof MemoryError && error.code === 'conflict');
  for (const id of [source.id, destination.id]) { const partial = new Map(observed); partial.delete(id); await assert.rejects(performMerge(target.store, original, memories, partial, true, 'target'), error => error instanceof MemoryError && error.code === 'conflict', `missing observation for ${id}`); }
  // A native edit that restores the observed body still moves immutable history and must refuse.
  const native = (await target.client.get(destination.id, { full: true })).item.body;
  await target.client.update(destination.id, { body: 'Native C' });
  await target.client.update(destination.id, { body: native });
  await assert.rejects(target.store.write(() => performMerge(target.store, original, memories, observed, true, 'target')), error => error instanceof MemoryError && error.code === 'conflict');
  assert.equal((await target.client.get(destination.id, { full: true })).item.body, native);
});

/** One resumed merge clone; the injected policy edits a merge endpoint at a named finalization hook. */
async function resumeWithPeerEdit(t: Parameters<typeof tracker>[0], base: Awaited<ReturnType<typeof interrupted>>, boundary: 'publish' | 'cancel' | 'finish', edit: (target: Awaited<ReturnType<typeof clonedTracker>>) => void) {
  const target = await clonedTracker(t, base); const destination = base.destination; const source = base.source;
  await nativeHost(target.workspace, async client => {
    await assert.rejects(consolidate({ ...target.options, client, apply: true }), error => error instanceof MemoryError && error.code === 'conflict', `${boundary} peer edit must refuse the merge`);
  }, context => {
    const before = context.before?.metadata; const after = context.after?.metadata;
    const match = boundary === 'publish' ? after?.id === destination.id && context.after!.body.includes('### Consolidated context')
      : boundary === 'cancel' ? after?.id === source.id && before?.status !== 'canceled' && after.status === 'canceled'
        : after?.id === source.id && before?.memory_merge !== '' && after.memory_merge === '';
    if (match) edit(target);
  });
  return target;
}

test('a target body restored at the finish hook refuses finalization and keeps the receipt', async t => {
  const base = await interrupted(t, 'finish');
  const version = (await base.client.get(base.destination.id, { full: true })).item.updated_at!;
  const target = await resumeWithPeerEdit(t, base, 'finish', clone => { nativePeer({ id: base.destination.id, workspace: clone.workspace, root: clone.root }, version, 'Repeated safe guidance'); });
  const source = (await target.client.get(base.source.id, { full: true })).item; const destination = (await target.client.get(base.destination.id, { full: true })).item;
  assert.notEqual(source.memory_merge, '', 'The receipt must survive the refused finalization');
  assert.equal(source.status, 'canceled');
  assert.equal(destination.body, 'Repeated safe guidance', 'The restored peer body must be retained, not overwritten with the frozen merged payload');
});

test('a target body restored at the cancel hook refuses cancellation and keeps the receipt', async t => {
  const base = await interrupted(t, 'cancel');
  const version = (await base.client.get(base.destination.id, { full: true })).item.updated_at!;
  const target = await resumeWithPeerEdit(t, base, 'cancel', clone => { nativePeer({ id: base.destination.id, workspace: clone.workspace, root: clone.root }, version, 'Repeated safe guidance'); });
  const source = (await target.client.get(base.source.id, { full: true })).item; const destination = (await target.client.get(base.destination.id, { full: true })).item;
  assert.notEqual(source.memory_merge, '');
  assert.equal(source.status, 'open', 'Cancellation must not certify a target the operator restored');
  assert.equal(destination.body, 'Repeated safe guidance');
});

test('a source edit at the publish hook refuses publication and keeps the receipt', async t => {
  const base = await interrupted(t, 'publish');
  const version = (await base.client.get(base.source.id, { full: true })).item.updated_at!;
  const target = await resumeWithPeerEdit(t, base, 'publish', clone => { nativePeer({ id: base.source.id, workspace: clone.workspace, root: clone.root }, version); });
  const source = (await target.client.get(base.source.id, { full: true })).item; const destination = (await target.client.get(base.destination.id, { full: true })).item;
  assert.notEqual(source.memory_merge, '');
  assert.equal(source.status, 'open');
  assert.equal(destination.body, 'Repeated safe guidance', 'Publication must not certify a source the peer edited');
  assert.equal(source.body, 'Native C', 'The peer edit must be preserved');
});

test('a stale certified item refuses the merge write before dispatch and retains the receipt', async t => {
  const base = await interrupted(t, 'finish');
  const target = await clonedTracker(t, base);
  const observed = await observeTargets(target.store, (await target.client.listAllComplete({ includeBody: true })).items);
  await target.client.update(base.destination.id, { body: 'Native C' });
  const edited = await snapshot(target.workspace);
  assert.equal(await commitNativeFields(target.store, base.source.id, observed.get(base.source.id)!.proof, { memoryWhy: 'Certified write' }, 'Certified merge dispatch', new Map([[base.destination.id, observed.get(base.destination.id)!.proof]])), false, 'A stale certified target must refuse before any write is dispatched');
  assert.equal((await target.client.get(base.source.id, { full: true })).item.memory_why, '');
  assert.deepEqual(await snapshot(target.workspace), edited);
  assert.equal(await commitNativeFields(target.store, base.source.id, observed.get(base.source.id)!.proof, { memoryWhy: 'Certified write' }, 'Certified merge dispatch', new Map([[base.destination.id, (await nativeState(target.store, base.destination.id)).proof]])), true, 'A current certified target admits the write');
  assert.equal((await target.client.get(base.source.id, { full: true })).item.memory_why, 'Certified write');
});
