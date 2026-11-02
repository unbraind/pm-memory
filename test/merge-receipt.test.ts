import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test, before, after } from 'node:test';
import { consolidate, remember, MemoryError } from '../index.ts';
import { observeTargets, nativeState, commitNativeFields, type NativeProof } from '../src/native-revision.ts';
import { Store } from '../src/store.ts';
import { performMerge } from '../src/merge-receipt.ts';
import { interrupted, mergePair, refuseMerge, atMergeBoundary } from './merge-history-helpers.ts';
import { nativeHost, nativePeer } from './native-host-helpers.ts';
import { clonedTracker, snapshot, tracker } from './helpers.ts';

const mergeBases = new Map<string, Awaited<ReturnType<typeof interrupted>>>();
before(async () => {
  for (const boundary of ['publish', 'cancel', 'finish'] as const) {
    const base = await interrupted({ after: () => {} } as Parameters<typeof tracker>[0], boundary);
    mergeBases.set(boundary, base);
  }
});
after(async () => { for (const base of mergeBases.values()) await rm(base.root, { recursive: true, force: true }); });

/** Every refusal must occur in preview and apply while retaining all durable bytes. */
async function refusedUnchanged(target: Awaited<ReturnType<typeof tracker>>, label: string) {
  const before = await snapshot(target.workspace);
  for (const apply of [false, true]) {
    await assert.rejects(consolidate({ ...target.options, apply }), conflict, `${label} apply=${apply}`);
    assert.deepEqual(await snapshot(target.workspace), before, `${label} apply=${apply}`);
  }
}
const conflict = (error: unknown) => error instanceof MemoryError && error.code === 'conflict';
/** Read both endpoint records for the same independent merge fixture. */
async function readPair(target: Awaited<ReturnType<typeof tracker>>, pair: { source: { id: string }; destination: { id: string } }) {
  return Promise.all([pair.source.id, pair.destination.id].map(async id => (await target.client.get(id, { full: true })).item));
}
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
  const base = mergeBases.get('publish')!;
  const malformed: [string, unknown][] = [['version', 1], ['id', 1], ['id', 'invalid'], ['target_id', 'foreign-id'], ['body', 1], ['author', 1], ['author', ''], ['changed_at', 1], ['changed_at', 'not a canonical instant'], ['changed_at', '2026-02-30T00:00:00.000Z'], ['target_after', 1], ['target_after', 'invalid'], ['source_before', null], ['source_before', { ...(await nativeState(base.store, base.source.id)).proof, length: 0 }], ['target_before', null]];
  for (const [field, value] of malformed) {
    const target = await pending(t, base, receipt => { receipt[field] = value; });
    await refusedUnchanged(target, field);
  }
  for (const mode of ['intent-content', 'cancel-content', 'cancel-early', 'publish-content', 'publish-message', 'hash', 'prefix']) {
    const target = await pending(t, base, receipt => {
      if (mode === 'hash' || mode === 'prefix') receipt.target_before = { ...receipt.target_before as object, [mode === 'hash' ? 'hash' : 'history']: '0'.repeat(64) };
    }, mode);
    await refusedUnchanged(target, mode);
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

test('a refused merge intent retains every target byte and retry publishes one provenance link', async t => {
  const target = await mergePair(t); const { source, destination } = target;
  const before = await snapshot(target.workspace);
  for (let attempt = 0; attempt < 2; attempt++) {
    let denied = 0;
    await refuseMerge(target, context => {
      const after = context.after?.metadata;
      if (after?.id === source.id && after.memory_merge) { denied++; return { allow: false, code: 'test_merge_interrupted', remediation: 'Interrupt the durable intent write' }; }
    });
    assert.equal(denied, 1);
    assert.deepEqual(await snapshot(target.workspace), before, 'A denied intent cannot append an unjournaled preparation or comment');
  }
  await consolidate({ ...target.options, apply: true });
  const finalTarget = (await target.client.get(destination.id, { full: true })).item;
  const finalSource = (await target.client.get(source.id, { full: true })).item;
  assert.equal((finalTarget.dependencies ?? []).filter(edge => edge.id === source.id && edge.kind === 'related').length, 1);
  assert.equal(String(finalTarget.body).split('### Consolidated context (source)').length, 2);
  assert.equal(finalSource.status, 'canceled'); assert.equal(finalSource.memory_merge, '');
});

/** One resumed merge clone; the injected policy edits a merge endpoint at a named finalization hook. */
async function resumeWithPeerEdit(t: Parameters<typeof tracker>[0], base: Awaited<ReturnType<typeof interrupted>>, boundary: 'publish' | 'cancel' | 'finish', edit: (target: Awaited<ReturnType<typeof clonedTracker>>) => void) {
  const target = await clonedTracker(t, base); let injections = 0;
  await refuseMerge(target, context => {
    const match = atMergeBoundary(context, base, boundary);
    if (match) { injections++; edit(target); }
  }, conflict);
  assert.equal(injections, 1, `${boundary} must inject exactly once at the named hook`);
  return target;
}

for (const boundary of ['finish', 'cancel'] as const) test(`a target body restored at the ${boundary} hook keeps the unique rationale in its receipt`, async t => {
  const base = mergeBases.get(boundary)!;
  const version = (await base.client.get(base.destination.id, { full: true })).item.updated_at!;
  const target = await resumeWithPeerEdit(t, base, boundary, clone => { nativePeer({ id: base.destination.id, workspace: clone.workspace, root: clone.root }, version, 'Repeated safe guidance'); });
  const [source, destination] = await readPair(target, base);
  assert.match(String(source.memory_merge), /Unique retained rationale/);
  assert.equal(source.status, boundary === 'finish' ? 'canceled' : 'open');
  assert.equal(destination.body, 'Repeated safe guidance', 'The restored peer body must survive');
  assert.equal(source.memory_why, 'Unique retained rationale', 'The source and its pending receipt must retain the unique rationale');
});

test('a source edit at the publish hook refuses publication and keeps the receipt', async t => {
  const base = mergeBases.get('publish')!;
  const version = (await base.client.get(base.source.id, { full: true })).item.updated_at!;
  const target = await resumeWithPeerEdit(t, base, 'publish', clone => { nativePeer({ id: base.source.id, workspace: clone.workspace, root: clone.root }, version); });
  const [source, destination] = await readPair(target, base);
  assert.notEqual(source.memory_merge, '');
  assert.equal(source.status, 'open');
  assert.equal(destination.body, 'Repeated safe guidance', 'Publication must not certify a source the peer edited');
  assert.equal(source.body, 'Native C', 'The peer edit must be preserved');
});

for (const boundary of ['publish', 'cancel', 'finish'] as const) for (const aba of [false, true]) test(`every certified endpoint refuses ${aba ? 'ABA' : 'edit'} inside the ${boundary} admission hook`, async t => {
  const base = mergeBases.get(boundary)!;
  const endpoint = boundary === 'publish' ? base.source : base.destination;
  const saved = await nativeState(base.store, endpoint.id);
  const pending = (await base.client.get(base.source.id, { full: true })).item.memory_merge;
  const target = await resumeWithPeerEdit(t, base, boundary, clone => {
    nativePeer({ id: endpoint.id, workspace: clone.workspace, root: clone.root }, saved.proof.version!, aba ? saved.document!.body : undefined);
  });
  const after = await nativeState(target.store, endpoint.id);
  assert.equal(after.proof.length, saved.proof.length + (aba ? 2 : 1));
  if (aba) assert.equal(after.proof.hash, saved.proof.hash, 'An identical document hash cannot erase the intervening immutable generation');
  assert.equal(after.document!.body, aba ? saved.document!.body : 'Native C');
  if (boundary === 'publish') assert.equal((await target.client.get(base.destination.id, { full: true })).item.body, (await base.client.get(base.destination.id, { full: true })).item.body, 'A stale source must refuse before publishing the target');
  const source = (await target.client.get(base.source.id, { full: true })).item;
  assert.equal(source.memory_merge, pending, 'Refusal retains the exact pending receipt');
  assert.equal(source.status, boundary === 'finish' ? 'canceled' : 'open');
});

for (const aba of [false, true]) test(`intent admission refuses a target ${aba ? 'ABA' : 'edit'} before publishing any receipt`, async t => {
  const target = await mergePair(t); const { source, destination } = target;
  const saved = await nativeState(target.store, destination.id); let injected = 0;
  await refuseMerge(target, context => {
    if (context.after?.metadata.id === source.id && context.after.metadata.memory_merge) {
      injected++;
      nativePeer({ ...target, id: destination.id }, saved.proof.version!, aba ? saved.document!.body : undefined);
    }
  }, conflict);
  assert.equal(injected, 1);
  const after = await nativeState(target.store, destination.id);
  assert.equal(after.proof.length, saved.proof.length + (aba ? 2 : 1));
  if (aba) assert.equal(after.proof.hash, saved.proof.hash);
  const retained = (await target.client.get(source.id, { full: true })).item;
  assert.equal(retained.memory_merge, undefined); assert.equal(retained.status, 'open');
});

test('a stale certified item refuses the merge write before dispatch and retains the receipt', async t => {
  const base = mergeBases.get('finish')!;
  const target = await clonedTracker(t, base);
  const observed = await observeTargets(target.store, (await target.client.listAllComplete({ includeBody: true })).items);
  await target.client.update(base.destination.id, { body: 'Native C' });
  const dispatch = (proof: NativeProof) => commitNativeFields(target.store, base.source.id, observed.get(base.source.id)!.proof, { memoryWhy: 'Certified write' }, 'Certified merge dispatch', new Map([[base.destination.id, proof]]));
  const edited = await snapshot(target.workspace);
  assert.equal(await dispatch(observed.get(base.destination.id)!.proof), false, 'A stale certified target must refuse before any write is dispatched');
  assert.equal((await target.client.get(base.source.id, { full: true })).item.memory_why, observed.get(base.source.id)!.document!.metadata.memory_why);
  assert.deepEqual(await snapshot(target.workspace), edited);
  assert.equal(await dispatch((await nativeState(target.store, base.destination.id)).proof), true, 'A current certified target admits the write');
  assert.equal((await target.client.get(base.source.id, { full: true })).item.memory_why, 'Certified write');
});

for (const host of [false, true]) for (const aba of [false, true]) test(`certified SDK no-op rechecks the target after ${aba ? 'ABA' : 'edit'} on the ${host ? 'host' : 'default'} path`, async t => {
  const base = mergeBases.get('finish')!; const target = await clonedTracker(t, base);
  const [source, destination] = await Promise.all([base.source.id, base.destination.id].map(id => nativeState(target.store, id))); let injected = 0;
  const fields = { get memoryMerge() {
    injected++; nativePeer({ ...target, id: base.destination.id }, destination.proof.version!, aba ? destination.document!.body : undefined);
    return source.document!.metadata.memory_merge;
  } };
  const run = async (store: Store) => {
    assert.equal(await store.write(() => commitNativeFields(store, base.source.id, source.proof, fields, 'Certify unchanged merge intent', new Map([[base.destination.id, destination.proof]]))), false);
  };
  if (host) await nativeHost(target.workspace, client => run(new Store({ ...target.options, client })));
  else await run(target.store);
  assert.equal(injected, 1);
  assert.deepEqual(await nativeState(target.store, base.source.id), source, 'A rejected no-op leaves the exact source and pending receipt');
});

test('earlier version-2 prepared receipts without author metadata still resume their exact graph', async t => {
  const target = await mergePair(t);
  await target.store.link(target.destination.id, target.source.id);
  await refuseMerge(target, context => {
    if (atMergeBoundary(context, target, 'publish')) return { allow: false, code: 'legacy_receipt_fixture', remediation: 'Retain prepared version-2 input' };
  });
  const legacy = await pending(t, target, receipt => { delete receipt.author; });
  await consolidate({ ...legacy.options, apply: true });
  const [source, destination] = await readPair(legacy, target);
  assert.equal(source.memory_merge, ''); assert.equal(source.status, 'canceled');
  assert.match(String(destination.body), /Unique retained rationale/);
  assert.equal(destination.dependencies!.filter(edge => edge.id === source.id && edge.kind === 'related').length, 1);
});

for (const host of [false, true]) test(`merge provenance retains native environment attribution without an explicit author: ${host ? 'host' : 'default'}`, async t => {
  const target = await mergePair(t); const prior = process.env.PM_AUTHOR; process.env.PM_AUTHOR = 'merge-environment-agent';
  t.after(() => { if (prior === undefined) delete process.env.PM_AUTHOR; else process.env.PM_AUTHOR = prior; });
  const options = { workspace: target.workspace, apply: true };
  if (host) await nativeHost(target.workspace, client => consolidate({ ...options, client }));
  else await consolidate(options);
  const [source, destination] = await readPair(target, target);
  assert.equal(source.status, 'canceled');
  assert.match(String(destination.body), /Unique retained rationale/);
  assert.equal(destination.dependencies!.find(edge => edge.id === source.id)!.author, 'merge-environment-agent');
});
