import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importDir, exportDir, remember, renew, get, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { policyBody } from '../src/portable.ts';
import { tracker, snapshot, assertClosedGraph } from './helpers.ts';

/** Export an actual mixed tracker and expose its harness-editable body. */
async function scenario(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t);
  const first = await remember('Memory alpha', { ...source.options, slug: 'alpha', kind: 'project' });
  const second = await remember('Memory beta', { ...source.options, slug: 'beta', kind: 'reference', links: [first.id] });
  await remember('Unrelated bounded policy', { ...source.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...source.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Public review' });
  const path = join(source.root, 'export'); await exportDir(path, { ...source.options, to: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  return { ...source, path, manifest, first, second };
}

/** Select one editable memory and a fresh target without repeating setup contracts. */
async function editable(t: Parameters<typeof tracker>[0]) {
  const source = await scenario(t); const target = await tracker(t);
  return { source, target, row: source.manifest.guidance.find(row => row.slug === 'alpha')! };
}

/** Stop at one named package boundary without repeating observer plumbing. */
function crashStep(boundary: string) { return (step: string) => { if (step === boundary) throw new WorkspaceTransactionInterruptedError(); }; }

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
    const target = await tracker(t);
    await writeFile(join(source.path, row.path), policyBody(row, 'Memory alpha'));
    await importDir(source.path, { ...target.options, from: 'agents-md' });
    await writeFile(join(source.path, row.path), policyBody(row, 'Harness B'));
    return target;
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
    try { const result = await importDir(source.path, { ...target.options, from: 'agents-md' }); assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.slug === 'alpha')); }
    catch (error) { assert.ok(error instanceof MemoryError && error.code === 'conflict' && error.remedy.length > 0); }
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
  const alpha = await remember('Memory alpha', { ...target.options, slug: 'alpha', kind: 'project' });
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
    const before = await snapshot(target.workspace);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict');
      assert.deepEqual(await snapshot(target.workspace), before);
      const items = (await target.client.listAllComplete({ includeBody: true })).items;
      assertClosedGraph(items);
      assert.equal((await get('alpha', target.options)).body, 'Newer alpha');
    }
  }
});

test('compensated mixed graphs remap reserved node IDs and never delete a newer peer edit', async t => {
  for (const peer of [false, true]) {
    const source = await scenario(t); const target = await tracker(t);
    const alpha = await remember('Memory alpha', { ...target.options, slug: 'alpha', kind: 'project' });
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
      await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict');
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
