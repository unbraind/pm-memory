import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { restore, WorkspaceTransactionInterruptedError, getItemPath, serializeItemDocument, canonicalDocument, type WorkspaceTransactionTransitionContext } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, renew, MemoryError, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { policyBody, skipOccupiedIdentities } from '../src/portable.ts';
import { replanNodes } from '../src/portable-replan.ts';
import { digest } from '../src/core.ts';
import { guardedCompensation, ownsLatest } from '../src/portable-rollback.ts';
import { importIdentity, validateImportPlan, type ImportPlan } from '../src/portable-plan.ts';
import { tracker, memoryDocuments, assertClosedGraph, crashAfterCompensation, crashAtStep } from './helpers.ts';

/** A real two-target import plus a bounded unchanged read-set dependency. */
async function rollbackScenario(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t); const target = await tracker(t);
  await remember('Alpha A', { ...source.options, slug: 'alpha', kind: 'project' });
  await remember('Beta A', { ...source.options, slug: 'beta', kind: 'reference' });
  await remember('Policy A', { ...source.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...source.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Rollback scenario' });
  const path = join(source.root, 'rollback-export'); await exportDir(path, { ...source.options, to: 'agents-md' });
  await importDir(path, { ...target.options, from: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  for (const row of manifest.guidance.filter(row => row.slug !== 'policy')) await writeFile(join(path, row.path), policyBody(row, `${row.slug} B`));
  const items = (await target.client.listAllComplete({ includeBody: true })).items;
  return { source, target, path, items, intent: join(target.workspace, 'runtime', 'memory-policy-import.json') };
}
/** Pause a real revision plan before any SDK mutation starts. */
async function pausedScenario(t: Parameters<typeof tracker>[0]) {
  const scenario = await rollbackScenario(t);
  await assert.rejects(importDir(scenario.path, { ...scenario.target.options, from: 'agents-md', onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
  const plan = JSON.parse(JSON.parse(await readFile(scenario.intent, 'utf8')).payload) as ImportPlan;
  return { ...scenario, plan };
}
/** Start ordinary compensation, then inject its chosen rollback failure. */
function refusalFault(transition: WorkspaceTransactionTransitionContext['transition'], error: Error): (event: WorkspaceTransactionTransitionContext) => void {
  return event => {
    if (event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Refuse provenance publication');
    if (event.transactionId.endsWith('-rollback') && event.transition === transition) throw error;
  };
}
/** A peer's intent bytes must survive with a truthful refusal receipt. */
async function assertForeignIntent(result: Awaited<ReturnType<typeof importDir>>, injected: boolean, intent: string, foreign: string): Promise<void> {
  assert.equal(injected, true); assert.ok('skipped' in result); assert.match(result.skipped[0].reason, /Foreign pending/);
  assert.equal(await readFile(intent, 'utf8'), foreign);
}

test('SDK compensation guards evaluate ownership inside the restore item lock', async t => {
  const { target, items, plan } = await pausedScenario(t);
  const alpha = items.find(row => row.memory_slug === 'alpha')!;
  await target.client.update(alpha.id, { body: 'Peer C owns this target', author: 'peer-agent' });
  await assert.rejects(guardedCompensation(target.store, plan, () => restore(alpha.id, alpha.updated_at, { author: plan.author, force: true }, { pmRoot: target.workspace })));
  assert.equal((await target.client.get(alpha.id, { full: true })).item.body, 'Peer C owns this target');
  assert.equal(await ownsLatest(target.store, plan, 'memory-test-absent'), false);
  const other = await target.client.create({ title: 'Unrelated native record', body: 'Native A' });
  await target.client.update(other.item.id, { body: 'Native B' });
  await guardedCompensation(target.store, plan, () => restore(other.item.id, other.item.updated_at, { author: plan.author, force: true }, { pmRoot: target.workspace }));
  assert.equal((await target.client.get(other.item.id, { full: true })).item.body, 'Native A');
});

test('refusal rollback is crash recoverable at every SDK rollback transition', async t => {
  const probe = await rollbackScenario(t); const boundaries: string[] = [];
  await assert.rejects(importDir(probe.path, { ...probe.target.options, from: 'agents-md', onStep: step => { if (step === 'rollback-apply') boundaries.push(step); }, onTransition: async event => {
    if (event.transactionId.endsWith('-rollback')) boundaries.push(`${event.transition}:${event.stepId ?? ''}`);
    else if (event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Refuse provenance stage');
  } }), error => error instanceof MemoryError);
  assert.ok(boundaries.length >= 5);
  for (let boundary = 0; boundary < boundaries.length; boundary++) {
    const { target, path } = await rollbackScenario(t); const before = await memoryDocuments(target.workspace); let index = 0;
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'rollback-apply' && index++ === boundary) throw new WorkspaceTransactionInterruptedError(); }, onTransition: event => {
      if (event.transactionId.endsWith('-rollback')) { if (index++ === boundary) throw new WorkspaceTransactionInterruptedError(); }
      else if (event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Refuse provenance stage');
    } }), WorkspaceTransactionInterruptedError);
    await importDir(path, { ...target.options, from: 'agents-md' });
    assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 3);
    assertClosedGraph((await target.client.listAllComplete()).items);
    assert.equal(Object.keys(before).length, Object.keys(await memoryDocuments(target.workspace)).length);
  }
});

test('committed attempts are skipped by allocation and by stale-intent recovery after deletion', async t => {
  const { target, path, intent } = await rollbackScenario(t);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'published') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const plan = JSON.parse(JSON.parse(await readFile(intent, 'utf8')).payload) as ImportPlan;
  const next = await target.store.write(() => importIdentity(target.store, plan.input, plan.attempt));
  assert.notEqual(next.transactionId, plan.transactionId); assert.notEqual(next.attempt, plan.attempt);
  for (const item of (await target.client.listAllComplete()).items) await target.client.run('delete', { id: item.id, options: { force: true } });
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).imported, 3);
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

test('rollback preserves the complete support graph adopted by a peer', async t => {
  for (const phase of ['nodes', 'readback']) {
    const { source } = await rollbackScenario(t); const target = await tracker(t);
    const sourceIds = new Map((await source.client.listAllComplete()).items.map(row => [String(row.memory_slug), row.id]));
    await source.store.link(sourceIds.get('alpha')!, sourceIds.get('beta')!);
    await source.store.link(sourceIds.get('beta')!, sourceIds.get('policy')!);
    const path = join(source.root, `adopted-${phase}`); await exportDir(path, { ...source.options, to: 'agents-md' });
    let injected = false;
    /** A peer can adopt nodes before data publication or edit an already connected graph. */
    const adopt = async () => {
      injected = true;
      const ids = new Map((await target.client.listAllComplete()).items.map(row => [String(row.memory_slug), row.id]));
      await target.client.update(ids.get('alpha')!, { body: 'Peer adopted alpha', dep: [`id=${ids.get('beta')!},kind=related`], replaceDeps: true });
      if (phase === 'nodes') await target.client.update(ids.get('beta')!, { dep: [`id=${ids.get('policy')!},kind=related`], replaceDeps: true });
      throw new Error('Refuse after peer adoption');
    };
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md',
      onStep: async step => { if (phase === 'readback' && step === 'readback') await adopt(); },
      onTransition: async event => { if (phase === 'nodes' && event.transactionId.endsWith('-nodes') && event.transition === 'step_recorded' && event.stepId!.startsWith('3-')) await adopt(); },
    }), error => error instanceof MemoryError);
    assert.equal(injected, true);
    const items = (await target.client.listAllComplete({ includeBody: true })).items;
    assert.equal(items.length, 3); assertClosedGraph(items);
    assert.equal(items.find(row => row.memory_slug === 'alpha')!.body, 'Peer adopted alpha');
  }
});

