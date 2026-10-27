import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importDir, exportDir, remember, renew, get, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { WorkspaceTransactionInterruptedError, canonicalDocument } from '@unbrained/pm-cli/sdk';
import { policyBody } from '../src/portable.ts';
import { tracker, snapshot, assertClosedGraph, memoryDocuments, crashAfterCompensation, crashAtStep as crashStep, exportedPolicy, importSubset } from './helpers.ts';

/** Export an actual mixed tracker and expose its harness-editable body. */
async function scenario(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t);
  const first = await remember('Memory alpha', { ...source.options, slug: 'alpha', kind: 'project' });
  const second = await remember('Memory beta', { ...source.options, slug: 'beta', kind: 'reference', links: [first.id] });
  await remember('Unrelated bounded policy', { ...source.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...source.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Public review' });
  const { path, manifest } = await exportedPolicy(source);
  return { ...source, path, manifest, first, second };
}

/** Select one editable memory and a fresh target without repeating setup contracts. */
async function editable(t: Parameters<typeof tracker>[0]) {
  const source = await scenario(t); const target = await tracker(t);
  return { source, target, row: source.manifest.guidance.find(row => row.slug === 'alpha')! };
}
/** Import A, then prepare a harness revision on a fresh real target. */
async function revisionTarget(t: Parameters<typeof tracker>[0], source: Awaited<ReturnType<typeof scenario>>, row: PortablePolicyManifest['guidance'][number], body: string) {
  const target = await tracker(t);
  await writeFile(join(source.path, row.path), policyBody(row, 'Memory alpha'));
  await importDir(source.path, { ...target.options, from: 'agents-md' });
  await writeFile(join(source.path, row.path), policyBody(row, body));
  return target;
}
/** Seed a genuine imported origin while leaving its related records for a later mixed batch. */
async function seedAlpha(source: Awaited<ReturnType<typeof scenario>>, target: Awaited<ReturnType<typeof tracker>>) {
  await importSubset(source.path, target, ['alpha']);
  return (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!;
}
/** A moved native target may produce a typed refusal or a truthful planner skip. */
async function preservesNative(run: ReturnType<typeof importDir>, slug: string): Promise<void> {
  try { const result = await run; assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.slug === slug)); }
  catch (error) { assert.ok(error instanceof MemoryError && error.code === 'conflict' && error.remedy.length > 0); }
}

test('older manifests perform a real A B A update instead of replaying a completed transaction', async t => {
  const { source, target, row } = await editable(t);
  for (const body of ['A', 'B', 'A']) {
    await writeFile(join(source.path, row.path), policyBody(row, body));
    const result = await importDir(source.path, { ...target.options, from: 'agents-md' });
    assert.equal((await get('alpha', target.options)).body, body);
    assert.ok('skipped' in result); assert.equal(result.skipped.length, 0);
    if (body === 'B') assert.equal(result.updated, 1);
  }
});

test('SDK whitespace normalization never fabricates an independent native edit', async t => {
  const { source, target, row } = await editable(t);
  for (const body of ['A\n', '\nA\n\n', ' A \r\n B \r\n', 'B\r\n']) {
    await writeFile(join(source.path, row.path), policyBody(row, body));
    await importDir(source.path, { ...target.options, from: 'agents-md' });
    const repeated = await importDir(source.path, { ...target.options, from: 'agents-md' });
    assert.equal(repeated.unchanged, 3); assert.ok('skipped' in repeated); assert.equal(repeated.skipped.length, 0);
  }
});

test('mixed bounded exports preserve relationship kinds, provenance and removals through the SDK', async t => {
  const source = await scenario(t); const target = await tracker(t);
  await source.store.link(source.first.id, source.second.id, 'supersedes');
  const path = join(source.root, 'typed'); await exportDir(path, { ...source.options, to: 'agents-md' });
  await importDir(path, { ...target.options, from: 'agents-md' });
  const items = (await target.client.listAllComplete({ includeBody: true })).items;
  const alpha = items.find(row => row.memory_slug === 'alpha')!;
  const beta = items.find(row => row.memory_slug === 'beta')!;
  assert.equal(alpha.dependencies![0].id, beta.id); assert.equal(alpha.dependencies![0].kind, 'supersedes');
  assert.equal(beta.dependencies![0].id, alpha.id); assert.equal(beta.dependencies![0].kind, 'related');
  assert.equal(beta.dependencies![0].author, 'memory-test');
  await source.store.fields(source.second.id, { why: 'Reviewed relation' });
  const revised = join(source.root, 'revised'); await exportDir(revised, { ...source.options, to: 'agents-md' });
  await importDir(revised, { ...target.options, from: 'agents-md' });
  assert.equal((await target.client.get(beta.id, { full: true })).item.memory_why, 'Reviewed relation');
  await source.store.client.update(source.first.id, { clearDeps: true });
  const removed = join(source.root, 'removed'); await exportDir(removed, { ...source.options, to: 'agents-md' });
  await importDir(removed, { ...target.options, from: 'agents-md' });
  assert.deepEqual((await target.client.get(alpha.id, { full: true })).item.dependencies ?? [], []);
  assert.equal((await target.client.get(beta.id, { full: true })).item.dependencies!.length, 1);
});

