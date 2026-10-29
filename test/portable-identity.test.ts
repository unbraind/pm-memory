import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportDir, importDir, remember, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { expectedTargets } from '../src/portable-plan.ts';
import { policyBody } from '../src/portable.ts';
import { tracker, importText, snapshot, editIntent } from './helpers.ts';

/** Change only editable harness text, retaining the exact exported policy marker. */
async function bodyEdit(directory: string, body: string) {
  const manifest = JSON.parse(await readFile(join(directory, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  const file = join(directory, manifest.guidance[0].path); const original = await readFile(file, 'utf8');
  await writeFile(file, original.slice(0, original.indexOf('\n') + 1) + body);
}
/** Read relationship targets and aliases directly through the SDK oracle. */
async function graph(target: Awaited<ReturnType<typeof tracker>>) {
  const rows = (await target.client.listAllComplete({ includeBody: true })).items;
  return rows.filter(row => row.memory_artifact !== true).map(row => ({ slug: row.memory_slug, body: row.body, links: (row.dependencies ?? []).map(edge => ({ kind: edge.kind, slug: rows.find(item => item.id === edge.id)?.memory_slug })).sort((a, b) => String(a.slug).localeCompare(String(b.slug))) })).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

/** Export an origin, rename it and create an indistinguishable display-name replacement. */
async function renamedOrigin(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t); const original = await remember('Original guidance', { ...source.options, slug: 'alpha', kind: 'reference' });
  const output = join(source.root, 'export'); await exportDir(output, { ...source.options, to: 'agents-md' });
  await source.client.run('update', { id: original.id, options: { memorySlug: 'renamed' } });
  const replacement = await remember('Original guidance', { ...source.options, slug: 'alpha', kind: 'reference', forceNew: true });
  return { source, original, replacement, output };
}

test('immutable origin wins over an identical same-slug replacement', async t => {
  const { source, original, replacement, output } = await renamedOrigin(t);
  const untouched = (await source.client.get(replacement.id, { full: true })).item;
  await bodyEdit(output, 'Harness revision'); await importDir(output, { ...source.options, from: 'agents-md' });
  assert.equal((await source.client.get(original.id, { full: true })).item.body, 'Harness revision');
  assert.deepEqual((await source.client.get(replacement.id, { full: true })).item, untouched);
  assert.equal((await source.client.get(original.id, { full: true })).item.memory_slug, 'renamed');
});

/** Import an indexed raw fixture without acquiring any native display-name authority. */
async function legacyFiles(source: Awaited<ReturnType<typeof tracker>>, linked: boolean) {
  const files = join(source.root, 'source'); await mkdir(files);
  await writeFile(join(files, 'MEMORY.md'), `- [Alpha](alpha.md)\n${linked ? '- [Beta](beta.md)\n' : ''}`);
  await writeFile(join(files, 'alpha.md'), `# Alpha\n${linked ? 'See [[beta]]' : 'Guidance'}`);
  if (linked) await writeFile(join(files, 'beta.md'), '# Beta\nGuidance');
  await importDir(files, { ...source.options, from: 'claude-code' }); return files;
}

/** Fresh imports compare SDK read-back rather than serialized exporter assumptions. */
async function freshGraph(t: Parameters<typeof tracker>[0], source: Awaited<ReturnType<typeof tracker>>, canonical = false) {
  const output = join(source.root, 'export'); const receipt = await exportDir(output, { ...source.options, to: 'claude-code' });
  if (canonical) assert.equal(receipt.byte_preserved, 0, 'Native identity edits require canonical guidance');
  const target = await tracker(t); await importDir(output, { ...target.options, from: 'claude-code' });
  return graph(target);
}

test('legacy export carries a native relationship retained after harness link removal', async t => {
  const source = await tracker(t); const files = await legacyFiles(source, true);
  const ids = new Map((await source.client.listAllComplete()).items.map(row => [row.memory_slug, row.id]));
  await source.client.update(ids.get('alpha')!, { depRemove: [`id=${ids.get('beta')},kind=related`], dep: [`id=${ids.get('beta')},kind=supersedes`] });
  await writeFile(join(files, 'alpha.md'), '# Alpha\nReference removed from text'); await importDir(files, { ...source.options, from: 'claude-code' });
  const expected = await graph(source); assert.equal(expected.find(row => row.slug === 'alpha')!.links.length, 1);
  assert.deepEqual(await freshGraph(t, source), expected);
});

test('legacy export carries an unreferenced native slug rename', async t => {
  const source = await tracker(t); await legacyFiles(source, false);
  const alpha = (await source.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!;
  await source.client.run('update', { id: alpha.id, options: { memorySlug: 'renamed' } });
  const expected = await graph(source);
  assert.deepEqual(await freshGraph(t, source, true), expected);
});

for (const to of ['agents-md', 'claude-code'] as const) for (const encoding of ['policy', 'legacy'] as const) {
  test(`immutable origin rename delete recreate permutations: ${to} ${encoding}`, async t => {
    const source = await tracker(t);
    const key = encoding === 'legacy' && to === 'agents-md' ? 'agents' : 'alpha';
    if (encoding === 'legacy') {
      const files = join(source.root, 'source'); await mkdir(files);
      if (to === 'claude-code') await writeFile(join(files, 'MEMORY.md'), '- [Alpha](alpha.md)\n');
      await writeFile(join(files, key === 'agents' ? 'AGENTS.md' : 'alpha.md'), '# Alpha\nOriginal guidance');
      await importDir(files, { ...source.options, from: to });
    } else await remember('Original guidance', { ...source.options, slug: key, kind: 'reference' });
    const origin = (await source.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === key)!;
    const directory = join(source.root, 'wire'); const receipt = await exportDir(directory, { ...source.options, to });
    if (encoding === 'legacy') assert.ok(receipt.byte_preserved > 0);
    const change = async (body: string) => {
      if (encoding === 'policy') await bodyEdit(directory, body);
      else await writeFile(join(directory, key === 'agents' ? 'AGENTS.md' : 'alpha.md'), body);
    };
    await source.client.run('update', { id: origin.id, options: { memorySlug: 'renamed' } });
    const replacement = await remember(String(origin.body), { ...source.options, slug: key, kind: 'reference', forceNew: true });
    await change('Harness B');
    await importDir(directory, { ...source.options, from: to });
    assert.equal((await source.client.get(origin.id, { full: true })).item.body, 'Harness B');
    assert.equal((await source.client.get(replacement.id, { full: true })).item.body, origin.body);
    await source.client.run('delete', { id: origin.id, options: { force: true } });
    const before = (await source.client.listAllComplete({ includeBody: true })).items;
    await assert.rejects(importDir(directory, { ...source.options, from: to }), missingOrigin);
    assert.deepEqual((await source.client.listAllComplete({ includeBody: true })).items, before);
    // Explicit create still cannot adopt the unrelated occupant of a display alias.
    await assert.rejects(importDir(directory, { ...source.options, from: to, createMissingOrigins: true }), missingOrigin);
    await source.client.run('delete', { id: replacement.id, options: { force: true } });
    await assert.rejects(importDir(directory, { ...source.options, from: to }), missingOrigin);
    assert.equal((await importDir(directory, { ...source.options, from: to, createMissingOrigins: true })).imported, 1);
    const recreated = (await source.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === key)!;
    assert.notEqual(recreated.id, origin.id); assert.equal(recreated.body, 'Harness B');
    await source.client.run('update', { id: recreated.id, options: { memorySlug: 'second-name', memorySource: 'native:item', memoryOriginal: 'Native-only bookkeeping', memoryPath: 'native-only.md', memoryEdited: true } });
    await change('Harness C'); await importDir(directory, { ...source.options, from: to });
    const current = (await source.client.get(recreated.id, { full: true })).item;
    assert.equal(current.memory_slug, 'second-name'); assert.equal(current.body, 'Harness C');
    assert.equal(current.memory_source, 'native:item'); assert.equal(current.memory_original, 'Native-only bookkeeping');
    assert.equal(current.memory_path, 'native-only.md'); assert.equal(current.memory_edited, true);
  });
}

/** A known missing origin is recoverable only through an explicit creation action. */
const missingOrigin = (error: unknown) => error instanceof MemoryError && error.code === 'origin_missing' && error.remedy.includes('--create');

test('raw wiki references follow immutable intake origins and cannot adopt native alias replacements', async t => {
  const source = await tracker(t); await importText(source, 'beta.md', 'Beta original');
  const beta = (await source.client.listAllComplete()).items.find(row => row.memory_slug === 'beta')!;
  await source.client.run('update', { id: beta.id, options: { memorySlug: 'renamed-beta' } });
  const replacement = await remember('Beta original', { ...source.options, slug: 'beta', kind: 'reference', forceNew: true });
  const alphaFile = join(source.root, 'alpha.md'); await writeFile(alphaFile, 'Alpha links [[beta]]');
  await importDir(alphaFile, { ...source.options, from: 'agents-md' });
  const alpha = (await source.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === 'alpha')!;
  assert.equal(alpha.dependencies?.length, 1); assert.equal(alpha.dependencies[0].id, beta.id);
  assert.notEqual(alpha.dependencies![0].id, replacement.id);
  const native = await remember('Independent native target', { ...source.options, slug: 'native', kind: 'reference', forceNew: true });
  await writeFile(alphaFile, 'Alpha links [[beta]] and [[native]]');
  const result = await importDir(alphaFile, { ...source.options, from: 'agents-md' });
  assert.equal(result.unresolved_links, 1);
  assert.equal((await source.client.get(alpha.id, { full: true })).item.dependencies!.some(edge => edge.id === native.id), false);
});

test('existing origin updates ignore unrelated foreign aliases and report their preservation', async t => {
  const source = await tracker(t); const alpha = await remember('Alpha native', { ...source.options, slug: 'alpha', kind: 'reference' });
  const directory = join(source.root, 'export'); await exportDir(directory, { ...source.options, to: 'agents-md' });
  const foreign = await source.client.run('create', { options: { title: 'Foreign alias', memorySlug: 'alpha', memorySource: 'foreign:tool', allowDuplicate: true } });
  const before = (await source.client.listAllComplete({ includeBody: true })).items.find(row => row.id !== alpha.id)!;
  await bodyEdit(directory, 'Portable revision'); const result = await importDir(directory, { ...source.options, from: 'agents-md' });
  assert.equal((await source.client.get(alpha.id, { full: true })).item.body, 'Portable revision');
  assert.deepEqual((await source.client.listAllComplete({ includeBody: true })).items.find(row => row.id === before.id), before);
  assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.slug === before.id && row.reason.includes('Foreign')));
  assert.ok(foreign);
});

test('unbound older manifests require explicit creation and never adopt a same-name native record', async t => {
  const source = await tracker(t); const alpha = await remember('Original guidance', { ...source.options, slug: 'alpha', kind: 'reference' });
  const directory = join(source.root, 'old-bundle'); await exportDir(directory, { ...source.options, to: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(directory, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  const row = manifest.guidance[0]; delete row.origin; delete row.baseline!.origin;
  await writeFile(join(directory, POLICY_MANIFEST), JSON.stringify(manifest));
  await writeFile(join(directory, row.path), policyBody(row, 'Original guidance'));
  const fresh = await tracker(t); const before = await snapshot(fresh.workspace);
  await assert.rejects(importDir(directory, { ...fresh.options, from: 'agents-md' }), missingOrigin);
  assert.deepEqual(await snapshot(fresh.workspace), before);
  const original = (await source.client.get(alpha.id, { full: true })).item;
  await assert.rejects(importDir(directory, { ...source.options, from: 'agents-md', createMissingOrigins: true }), missingOrigin);
  assert.deepEqual((await source.client.get(alpha.id, { full: true })).item, original);
  assert.equal((await importDir(directory, { ...fresh.options, from: 'agents-md', createMissingOrigins: true })).imported, 1);
  await assert.rejects(importDir(directory, { ...fresh.options, from: 'agents-md' }), missingOrigin);
  const rebound = join(fresh.root, 'bound'); await exportDir(rebound, { ...fresh.options, to: 'agents-md' });
  assert.equal((await importDir(rebound, { ...fresh.options, from: 'agents-md' })).unchanged, 1);
});

test('pre-identity recovery plans compensate and reselect immutable origins', async t => {
  const { source, original, replacement, output: directory } = await renamedOrigin(t);
  await bodyEdit(directory, 'Harness revision');
  await assert.rejects(importDir(directory, { ...source.options, from: 'agents-md', onStep: step => { if (step === 'intent') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const intent = join(source.workspace, 'runtime', 'memory-policy-import.json');
  const expected = await source.store.write(() => expectedTargets(source.store, [{ id: replacement.id, slug: 'alpha' }]));
  const older = await editIntent(intent, plan => {
    delete plan.identityVersion;
    plan.expected = expected; delete plan.forwardOnly; plan.members = [replacement.id];
    plan.ownership = plan.ownership!.map(row => ({ ...row, id: replacement.id }));
    plan.mutations = plan.mutations.map(row => ({ ...row, id: replacement.id, match: { key: 'updated_at', value: expected[0].version } }));
    return plan;
  });
  let actual = '';
  await importDir(directory, { ...source.options, from: 'agents-md', onStep: async step => { if (step === 'intent') actual = JSON.parse(JSON.parse(await readFile(intent, 'utf8')).payload).transactionId; } });
  assert.notEqual(actual, older.transactionId);
  assert.equal((await source.client.get(original.id, { full: true })).item.body, 'Harness revision');
  assert.equal((await source.client.get(replacement.id, { full: true })).item.body, 'Original guidance');
});