test('compensated recovery read boundaries remain genuine crash boundaries', async t => {
  for (const boundary of ['cas-read', 'cas-guarded']) {
    const { target, path, intent } = await rollbackScenario(t);
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onTransition: crashAfterCompensation }), WorkspaceTransactionInterruptedError);
    const documents = await memoryDocuments(target.workspace); const pending = await readFile(intent, 'utf8');
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === boundary) throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    assert.deepEqual(await memoryDocuments(target.workspace), documents); assert.equal(await readFile(intent, 'utf8'), pending);
    await importDir(path, { ...target.options, from: 'agents-md' });
    assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 3);
  }
});

test('malformed SDK journals produce typed remedies and a fresh retry retains foreign bytes', async t => {
  const { target, path, intent } = await rollbackScenario(t); let foreign = '';
  const typed = new MemoryError('conflict', 'External typed refusal', 'Retry the reviewed portable input');
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'intent') throw typed; } }), error => error === typed);
  const reserved = await target.client.create({ title: 'Reserved native identity' });
  await target.client.run('delete', { id: reserved.item.id, options: { force: true } });
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onTransition: async event => {
    if (event.transition === 'prepared') await target.client.create({ title: 'Reserved identity refuses', id: reserved.item.id });
  } }), error => error instanceof MemoryError && error.code === 'transaction');
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step !== 'intent') return;
    const plan = JSON.parse(JSON.parse(await readFile(intent, 'utf8')).payload) as ImportPlan;
    foreign = join(target.workspace, 'transactions', 'sdk', `${plan.transactionId}.json`);
    await writeFile(foreign, '{}');
  } }), error => error instanceof MemoryError && error.code === 'transaction' && error.remedy.length > 0);
  assert.equal(await readFile(foreign, 'utf8'), '{}');
  await importDir(path, { ...target.options, from: 'agents-md' });
  assert.equal(await readFile(foreign, 'utf8'), '{}');
});