test('recovery and fresh CAS refuse newer remember edits at every journal boundary', async t => {
  const { source, row } = await editable(t);
  const boundaries: string[] = ['intent'];
  /** Plan the same A-to-B change on an independently initialized tracker. */
  const baseline = async () => {
    return revisionTarget(t, source, row, 'Harness B');
  };
  const probe = await baseline();
  await importDir(source.path, { ...probe.options, from: 'agents-md', onTransition: event => { boundaries.push(`${event.transactionId.endsWith('-snapshot') ? 'snapshot' : 'data'}:${event.transition}:${event.stepId ?? ''}`); } });
  boundaries.push('readback', 'published');
  for (const [boundaryIndex, boundary] of boundaries.entries()) {
    let transition = 0;
    const target = await baseline();
    await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md',
      onStep: crashStep(boundary),
      onTransition: event => { if (boundary.includes(':') && transition++ === boundaryIndex - 1) throw new WorkspaceTransactionInterruptedError(); },
    }), WorkspaceTransactionInterruptedError);
    await remember('Native peer C', { ...target.options, update: 'alpha', kind: 'project' });
    const before = await snapshot(target.workspace);
    await preservesNative(importDir(source.path, { ...target.options, from: 'agents-md' }), 'alpha');
    assert.equal((await get('alpha', target.options)).body, 'Native peer C', boundary);
    assert.deepEqual(await snapshot(target.workspace), before, boundary);
  }
  for (const step of ['read', 'schema-type', 'previewed', 'prepared']) {
    const target = await baseline();
    const alpha = await get('alpha', target.options);
    await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md',
      onStep: async current => { if (current === step) await target.client.update(alpha.id, { body: 'Fresh peer C' }); },
      onTransition: async event => { if (event.transition === step) await target.client.update(alpha.id, { body: 'Fresh peer C' }); },
    }), error => error instanceof MemoryError && error.code === 'conflict');
    assert.equal((await get('alpha', target.options)).body, 'Fresh peer C');
  }
});

test('foreign target skips close transitively over the whole plan and imports remain retryable', async t => {
  const source = await scenario(t);
  await remember('Memory gamma', { ...source.options, slug: 'gamma', kind: 'reference', links: [source.second.id] });
  const path = join(source.root, 'closure'); await exportDir(path, { ...source.options, to: 'agents-md' });
  const target = await tracker(t);
  const alpha = await seedAlpha(source, target);
  await target.store.fields(alpha.id, { source: 'foreign:tool' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await importDir(path, { ...target.options, from: 'agents-md' }); assert.ok('skipped' in result);
    assert.deepEqual(result.skipped.map(row => row.slug).sort(), ['alpha', 'beta', 'gamma']);
    assert.equal(new Set(result.skipped.map(row => row.reason)).size, 1);
    const items = (await target.client.listAllComplete({ includeBody: true })).items;
    assert.equal(items.length, 2); assertClosedGraph(items);
    assert.equal((await target.client.get(alpha.id, { full: true })).item.memory_source, 'foreign:tool');
  }
  await target.store.fields(alpha.id, { source: 'native:item' });
  await importDir(path, { ...target.options, from: 'agents-md' });
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 4);
});

test('unchanged compares current SDK content after an older native body is restored', async t => {
  const { source, target, row } = await editable(t);
  await importDir(source.path, { ...target.options, from: 'agents-md' });
  await writeFile(join(source.path, row.path), policyBody(row, 'Harness B'));
  await importDir(source.path, { ...target.options, from: 'agents-md' });
  const alpha = await get('alpha', target.options);
  await target.client.update(alpha.id, { body: 'Memory alpha' });
  const result = await importDir(source.path, { ...target.options, from: 'agents-md' });
  assert.equal(result.updated, 1); assert.equal(result.unchanged, 2);
  assert.equal((await target.client.get(alpha.id, { full: true })).item.body, 'Harness B');
  assert.equal((await importDir(source.path, { ...target.options, from: 'agents-md' })).unchanged, 3);
});

