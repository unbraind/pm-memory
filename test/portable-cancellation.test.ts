import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { getHistoryPath, readHistoryEntries, readSettings, resolveRuntimeStatusRegistry, resolveTransactionSchema, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import type { PortableImportOptions } from '../index.ts';
import { importDir, MemoryError, get, recall, exportDir, renew } from '../index.ts';
import { pendingImport } from '../src/portable-plan.ts';
import { rollbackImport } from '../src/portable-rollback.ts';
import { peerWriter } from './portable-native-peer.ts';
import { tracker, clonedTracker, assertClosedGraph, withoutGit } from './helpers.ts';

/** Freeze actual SDK writes before publication, retaining both data and exact write receipts. */
async function fixture(t: TestContext, mode: 'create' | 'update') {
  const target = await tracker(t); const path = join(target.root, 'guidance'); await mkdir(path);
  await writeFile(join(path, 'alpha.md'), '---\ndescription: Alpha description A\n---\nAlpha A');
  await writeFile(join(path, 'beta.md'), 'Beta A\n[[alpha]]');
  const task = (await target.client.create({ title: 'Native task' })).item.id;
  if (mode === 'update') {
    await importDir(path, { ...target.options, from: 'agents-md' });
    await writeFile(join(path, 'alpha.md'), '---\ndescription: Alpha description B\n---\nAlpha B');
  }
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'readback') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const plan = await pendingImport(target.store); assert.ok(plan && plan !== 'foreign');
  const rows = (await target.client.listAllComplete({ includeBody: true })).items;
  const alpha = rows.find(row => row.memory_slug === 'alpha')!; const beta = rows.find(row => row.memory_slug === 'beta')!;
  return { target, plan, alpha, beta, task, path };
}
/** Apply the real rollback and read the alpha result through the same SDK get projection. */
async function rolledBack(base: Awaited<ReturnType<typeof fixture>>) {
  await base.target.store.write(() => rollbackImport(base.target.store, base.plan, { ...base.target.options, from: 'agents-md' }));
  return (await base.target.client.get(base.alpha.id, { full: true })).item;
}

/** Observe the exact real rollback path; callbacks add diagnostics, never alternate mutation logic. */
function observe(options: PortableImportOptions, visit: (label: string) => Promise<void>): PortableImportOptions {
  return { ...options, onStep: step => visit(step), onTransition: event => visit(`${event.transition}:${event.stepId ?? ''}`) };
}

/** Discover the actual journal and native mutation boundaries once for each immutable fixture. */
async function rollbackBoundaries(t: TestContext, base: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  const labels: string[] = []; const projection = await clonedTracker(t, base.target);
  await projection.store.write(() => rollbackImport(projection.store, structuredClone(base.plan), observe({ ...projection.options, from: 'agents-md' }, async label => { labels.push(label); })));
  return labels;
}

for (const mode of ['create', 'update'] as const) test(`rollback ${mode}: incoming native dependencies survive every observed boundary`, { timeout: 1200000 }, async t => {
  const base = await fixture(t, mode); const peer = await peerWriter(t, base.target.root); withoutGit(t, base.target.root);
  const boundaries = await rollbackBoundaries(t, base);
  assert.ok(boundaries.includes('rollback-apply'));
  for (let boundary = 0; boundary < boundaries.length; boundary++) {
    const target = await clonedTracker(t, base.target); const plan = structuredClone(base.plan); let at = 0; let injected = false;
    await target.store.write(() => rollbackImport(target.store, plan, observe({ ...target.options, from: 'agents-md' }, async () => {
      if (at++ !== boundary) return; injected = true;
      await peer(target.workspace, base.task, plan.author, plan.transactionId, 'exact', { dep: [`id=${base.alpha.id},kind=depends_on`, `id=${base.beta.id},kind=related`] }).done;
    })));
    assert.ok(injected, `boundary=${boundary} ${boundaries[boundary]}`);
    const rows = (await target.client.listAllComplete({ includeBody: true })).items;
    assertClosedGraph(rows); assert.equal(rows.length, 3);
    assert.deepEqual(rows.find(row => row.id === base.task)!.dependencies!.map(edge => edge.id).sort(), [base.alpha.id, base.beta.id].sort());
    if (mode === 'create') {
      const canceled = resolveRuntimeStatusRegistry((await readSettings(target.workspace)).schema).canceled_status;
      for (const id of [base.alpha.id, base.beta.id]) {
        const row = rows.find(row => row.id === id)!; assert.equal(row.status, canceled);
        assert.match(String(row.close_reason), new RegExp(plan.invocationId!));
        assert.ok(!(await readHistoryEntries(getHistoryPath(target.workspace, id), id)).some(entry => entry.op === 'delete'));
      }
      assert.deepEqual(rows.find(row => row.id === base.beta.id)!.dependencies, base.beta.dependencies);
    }
  }
  t.diagnostic(`INCOMING_REFERENCES mode=${mode} boundaries=${boundaries.length} second_process=true`);
});