test('ordinary rollback failures and corrupt rollback journals remain typed and recoverable', async t => {
  const { target, path, intent } = await rollbackScenario(t);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onTransition: refusalFault('step_recorded', new Error('Rollback observer failure')) }), error => error instanceof MemoryError && error.code === 'transaction');
  const plan = JSON.parse(JSON.parse(await readFile(intent, 'utf8')).payload) as ImportPlan; assert.equal(plan.refusing, true);
  const journal = join(target.workspace, 'transactions', 'sdk', `${plan.transactionId}-rollback.json`);
  const verified = await readFile(journal, 'utf8'); await writeFile(journal, '{}');
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'transaction');
  assert.equal(await readFile(journal, 'utf8'), '{}');
  // The fixture owner restores its verified journal; the importer never repairs it.
  await writeFile(journal, verified);
  await importDir(path, { ...target.options, from: 'agents-md' });
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 3);
});

test('a foreign intent appearing during refusal is skipped in fresh and compensated recovery paths', async t => {
  for (const mode of ['fresh', 'compensated']) {
    const { target, path, items, intent } = await rollbackScenario(t);
    if (mode === 'compensated') await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onTransition: crashAfterCompensation }), WorkspaceTransactionInterruptedError);
    const foreign = JSON.stringify({ owner: 'foreign:tool', retained: true }); let armed = mode === 'compensated'; let injected = false;
    const result = await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
      if (step === 'intent') armed = true;
      if (armed && !injected && step === 'cas-read') {
        injected = true;
        await target.client.update(items.find(row => row.memory_slug === 'policy')!.id, { body: 'Peer policy C' });
        await writeFile(intent, foreign);
      }
    } });
    await assertForeignIntent(result, injected, intent, foreign);
  }
});

test('occupied identity selection uses complete SDK inventories and preserves foreign records', async t => {
  const { source } = await rollbackScenario(t); const target = await tracker(t);
  const manifestPath = join(source.root, 'rollback-export', POLICY_MANIFEST);
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

test('mixed graph node compensation remaps every edge and reads older intent expectations safely', async t => {
  const { source } = await rollbackScenario(t); const target = await tracker(t);
  const native = await remember('Alpha A', { ...target.options, slug: 'alpha', kind: 'project' });
  const sourceItems = (await source.client.listAllComplete()).items;
  await source.store.link(sourceItems.find(row => row.memory_slug === 'beta')!.id, sourceItems.find(row => row.memory_slug === 'alpha')!.id);
  await source.store.link(sourceItems.find(row => row.memory_slug === 'policy')!.id, sourceItems.find(row => row.memory_slug === 'beta')!.id);
  const linked = join(source.root, 'linked-compensation'); await exportDir(linked, { ...source.options, to: 'agents-md' });
  await assert.rejects(importDir(linked, { ...target.options, from: 'agents-md', onTransition: event => {
    if (event.transactionId.endsWith('-nodes') && event.transition === 'step_recorded') throw new Error('Begin mixed node rollback');
    if (event.transition === 'compensated') throw new WorkspaceTransactionInterruptedError();
  } }), WorkspaceTransactionInterruptedError);
  const intent = join(target.workspace, 'runtime', 'memory-policy-import.json');
  const envelope = JSON.parse(await readFile(intent, 'utf8')) as { payload: string; checksum: string };
  const plan = JSON.parse(envelope.payload) as ImportPlan;
  const { initial: _initial, ...older } = plan;
  // The fixture represents an earlier private intent shape using its real SDK plan.
  envelope.payload = JSON.stringify(older); envelope.checksum = digest(envelope.payload);
  await writeFile(intent, JSON.stringify(envelope));
  const replanned = await target.store.write(() => replanNodes(target.store, older));
  assert.equal(replanned.mutations.some(row => row.id === native.id), false, 'unchanged native targets need no mutation');
  await importDir(linked, { ...target.options, from: 'agents-md' });
  const items = (await target.client.listAllComplete()).items; assert.equal(items.length, 3); assertClosedGraph(items);
  assert.equal(items.find(row => row.memory_slug === 'beta')!.dependencies![0].id, native.id);
  assert.equal((await importDir(linked, { ...target.options, from: 'agents-md' })).unchanged, 3);
});

test('native deletion of interrupted nodes wins and explicit retries create a fresh generation', async t => {
  const { path } = await rollbackScenario(t);
  for (const author of ['peer-agent', 'memory-test']) {
    const target = await tracker(t);
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'nodes') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    for (const item of (await target.client.listAllComplete()).items) await target.client.run('delete', { id: item.id, options: { force: true, author } });
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict');
    assert.equal((await target.client.listAllComplete()).items.length, 0);
    assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).imported, 3);
    assertClosedGraph((await target.client.listAllComplete()).items);
  }
});

