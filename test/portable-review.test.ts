import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importDir, exportDir, remember, renew, get, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { tracker } from './helpers.ts';

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