for (const mode of ['create', 'update'] as const) test(`rollback ${mode}: random peer fields relationships and comments survive every boundary`, { timeout: 1200000 }, async t => {
  const master = 0x1363ca77; let seed = master + (mode === 'update' ? 1 : 0);
  /** Independent seeded proposals, with no call to importer normalization or ownership helpers. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const base = await fixture(t, mode); const peer = await peerWriter(t, base.target.root); withoutGit(t, base.target.root);
  const boundaries = await rollbackBoundaries(t, base);
  let schedules = 0;
  for (let boundary = 0; boundary < boundaries.length; boundary++) for (const shape of ['body', 'fields', 'relationships', 'comments', 'assigned', 'source', 'type', 'reason'] as const) {
    const caseSeed = seed; const target = await clonedTracker(t, base.target); const plan = structuredClone(base.plan); let at = 0;
    const race: { pending?: ReturnType<typeof peer>; captured?: unknown } = {}; let injected = false;
    const value = `Peer value ${random()} Ω`; const priority = random() % 4 + 1;
    const native = shape === 'reason' ? { closeReason: `Peer rationale ${random()}` } : shape === 'source' ? { memorySource: `foreign:${random()}` } : shape === 'type' ? { type: 'Task' } : shape === 'body' ? { body: value } : shape === 'fields' ? { body: value, title: `Title ${random()}`, description: `Description ${random()}`, priority, tags: `peer-${random()}` } : shape === 'relationships' ? { dep: [`id=${base.task},kind=related`] } : shape === 'assigned' ? { assignee: `peer-${random()}` } : { comment: value };
    /** Start under a native item hook, then await completion after its SDK transition. */
    const visit = async (label: string) => {
      if (race.pending !== undefined && race.captured === undefined && label !== 'write-guard') Object.assign(race, { captured: await race.pending.done });
      if (at++ !== boundary) return; injected = true;
      Object.assign(race, { pending: peer(target.workspace, base.alpha.id, plan.author, plan.transactionId, shape === 'comments' ? 'comment' : 'exact', native) });
      await race.pending!.started; if (label !== 'write-guard') Object.assign(race, { captured: await race.pending!.done });
    };
    try {
      await target.store.write(() => rollbackImport(target.store, plan, observe({ ...target.options, from: 'agents-md' }, visit)));
      if (race.pending !== undefined) Object.assign(race, { captured: await race.pending.done });
      assert.ok(injected, 'The competing OS process ran'); assert.ok(race.captured);
      const rows = (await target.client.listAllComplete({ includeBody: true })).items; assertClosedGraph(rows);
      const now = rows.find(row => row.id === base.alpha.id)!; const expected = race.captured as typeof now;
      for (const field of shape === 'reason' ? ['close_reason'] : shape === 'source' ? ['memory_source', 'body', 'description'] : shape === 'type' ? ['type', 'body', 'description'] : shape === 'body' ? ['body'] : shape === 'fields' ? ['body', 'title', 'description', 'priority', 'tags'] : shape === 'relationships' ? ['dependencies'] : shape === 'assigned' ? ['assignee'] : ['comments']) assert.deepEqual(now[field], expected[field], `peer field ${field}`);
      if (mode === 'create') {
        assert.ok(now.status === 'canceled' || now.status === expected.status, 'Every owned birth is canceled or left untouched');
        assert.deepEqual(rows.find(row => row.id === base.beta.id)!.dependencies, base.beta.dependencies);
      } else {
        if (!['fields', 'source', 'type'].includes(shape)) assert.equal(now.description, 'Alpha description A', 'Unedited import-written fields are restored independently of a peer edit');
        if (!['fields', 'body', 'source', 'type'].includes(shape)) assert.equal(now.body, 'Alpha A');
      }
      await target.store.write(() => rollbackImport(target.store, plan, { ...target.options, from: 'agents-md' }));
      const repeated = (await target.client.get(base.alpha.id, { full: true })).item;
      for (const field of Object.keys(native).filter(key => ['body', 'title', 'description', 'priority', 'assignee'].includes(key))) assert.deepEqual(repeated[field], expected[field], `retry peer field ${field}`);
      schedules++;
    } catch (error) { throw new Error(`ROLLBACK_MODEL master=0x${master.toString(16)} seed=${caseSeed} mode=${mode} boundary=${boundary} label=${boundaries[boundary]} shape=${shape}`, { cause: error }); }
  }
  t.diagnostic(`ROLLBACK_MODEL master=0x${master.toString(16)} mode=${mode} schedules=${schedules} boundaries=${boundaries.length} second_process=true`);
});