test('interrupted new graph nodes never dangle when a foreign owner or native edit wins', async t => {
  for (const boundary of ['first-node', 'nodes']) {
    const source = await scenario(t); const target = await tracker(t);
    source.manifest.guidance.sort((a, b) => a.slug === 'beta' ? -1 : b.slug === 'beta' ? 1 : a.slug.localeCompare(b.slug));
    await writeFile(join(source.path, POLICY_MANIFEST), JSON.stringify(source.manifest));
    await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md',
      onStep: crashStep(boundary),
      onTransition: event => { if (boundary === 'first-node' && event.transactionId.endsWith('-nodes') && event.transition === 'step_applied') throw new WorkspaceTransactionInterruptedError(); },
    }), WorkspaceTransactionInterruptedError);
    const alpha = await remember('Newer alpha', { ...target.options, slug: 'alpha', kind: 'project', forceNew: true });
    if (boundary === 'first-node') await target.store.fields(alpha.id, { source: 'foreign:tool' });
    const before = await target.client.get(alpha.id, { full: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      await preservesNative(importDir(source.path, { ...target.options, from: 'agents-md' }), 'alpha');
      assert.deepEqual((await target.client.get(alpha.id, { full: true })).item, before.item);
      const items = (await target.client.listAllComplete({ includeBody: true })).items;
      assertClosedGraph(items);
      assert.equal((await get('alpha', target.options)).body, 'Newer alpha');
    }
  }
});

test('compensated mixed graphs remap reserved node IDs and never delete a newer peer edit', async t => {
  for (const peer of [false, true]) {
    const source = await scenario(t); const target = await tracker(t);
    const alpha = await seedAlpha(source, target);
    const policy = (await source.store.read()).find(row => row.slug === 'policy')!;
    await source.store.link(policy.id, source.second.id);
    const path = join(source.root, 'mixed-recovery'); await exportDir(path, { ...source.options, to: 'agents-md' });
    const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    manifest.guidance.sort((a, b) => a.slug === 'beta' ? -1 : b.slug === 'beta' ? 1 : a.slug.localeCompare(b.slug));
    await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
    let old = '';
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onTransition: async event => {
      if (!event.transactionId.endsWith('-nodes') || event.transition !== 'step_recorded') return;
      old = (await target.client.listAllComplete()).items.find(item => item.memory_slug === 'beta')!.id;
      if (peer) await target.client.update(old, { body: 'Peer beta wins' });
      throw new Error('Roll back newly created nodes');
    } }));
    assert.ok(old);
    if (peer) {
      const result = await importDir(path, { ...target.options, from: 'agents-md' }); assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.slug === 'beta'));
      assert.equal((await target.client.get(old, { full: true })).item.body, 'Peer beta wins');
    } else {
      await importDir(path, { ...target.options, from: 'agents-md' });
      const items = (await target.client.listAllComplete({ includeBody: true })).items;
      const beta = items.find(row => row.memory_slug === 'beta')!; const policy = items.find(row => row.memory_slug === 'policy')!;
      assert.equal(items.length, 3); assert.notEqual(beta.id, old);
      assert.equal(beta.dependencies![0].id, alpha.id); assert.equal(policy.dependencies![0].id, beta.id);
      assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 3);
    }
    const items = (await target.client.listAllComplete()).items;
    assertClosedGraph(items);
  }
});

test('deleted imported memories can be recreated after A or A B without reusing a committed journal', async t => {
  for (const between of [false, true]) {
    const { source, target, row } = await editable(t);
    await writeFile(join(source.path, row.path), policyBody(row, 'A'));
    await importDir(source.path, { ...target.options, from: 'agents-md' });
    if (between) {
      await writeFile(join(source.path, row.path), policyBody(row, 'B'));
      await importDir(source.path, { ...target.options, from: 'agents-md' });
    }
    for (const item of (await target.client.listAllComplete()).items) await target.client.run('delete', { id: item.id, options: { force: true } });
    await writeFile(join(source.path, row.path), policyBody(row, 'A'));
    await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), (error: unknown) => error instanceof MemoryError && error.code === 'origin_missing');
    assert.equal((await importDir(source.path, { ...target.options, from: 'agents-md', createMissingOrigins: true })).imported, 3);
    assert.equal((await get('alpha', target.options)).body, 'A');
    assert.equal((await importDir(source.path, { ...target.options, from: 'agents-md' })).unchanged, 3);
    assertClosedGraph((await target.client.listAllComplete()).items);
  }
});