test('history prefixes and exact SDK CAS fields are validated against actual tracker revisions', async t => {
  const { target, plan, path, intent } = await pausedScenario(t);
  const before = await memoryDocuments(target.workspace);
  const invalid = [
    { ...plan, expected: plan.expected.map(row => ({ ...row, history: 'a'.repeat(64) })) },
    ...[{ key: 'memory_slug', value: 'alpha' }, { key: 'updated_at', value: 'stale-revision' }].map(match => ({ ...plan, mutations: plan.mutations.map(row => ({ ...row, match })) })),
  ];
  for (const value of invalid) await assert.rejects(target.store.write(() => validateImportPlan(target.store, value)), error => error instanceof MemoryError && error.code === 'conflict');
  assert.deepEqual(await memoryDocuments(target.workspace), before);
  const envelope = JSON.parse(await readFile(intent, 'utf8')) as { payload: string; checksum: string };
  const { initial: _initial, ...older } = plan; envelope.payload = JSON.stringify(older); envelope.checksum = digest(envelope.payload);
  await writeFile(intent, JSON.stringify(envelope));
  await target.client.update(plan.expected.find(row => row.slug === 'policy')!.id, { body: 'Native legacy peer C' });
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict');
});

test('foreign serialized records without package history are retained at reserved identities', async t => {
  const { path } = await rollbackScenario(t); const target = await tracker(t);
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

test('a peer edit between rollback inspection and application is retained', async t => {
  const { target, path, items } = await rollbackScenario(t); let injected = false;
  const beta = items.find(row => row.memory_slug === 'beta')!;
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (!injected && step === 'rollback-apply') { injected = true; await target.client.update(beta.id, { body: 'Peer rollback C', author: 'peer-agent' }); }
  }, onTransition: event => {
    if (event.transactionId.endsWith('-snapshot') && event.transition === 'step_recorded') throw new Error('Begin guarded rollback');
  } }), error => error instanceof MemoryError);
  assert.equal(injected, true); assert.equal((await target.client.get(beta.id, { full: true })).item.body, 'Peer rollback C');
  await importDir(path, { ...target.options, from: 'agents-md' });
  assert.equal((await target.client.get(beta.id, { full: true })).item.body, 'Peer rollback C');
});

test('foreign metadata is excluded from exports and wrong-type identities skip on import', async t => {
  const { source, path } = await rollbackScenario(t);
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

test('a peer-owned intent at refusal-recovery cleanup is retained and reported truthfully', async t => {
  const { target, path, intent } = await rollbackScenario(t);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onTransition: refusalFault('prepared', new WorkspaceTransactionInterruptedError()) }), WorkspaceTransactionInterruptedError);
  const foreign = JSON.stringify({ owner: 'foreign:tool', keep: true }); let injected = false;
  const result = await importDir(path, { ...target.options, from: 'agents-md', onTransition: async event => {
    if (event.transactionId.endsWith('-rollback') && event.transition === 'committed') { await writeFile(intent, foreign); injected = true; }
  } });
  await assertForeignIntent(result, injected, intent, foreign);
});