test('refused creation cancels rather than deleting when a native Task references it at rollback-apply', async t => {
  const target = await tracker(t); const file = join(target.root, 'alpha.md'); await writeFile(file, 'Alpha');
  const task = (await target.client.create({ title: 'Native dependent' })).item.id; let alpha = ''; let injected = false;
  const peer = await peerWriter(t, target.root);
  await assert.rejects(importDir(file, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step !== 'rollback-apply' || injected) return; injected = true;
    alpha = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!.id;
    await peer(target.workspace, task, target.options.author, 'same-prefix', 'exact', { dep: [`id=${alpha},kind=depends_on`] }).done;
  }, onTransition: event => { if (event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Refuse publication'); } }), MemoryError);
  assert.ok(injected); const rows = (await target.client.listAllComplete()).items; assertClosedGraph(rows);
  assert.equal(rows.find(row => row.id === alpha)!.status, 'canceled'); assert.equal(rows.find(row => row.id === task)!.dependencies![0].id, alpha);
});

// A peer body edit does not grant it ownership over the description this import wrote.
test('field-local rollback restores untouched description while preserving peer body edge and comment', async t => {
  const base = await fixture(t, 'update'); const peer = await peerWriter(t, base.target.root);
  await peer(base.target.workspace, base.alpha.id, base.plan.author, base.plan.transactionId, 'exact', { body: 'Peer C body', dep: [`id=${base.task},kind=related`] }).done;
  const before = await peer(base.target.workspace, base.alpha.id, base.plan.author, base.plan.transactionId, 'comment', { comment: 'Peer C comment' }).done;
  const after = await rolledBack(base);
  assert.equal(after.body, 'Peer C body'); assert.equal(after.description, 'Alpha description A');
  assert.deepEqual(after.dependencies, (before as typeof after).dependencies); assert.deepEqual(after.comments, (before as typeof after).comments);
  assert.ok(base.plan.result.skipped.some(row => row.slug === 'alpha' && row.reason.includes('body')));
  assertClosedGraph((await base.target.client.listAllComplete()).items);
});

test('cancellation resolves the configured SDK canceled role and retains that identity on retry', async t => {
  const base = await fixture(t, 'create');
  await base.target.client.schemaRemapStatus('canceled', 'discarded', {});
  const schema = await resolveTransactionSchema(base.target.workspace, await readSettings(base.target.workspace));
  assert.equal(resolveRuntimeStatusRegistry(schema.schema).canceled_status, 'discarded', 'The SDK workflow resolves the configured role before rollback');
  await base.target.store.write(() => rollbackImport(base.target.store, base.plan, { ...base.target.options, from: 'agents-md' }));
  for (const id of [base.alpha.id, base.beta.id]) assert.equal((await base.target.client.get(id, { full: true })).item.status, 'discarded');
  await base.target.store.write(() => rollbackImport(base.target.store, base.plan, { ...base.target.options, from: 'agents-md' }));
  assert.equal((await base.target.store.read()).find(row => row.slug === 'alpha')!.canceled, true);
  await assert.rejects(get('alpha', base.target.options), error => error instanceof MemoryError && error.code === 'missing');
  assert.equal((await recall('Alpha', base.target.options)).memories!.length, 0);
  assert.equal((await exportDir(join(base.target.root, 'canceled-export'), { ...base.target.options, to: 'agents-md' })).exported, 2);
  await assert.rejects(renew('alpha', { ...base.target.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Canceled guidance is inactive' }), MemoryError);
  assert.equal((await base.target.client.listAllComplete()).items.length, 3);
  for (const id of [base.alpha.id, base.beta.id]) assert.equal((await readHistoryEntries(getHistoryPath(base.target.workspace, id), id)).filter(row => row.op === 'create').length, 1);

});

test('rollback preserves assigned peer state when SDK cancellation would clear it', async t => {
  const base = await fixture(t, 'create'); const peer = await peerWriter(t, base.target.root);
  const before = await peer(base.target.workspace, base.alpha.id, base.plan.author, base.plan.transactionId, 'exact', { assignee: 'peer-native' }).done;
  assert.equal((before as { assignee: string }).assignee, 'peer-native');
  assert.deepEqual(await rolledBack(base), before);
  assert.ok(base.plan.result.skipped.some(row => row.slug === 'alpha' && row.reason.includes('assignee')));
  assertClosedGraph((await base.target.client.listAllComplete()).items);
});

for (const mode of ['create', 'update'] as const) test(`rollback ${mode}: continuously moving peers are retained without forcing compensation`, { timeout: 120000 }, async t => {
  const base = await fixture(t, mode); const peer = await peerWriter(t, base.target.root); let writes = 0; let last: unknown;
  await base.target.store.write(() => rollbackImport(base.target.store, base.plan, { ...base.target.options, from: 'agents-md', onStep: async step => {
    if (!['rollback-apply', 'rollback-ready'].includes(step)) return;
    last = await peer(base.target.workspace, base.alpha.id, base.plan.author, base.plan.transactionId, 'exact', { body: `Peer moving value ${++writes}` }).done;
  } }));
  assert.ok(writes >= 2, 'The peer keeps changing the real target through compensation retries');
  assert.deepEqual((await base.target.client.get(base.alpha.id, { full: true })).item, last);
  const rows = (await base.target.client.listAllComplete()).items; assert.equal(rows.length, 3); assertClosedGraph(rows);
  assert.ok(base.plan.result.skipped.some(row => row.slug === 'alpha' && row.reason.includes('moved during rollback')));
  if (mode === 'update') assert.ok(base.plan.result.skipped.some(row => row.slug === 'alpha' && row.reason.includes('body')));
  assert.ok(rows.every(row => row.status === 'open' || row.status === 'canceled'));
});

test('unverifiable planned births retain every native record and report cancellation refusal', async t => {
  const base = await fixture(t, 'create'); const before = (await base.target.client.listAllComplete({ includeBody: true })).items;
  for (const birth of base.plan.births!) birth.document = 'Foreign birth evidence';
  await rolledBack(base);
  assert.deepEqual((await base.target.client.listAllComplete({ includeBody: true })).items, before);
  assert.ok(base.plan.result.skipped.filter(row => row.reason.includes('creation')).length >= 2);
});

test('update rollback preserves existing native terminal evidence', async t => {
  const base = await fixture(t, 'update');
  const before = await base.target.client.update(base.alpha.id, { status: 'canceled', closeReason: 'Native terminal evidence', completedAt: '2026-02-01T00:00:00.000Z' });
  const after = await rolledBack(base);
  assert.equal(after.status, before.item.status); assert.equal(after.close_reason, before.item.close_reason); assert.equal(after.completed_at, before.item.completed_at);
  assert.equal(after.body, 'Alpha A'); assert.equal(after.description, 'Alpha description A');
  assertClosedGraph((await base.target.client.listAllComplete()).items);
});