test('shared read guard CAS preserves native edits at every fresh and recovery boundary', async t => {
  const { source, row } = await editable(t);
  /** Prepare each protocol path without mocking SDK revisions or compensation. */
  const prepare = async (mode: string) => {
    const target = await revisionTarget(t, source, row, 'Retry B');
    if (mode === 'interrupted') await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md', onStep: crashStep('intent') }), WorkspaceTransactionInterruptedError);
    if (mode === 'compensated') await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md', onTransition: crashAfterCompensation }), WorkspaceTransactionInterruptedError);
    return target;
  };
  for (const mode of ['fresh', 'interrupted', 'compensated']) {
    const probe = await prepare(mode); const boundaries: string[] = [];
    await importDir(source.path, { ...probe.options, from: 'agents-md', onStep: step => { if (step.startsWith('cas-')) boundaries.push(step); } });
    assert.ok(boundaries.length >= 4, mode);
    for (let boundary = 0; boundary < boundaries.length; boundary++) {
      const target = await prepare(mode); let index = 0; let injected = false;
      const alpha = await get('alpha', target.options);
      await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md', onStep: async step => {
        if (step.startsWith('cas-') && index++ === boundary) { await target.client.update(alpha.id, { body: 'Peer C edit' }); injected = true; }
      } }), error => error instanceof MemoryError && error.remedy.length > 0);
      assert.equal(injected, true, `${mode}:${boundary}`);
      assert.equal((await get('alpha', target.options)).body, 'Peer C edit', `${mode}:${boundary}`);
      const retry = await importDir(source.path, { ...target.options, from: 'agents-md' });
      assert.ok('skipped' in retry); assert.ok(retry.skipped.some(row => row.slug === 'alpha'));
      assert.equal((await get('alpha', target.options)).body, 'Peer C edit');
    }
  }
});

test('mid-batch revision refusals compensate memory documents and retry without manual intent removal', async t => {
  const source = await scenario(t); const target = await tracker(t);
  await importDir(source.path, { ...target.options, from: 'agents-md' });
  for (const row of source.manifest.guidance.filter(row => row.slug !== 'policy')) await writeFile(join(source.path, row.path), policyBody(row, `Retry ${row.slug}`));
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  const bytes = await memoryDocuments(target.workspace);
  const policy = before.find(row => row.memory_slug === 'policy')!;
  let injected = false;
  await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md', onTransition: async event => {
    if (!injected && event.transition === 'step_applied') { injected = true; await target.client.update(policy.id, { body: 'Native policy edit' }); }
  } }), error => error instanceof MemoryError && error.code === 'conflict');
  const after = (await target.client.listAllComplete({ includeBody: true })).items;
  for (const item of before.filter(row => row.id !== policy.id)) assert.deepEqual(canonicalDocument({ metadata: after.find(row => row.id === item.id)!, body: String(after.find(row => row.id === item.id)!.body) }), canonicalDocument({ metadata: item, body: String(item.body) }), item.id);
  const restored = await memoryDocuments(target.workspace);
  for (const [path, body] of Object.entries(bytes)) if (!path.includes(policy.id)) assert.equal(restored[path], body, path);
  assert.equal(after.find(row => row.id === policy.id)!.body, 'Native policy edit');
  const retried = await importDir(source.path, { ...target.options, from: 'agents-md' });
  assert.equal(retried.updated, 2); assert.equal((await get('alpha', target.options)).body, 'Retry alpha');
  assert.equal((await get('beta', target.options)).body, 'Retry beta');
  assert.equal((await get('policy', target.options)).body, 'Native policy edit');
});

test('bounded exports omit canceled missing and artifact references with typed receipts', async t => {
  for (const reason of ['canceled', 'missing', 'artifact'] as const) {
    const source = await scenario(t); const target = await tracker(t);
    const targetId = reason === 'missing' ? 'memory-test-missing' : source.second.id;
    await source.client.update(source.first.id, { dep: [`id=${targetId},kind=related`], replaceDeps: true, allowUnresolvedDeps: true });
    if (reason === 'canceled') await source.client.update(targetId, { status: 'canceled' });
    if (reason === 'artifact') await source.store.fields(targetId, { artifact: true });
    const path = join(source.root, `external-${reason}`);
    const result = await exportDir(path, { ...source.options, to: 'agents-md' });
    assert.ok(result.omitted_links?.some(row => row.slug === 'alpha' && row.target === targetId && row.reason === reason));
    const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    assert.deepEqual(manifest.guidance.find(row => row.slug === 'alpha')!.relationships, []);
    await importDir(path, { ...target.options, from: 'agents-md' });
    assertClosedGraph((await target.client.listAllComplete()).items);
  }
});
