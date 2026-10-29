import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTransactionInterruptedError, getWorkspaceHistoryPath, readHistoryEntries, getHistoryPath, readSettings, locateItem, resolveItemTypeRegistry, getItemAt, serializeItemDocument } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortableImportOptions, PortablePolicyManifest } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { tracker, clonedTracker, withoutGit, assertClosedGraph, editIntent } from './helpers.ts';
import { peerWriter } from './portable-native-peer.ts';

const SEED = 0x1363f013;
/** Build a real SDK source and seeded destination for all forward-only scenarios. */
async function fixture(t: TestContext, create = false, ready = true, linked = false) {
  const source = await tracker(t); const alpha = await remember('Alpha A', { ...source.options, slug: 'alpha', kind: 'project' });
  await remember('Beta A', { ...source.options, slug: 'beta', kind: 'reference', ...(linked ? { links: [alpha.id] } : {}) });
  const path = join(source.root, 'portable'); await exportDir(path, { ...source.options, to: 'agents-md' });
  const target = await tracker(t); if (create && ready) await target.store.register(); if (!create) await importDir(path, { ...target.options, from: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  for (const row of manifest.guidance) await writeFile(join(path, row.path), policyBody(row, `${row.slug} B`));
  return { source, target, path, manifest };
}
/** Bind one immutable native target for the fixed conflict and peer-success cases. */
async function alphaFixture(t: TestContext) { const base = await fixture(t); return { ...base, alpha: (await rows(base.target)).find(row => row.memory_slug === 'alpha')! }; }
/** Inject a completed native edit after planning and before the first item mutation. */
async function importWithPeer(base: Awaited<ReturnType<typeof fixture>>, edit: () => Promise<unknown>) {
  return importDir(base.path, { ...base.target.options, from: 'agents-md', onStep: async step => { if (step === 'intent') await edit(); } });
}
/** Read native rows through the SDK, independently of importer ownership or normalization code. */
async function rows(target: Awaited<ReturnType<typeof tracker>>) { return (await target.client.listAllComplete({ includeBody: true })).items; }
/** Require every actual peer-changed value to survive, ignoring only the SDK's derived write time. */
function peerPreserved(actual: Record<string, unknown>, before: Record<string, unknown>, peer: Record<string, unknown>, label: string): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(peer)])) if (key !== 'updated_at' && !isDeepStrictEqual(before[key], peer[key])) assert.deepEqual(actual[key], peer[key], `${label}: ${key}`);
}

test('A B C publication failure keeps C and retry never invents an independent body edit', async t => {
  const base = await fixture(t); withoutGit(t, base.target.root);
  await importDir(base.path, { ...base.target.options, from: 'agents-md' });
  const row = base.manifest.guidance.find(row => row.slug === 'alpha')!;
  await writeFile(join(base.path, row.path), policyBody(row, 'Alpha C'));
  await assert.rejects(importDir(base.path, { ...base.target.options, from: 'agents-md', onTransition: event => { if (event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Publication observer failed'); } }), error => error instanceof MemoryError && error.code === 'transaction');
  assert.equal((await rows(base.target)).find(row => row.memory_slug === 'alpha')!.body, 'Alpha C');
  const result = await importDir(base.path, { ...base.target.options, from: 'agents-md' });
  assert.equal(result.updated, 0); assert.equal(result.unchanged, 2); assert.ok(!('skipped' in result) || result.skipped.length === 0);
  await writeFile(join(base.path, row.path), policyBody(row, 'Alpha D'));
  assert.equal((await importDir(base.path, { ...base.target.options, from: 'agents-md' })).updated, 1);
});

test('legacy clearDeps intent is discarded without touching a native Task dependency', async t => {
  const { alpha, ...base } = await alphaFixture(t);
  const task = await base.target.client.create({ title: 'Native task outside the portable inventory' });
  await base.target.client.update(alpha.id, { dep: [`id=${task.item.id},kind=depends_on`] });
  await assert.rejects(importDir(base.path, { ...base.target.options, from: 'agents-md', onStep: step => { if (step === 'intent') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const intent = join(base.target.workspace, 'runtime', 'memory-policy-import.json');
  await editIntent(intent, plan => { delete plan.forwardOnly; delete plan.publication; plan.mutations = plan.mutations.map(row => ({ ...row, options: { ...row.options, clearDeps: true } })); return plan; });
  await importDir(base.path, { ...base.target.options, from: 'agents-md' });
  const current = (await base.target.client.get(alpha.id, { full: true })).item;
  assert.equal(current.body, 'alpha B'); assert.ok((current.dependencies ?? []).some(edge => edge.id === task.item.id));
  const audit = await readFile(getWorkspaceHistoryPath(base.target.workspace), 'utf8'); assert.match(audit, /Discarded legacy import intent without restoring values/);
  await assert.rejects(access(intent)); assertClosedGraph(await rows(base.target));
});

test('a conflicted item and its dependent are skipped as a whole with typed field bases', async t => {
  const { alpha, ...base } = await alphaFixture(t); const beta = (await rows(base.target)).find(row => row.memory_slug === 'beta')!;
  base.manifest.guidance.find(row => row.slug === 'beta')!.relationships = [{ slug: 'alpha', kind: 'blocked_by' }];
  await writeFile(join(base.path, POLICY_MANIFEST), JSON.stringify(base.manifest));
  for (const row of base.manifest.guidance) await writeFile(join(base.path, row.path), policyBody(row, `${row.slug} B`));
  const result = await importWithPeer(base, () => base.target.client.update(alpha.id, { body: 'Peer Alpha C' }));
  assert.ok('skipped' in result); assert.equal(result.skipped.length, 2);
  for (const row of result.skipped) { assert.equal(row.conflict?.code, 'import_conflict'); assert.ok(row.conflict!.fields.includes('body')); assert.ok(row.conflict!.base.body); assert.ok(row.conflict!.current.body); assert.ok(row.conflict!.remedy); }
  assert.equal((await base.target.client.get(alpha.id, { full: true })).item.body, 'Peer Alpha C');
  assert.equal((await base.target.client.get(beta.id, { full: true })).item.body, 'Beta A'); assert.equal(result.updated, 0);
  const retry = await importDir(base.path, { ...base.target.options, from: 'agents-md' }); assert.ok('skipped' in retry); assert.equal(retry.skipped.length, 2); assertClosedGraph(await rows(base.target));
});

test('an unchanged portable dependent inherits a runtime import conflict', async t => {
  const { alpha, ...base } = await alphaFixture(t); const beta = (await rows(base.target)).find(row => row.memory_slug === 'beta')!;
  await base.target.client.update(beta.id, { dep: [`id=${alpha.id},kind=related`] });
  const path = join(base.target.root, 'with-native-edge'); await exportDir(path, { ...base.target.options, to: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  const row = manifest.guidance.find(row => row.slug === 'alpha')!; await writeFile(join(path, row.path), policyBody(row, 'Alpha requested B'));
  const result = await importWithPeer({ ...base, path }, () => base.target.client.update(alpha.id, { body: 'Peer C' }));
  assert.ok('skipped' in result); assert.equal(result.skipped.length, 2); assert.equal(result.updated, 0); assert.equal(result.unchanged, 0);
  assert.equal(result.skipped.find(row => row.slug === 'beta')!.conflict!.dependency, alpha.id);
  assert.equal((await base.target.client.get(beta.id, { full: true })).item.body, 'Beta A'); assertClosedGraph(await rows(base.target));
});

/** Observe every real step without borrowing the importer's field or ownership implementation. */
async function importBoundaries(t: TestContext, base: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  const labels: string[] = [];
  await importDir(base.path, { ...(await clonedTracker(t, base.target)).options, from: 'agents-md', onStep: step => { labels.push(step); }, onTransition: event => { labels.push(`${event.transition}:${event.stepId ?? ''}`); } });
  return labels;
}

for (const [create, linked] of [[false, false], [true, false], [true, true]] as const) test(`forward-only ${linked ? 'linked ' : ''}${create ? 'create' : 'update'}: seeded peer operations at every ${linked ? 'linked write' : 'import'} boundary`, { timeout: 7200000 }, async t => {
  const base = await fixture(t, create, true, linked); const seeded = await rows(base.target);
  const task = await base.target.client.create({ title: 'Native dependency keeper' });
  const peer = await peerWriter(t, base.target.root); withoutGit(t, base.target.root);
  const labels = await importBoundaries(t, base);
  const start = linked ? labels.indexOf('intent') : 0; assert.ok(start >= 0);
  const supported = labels.map((label, index) => ({ label, index })).filter(row => row.index >= start);
  let schedules = 0; let random = SEED;
  for (const { label, index: boundary } of supported) for (const operation of linked ? [label === 'prepared:' || label === 'write-guard' ? 4 : random % 5] : [0, 1, 2, 3]) {
    if (process.env.PM_MEMORY_FORWARD_PROGRESS === '1') process.stderr.write(`FORWARD_PROGRESS create=${create} boundary=${boundary}:${label} operation=${operation}\n`);
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0; const seed = random;
    const target = await clonedTracker(t, base.target); let count = 0; const state: { injected: boolean; foreignBeforeEdge?: string; pending?: ReturnType<typeof peer>; captured?: { id: string; before: Record<string, unknown>; after?: Record<string, unknown> } } = { injected: false };
    /** The independent native writer may finish after the guarded item's SDK lock releases. */
    const step = async () => {
      if (state.pending !== undefined && state.captured?.after === undefined) Object.assign(state.captured!, { after: await state.pending!.done as Record<string, unknown> });
      if (count++ !== boundary) return;
      const values = await rows(target); const alpha = values.find(row => row.memory_slug === 'alpha');
      const id = operation === 3 || alpha === undefined ? task.item.id : alpha.id;
      const before = (await target.client.get(id, { full: true })).item; const captured = { id, before }; Object.assign(state, { captured, injected: true });
      const beta = values.find(row => row.memory_slug === 'beta');
      const options = operation === 0 ? { body: `Peer ${seed}`, description: `Peer description ${seed}` } : operation === 1 ? { priority: seed % 2, ...(beta === undefined ? {} : { dep: [`id=${beta.id},kind=related`] }) } : operation === 2 ? { comment: `Peer comment ${seed}` } : operation === 4 ? { memorySource: 'foreign:peer' } : alpha === undefined ? { description: `Native task ${seed}` } : { dep: [`id=${alpha.id},kind=depends_on`] };
      const pending = peer(target.workspace, id, target.options.author, 'memory-policy-copied-prefix', operation === 2 ? 'comment' : 'exact', options); Object.assign(state, { pending }); await pending.started;
      if (label !== 'write-guard' || id !== alpha?.id) {
        Object.assign(captured, { after: await pending.done as Record<string, unknown> });
        if (linked && operation === 4 && alpha !== undefined && !(beta?.dependencies ?? []).some(edge => edge.id === alpha.id)) Object.assign(state, { foreignBeforeEdge: alpha.id });
      }
    };
    const options: PortableImportOptions = { ...target.options, from: 'agents-md', onStep: step, onTransition: step };
    try {
      const imported = await importDir(base.path, options); assert.equal(state.injected, true, `seed=${seed} boundary=${label}`);
      if (state.pending !== undefined) Object.assign(state.captured!, { after: await state.pending.done, before: state.pending.witness.before ?? state.captured!.before });
      const captured = state.captured;
      assert.ok(captured?.after); peerPreserved((await target.client.get(captured.id, { full: true })).item, captured.before, captured.after, `seed=${seed} boundary=${label}`);
      const retry = await importDir(base.path, { ...target.options, from: 'agents-md' });
      peerPreserved((await target.client.get(captured.id, { full: true })).item, captured.before, captured.after, `seed=${seed} retry=${label}`);
      const actual = await rows(target); assertClosedGraph(actual); assert.equal(actual.filter(row => row.memory_slug === 'alpha').length, 1); assert.equal(actual.filter(row => row.memory_slug === 'beta').length, 1);
      if (captured.after.body !== captured.before.body && captured.id !== task.item.id) { assert.ok('skipped' in retry); assert.ok(retry.skipped.some(row => row.conflict?.item === captured!.id)); }
      if (state.foreignBeforeEdge !== undefined) {
        assert.ok(!(actual.find(row => row.memory_slug === 'beta')!.dependencies ?? []).some(edge => edge.id === state.foreignBeforeEdge), 'A fully committed foreign takeover before edge publication must close the plan');
        assert.ok('skipped' in imported); assert.equal(imported.skipped.find(row => row.slug === 'beta')!.conflict!.dependency, state.foreignBeforeEdge);
      }
      if (linked && (!('skipped' in retry) || !retry.skipped.some(row => row.slug === 'beta'))) assert.ok(actual.find(row => row.memory_slug === 'beta')!.dependencies?.some(edge => edge.id === actual.find(row => row.memory_slug === 'alpha')!.id && edge.kind === 'related'));
      if (captured.after.memory_source === 'foreign:peer' && captured.id !== task.item.id) { assert.ok('skipped' in retry); assert.ok(retry.skipped.some(row => row.slug === 'alpha')); }
      const stable = await rows(target); const final = await importDir(base.path, { ...target.options, from: 'agents-md' }); assert.equal(final.updated, 0); assert.deepEqual(await rows(target), stable);
      schedules++;
    } catch (error) { throw new Error(`MASTER_SEED=${SEED} SEQUENCE_SEED=${seed} create=${create} linked=${linked} boundary=${boundary}:${label} operation=${operation}`, { cause: error }); }
  }
  assert.equal(seeded.filter(row => row.memory_slug !== undefined).length, create ? 0 : 2);
  t.diagnostic(`FORWARD_PEERS master_seed=0x${SEED.toString(16)} create=${create} linked=${linked} boundaries=${supported.length} schedules=${schedules} process=independent`);
});

for (const [create, linked] of [[false, false], [true, false], [true, true]] as const) test(`forward-only ${linked ? 'linked ' : ''}${create ? 'create' : 'update'}: crash at every ${linked ? 'linked write ' : ''}boundary then rerun converges`, { timeout: 7200000 }, async t => {
  const base = await fixture(t, create, true, linked); withoutGit(t, base.target.root); const labels = await importBoundaries(t, base);
  const start = linked ? labels.indexOf('intent') : 0; assert.ok(start >= 0);
  for (let boundary = start; boundary < labels.length; boundary++) {
    const target = await clonedTracker(t, base.target); let count = 0;
    const crash = () => { if (count++ === boundary) throw new WorkspaceTransactionInterruptedError(); };
    await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md', onStep: crash, onTransition: crash }), WorkspaceTransactionInterruptedError);
    const partial = await rows(target); assertClosedGraph(partial);
    await importDir(base.path, { ...target.options, from: 'agents-md' });
    const final = await rows(target); assertClosedGraph(final);
    for (const slug of ['alpha', 'beta']) { const matches = final.filter(row => row.memory_slug === slug); assert.equal(matches.length, 1, `${labels[boundary]} ${slug}`); assert.equal(matches[0].body, `${slug} B`); }
    if (linked) assert.ok(final.find(row => row.memory_slug === 'beta')!.dependencies?.some(edge => edge.id === final.find(row => row.memory_slug === 'alpha')!.id && edge.kind === 'related'));
    const counts = await importDir(base.path, { ...target.options, from: 'agents-md' }); assert.equal(counts.updated, 0); assert.deepEqual(await rows(target), final);
    for (const row of partial) assert.ok(final.some(after => after.id === row.id), `never delete ${labels[boundary]}`);
  }
  t.diagnostic(`FORWARD_CRASHES create=${create} linked=${linked} boundaries=${labels.length - start}`);
});

test('a peer completing the exact item input is reported unchanged using SDK changed_fields', async t => {
  const { alpha, ...base } = await alphaFixture(t);
  const result = await importWithPeer(base, () => base.target.client.update(alpha.id, { body: 'alpha B' }));
  assert.equal(result.updated, 1); assert.equal(result.unchanged, 1); assert.equal((await base.target.client.get(alpha.id, { full: true })).item.body, 'alpha B');
  assert.ok(!('skipped' in result) || result.skipped.length === 0);
});

test('a native field ABA between planning and write is a conflict even when the value returns to its base', async t => {
  const { alpha, ...base } = await alphaFixture(t);
  const result = await importWithPeer(base, async () => { await base.target.client.update(alpha.id, { body: 'Peer intermediate C' }); await base.target.client.update(alpha.id, { body: String(alpha.body) }); });
  assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.conflict?.fields.includes('body'))); assert.equal((await base.target.client.get(alpha.id, { full: true })).item.body, alpha.body);
});

test('a foreign native alias created after planning is retained instead of creating duplicate memory slugs', async t => {
  const base = await fixture(t, true); let foreign = '';
  const result = await importDir(base.path, { ...base.target.options, from: 'agents-md', onStep: async step => { if (step === 'intent') { foreign = (await base.target.client.create({ title: 'Foreign task', type: 'Task' })).item.id; await base.target.store.fields(foreign, { slug: 'alpha', source: 'foreign:peer' }); } } });
  assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.slug === 'alpha' && row.conflict?.code === 'import_conflict'));
  const actual = await rows(base.target); assert.equal(actual.filter(row => row.memory_slug === 'alpha').length, 1); assert.equal(actual.find(row => row.memory_slug === 'alpha')!.id, foreign); assertClosedGraph(actual);
});

test('first-time schema and origin setup retains seeded native peer writes at every bootstrap boundary', { timeout: 7200000 }, async t => {
  t.diagnostic(`MASTER_SEED=0x${SEED.toString(16)} bootstrap`);
  const base = await fixture(t, true, false); const task = (await base.target.client.create({ title: 'Native bootstrap task' })).item;
  const other = (await base.target.client.create({ title: 'Native reference task' })).item;
  const peer = await peerWriter(t, base.target.root); withoutGit(t, base.target.root); const labels: string[] = [];
  await importDir(base.path, { ...(await clonedTracker(t, base.target)).options, from: 'agents-md', onStep: step => { if (['validated', 'read'].includes(step) || step.startsWith('schema-') || step.startsWith('origin-')) labels.push(step); } });
  let seed = SEED;
  for (const boundary of labels) {
    if (process.env.PM_MEMORY_FORWARD_PROGRESS === '1') process.stderr.write(`FORWARD_BOOTSTRAP boundary=${boundary} seed=${seed}\n`);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const target = await clonedTracker(t, base.target); let injected = false;
    let witness: ReturnType<typeof peer> | undefined;
    await importDir(base.path, { ...target.options, from: 'agents-md', onStep: async step => {
      if (!injected && step === boundary) { injected = true; witness = peer(target.workspace, task.id, target.options.author, 'memory-policy-copied-prefix', seed % 2 === 0 ? 'exact' : 'comment', seed % 2 === 0 ? { body: `Native ${seed}`, dep: [`id=${other.id},kind=related`] } : { comment: `Native ${seed}` }); await witness.done; }
    } });
    assert.ok(witness, `seed=${seed} bootstrap=${boundary}`); const after = await witness.done as Record<string, unknown>;
    peerPreserved((await target.client.get(task.id, { full: true })).item, witness.witness.before!, after, `seed=${seed} bootstrap=${boundary}`);
    assertClosedGraph(await rows(target)); assert.equal((await importDir(base.path, { ...target.options, from: 'agents-md' })).updated, 0);
  }
  t.diagnostic(`FORWARD_BOOTSTRAP master_seed=0x${SEED.toString(16)} boundaries=${labels.length}`);
});

test('recovery: crash and random native edits at every resumed boundary retain peer values and converge', { timeout: 7200000 }, async t => {
  t.diagnostic(`MASTER_SEED=0x${SEED.toString(16)} recovery`);
  const base = await fixture(t); const task = (await base.target.client.create({ title: 'Native recovery reference' })).item;
  const peer = await peerWriter(t, base.target.root); withoutGit(t, base.target.root);
  /** Each schedule interrupts an actual item write, leaving its durable publication intent. */
  const interrupted = async () => {
    const target = await clonedTracker(t, base.target);
    await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'written') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    return target;
  };
  const probe = await interrupted(); const labels: string[] = [];
  await importDir(base.path, { ...probe.options, from: 'agents-md', onStep: step => { labels.push(step); }, onTransition: event => { labels.push(`${event.transition}:${event.stepId ?? ''}`); } });
  let seed = SEED;
  for (let boundary = 0; boundary < labels.length; boundary++) {
    if (process.env.PM_MEMORY_FORWARD_PROGRESS === '1') process.stderr.write(`FORWARD_RECOVERY boundary=${boundary}:${labels[boundary]} seed=${seed}\n`);
    const target = await interrupted(); let index = 0; let witness: ReturnType<typeof peer> | undefined; let edited = '';
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    /** A guard callback can dispatch a native writer whose commit follows item-lock release. */
    const inject = async () => {
      if (index++ !== boundary) return;
      const alpha = (await rows(target)).find(row => row.memory_slug === 'alpha')!; edited = seed % 4 === 3 ? task.id : alpha.id;
      const mutation = seed % 4 === 0 ? { body: `Recovery peer ${seed}` } : seed % 4 === 1 ? { priority: 1, dep: [`id=${task.id},kind=related`] } : seed % 4 === 2 ? { comment: `Recovery peer ${seed}` } : { dep: [`id=${alpha.id},kind=depends_on`] };
      witness = peer(target.workspace, edited, target.options.author, 'memory-policy-copied-prefix', seed % 4 === 2 ? 'comment' : 'exact', mutation); await witness.started;
      if (labels[boundary] !== 'write-guard') await witness.done;
      throw new WorkspaceTransactionInterruptedError();
    };
    await assert.rejects(importDir(base.path, { ...target.options, from: 'agents-md', onStep: inject, onTransition: inject }), WorkspaceTransactionInterruptedError);
    assert.ok(witness, `seed=${seed} recovery=${labels[boundary]}`); const observed = await witness.done as Record<string, unknown>;
    await importDir(base.path, { ...target.options, from: 'agents-md' });
    peerPreserved((await target.client.get(edited, { full: true })).item, witness.witness.before!, observed, `seed=${seed} recovery=${labels[boundary]}`);
    const final = await rows(target); assertClosedGraph(final); assert.equal(final.filter(row => row.memory_slug === 'alpha').length, 1); assert.equal(final.filter(row => row.memory_slug === 'beta').length, 1);
    assert.equal((await importDir(base.path, { ...target.options, from: 'agents-md' })).updated, 0); assert.deepEqual(await rows(target), final);
  }
  t.diagnostic(`FORWARD_RECOVERY master_seed=0x${SEED.toString(16)} boundaries=${labels.length} peer_and_crash_each=true`);
});

for (const [recovery, raw] of [[false, false], [true, false], [false, true], [true, true]] as const) test(`linked dependency final guard retains foreign ${raw ? 'document' : 'ownership'} in ${recovery ? 'recovery' : 'fresh'} import`, async t => {
  const base = await fixture(t, true, true, true); const peer = await peerWriter(t, base.target.root); withoutGit(t, base.target.root);
  if (recovery) await assert.rejects(importDir(base.path, { ...base.target.options, from: 'agents-md', onStep: step => { if (step === 'nodes') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  let guards = 0; let edited = '';
  const result = await importDir(base.path, { ...base.target.options, from: 'agents-md', onStep: async step => {
    if (step !== 'write-guard' || ++guards !== (recovery ? 1 : 3)) return;
    edited = (await rows(base.target)).find(row => row.memory_slug === 'alpha')!.id;
    if (raw) {
      const settings = await readSettings(base.target.workspace); const located = await locateItem(base.target.workspace, edited, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder); assert.ok(located);
      const entries = await readHistoryEntries(getHistoryPath(base.target.workspace, edited), edited); const { document } = await getItemAt(edited, String(entries.length), { pmRoot: base.target.workspace });
      await writeFile(located.itemPath, serializeItemDocument({ ...document, metadata: { ...document.metadata, memory_source: 'foreign:peer' } }, { format: settings.item_format }));
    } else await peer(base.target.workspace, edited, base.target.options.author, 'memory-policy-copied-prefix', 'exact', { memorySource: 'foreign:peer' }).done;
  } });
  assert.ok(edited); const current = await rows(base.target); const beta = current.find(row => row.memory_slug === 'beta')!;
  assert.equal(current.find(row => row.id === edited)!.memory_source, 'foreign:peer');
  assert.deepEqual(beta.dependencies ?? [], [], 'A refused foreign dependency must not acquire a represented edge');
  assert.ok('skipped' in result); assert.deepEqual(result.skipped.map(row => row.slug).sort(), ['alpha', 'beta']);
  assert.equal(result.skipped.find(row => row.slug === 'beta')!.conflict!.dependency, edited);
  await importDir(base.path, { ...base.target.options, from: 'agents-md' }); assert.deepEqual(await rows(base.target), current); assertClosedGraph(current);
});

for (const field of ['memorySource', 'type'] as const) test(`peer completion never adopts a foreign ${field} as an unchanged item`, async t => {
  const { alpha, ...base } = await alphaFixture(t);
  const result = await importWithPeer(base, () => base.target.client.update(alpha.id, { body: 'alpha B', [field]: field === 'type' ? 'Task' : 'foreign:peer' }));
  assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.conflict?.item === alpha.id));
  const current = (await base.target.client.get(alpha.id, { full: true })).item;
  assert.equal(current.body, 'alpha B'); assert.equal(field === 'type' ? current.type : current.memory_source, field === 'type' ? 'Task' : 'foreign:peer');
});
