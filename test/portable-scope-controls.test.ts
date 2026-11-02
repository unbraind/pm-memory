import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importDir, remember, POLICY_MANIFEST } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { encodeDocument, sourceDocument } from '../src/portable-source.ts';
import { ownershipPatch, portableFields, unsetSourceFields } from '../src/portable-ownership.ts';
import { capturedPublication } from './portable-publication-helpers.ts';
import { tracker, exportedPolicy, snapshot, assertSkippedUnchanged } from './helpers.ts';

/** Refused document changes report the exact field while preserving all durable native bytes. */
async function refusedDocument(target: Awaited<ReturnType<typeof tracker>>, path: string, field: string): Promise<void> {
  const before = await snapshot(target.workspace);
  const result = await importDir(path, { ...target.options, from: 'agents-md' });
  assert.equal(result.updated, 0);
  assert.ok('skipped' in result && result.skipped.some(row => row.conflict?.fields.includes(field)));
  assert.deepEqual(await snapshot(target.workspace), before);
}

for (const mode of ['raw', 'policy'] as const) test(`a native document removal is retained with a typed conflict: ${mode}`, async t => {
  const { target, mutation } = await capturedPublication(t); let path = join(target.root, 'input');
  if (mode === 'policy') {
    await target.client.run('update', { id: mutation.id, options: { memoryPinned: true } });
    const exported = await exportedPolicy(target, 'missing-document'); path = exported.path;
    const row = exported.manifest.guidance[0]; delete row.baseline;
    await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(exported.manifest));
    await writeFile(join(path, row.path), policyBody(row, 'Alpha B'));
  }
  await target.client.update(mutation.id, { unset: ['memory_document'] });
  await refusedDocument(target, path, 'document');
  assert.equal((await target.client.get(mutation.id, { full: true })).item.memory_document, undefined);
});

test('a removed policy-body snapshot cannot be reconstructed from an older export', async t => {
  const target = await tracker(t);
  const alpha = await remember('Alpha A', { ...target.options, slug: 'alpha', kind: 'reference', pin: true });
  await target.client.run('update', { id: alpha.id, options: { memoryPolicyBody: encodeDocument({ version: 1, format: 'policy', harness: 'agents-md', path: 'alpha.md', original: Buffer.from('Alpha A\n').toString('base64') }) } });
  const { path, manifest } = await exportedPolicy(target, 'missing-policy-body'); const row = manifest.guidance[0];
  await writeFile(join(path, row.path), policyBody(row, 'Alpha B\n'));
  await target.client.update(alpha.id, { unset: ['memory_policy_body'] });
  await refusedDocument(target, path, 'policy_body');
});

for (const mode of ['create', 'update'] as const) test(`a later raw conflict removes an earlier dependent ${mode} from publication`, async t => {
  const target = await tracker(t); const path = join(target.root, 'input'); await mkdir(path);
  await writeFile(join(path, 'beta.md'), '# Beta A');
  if (mode === 'update') await writeFile(join(path, 'alpha.md'), '# Alpha A [[beta]]');
  await importDir(path, { ...target.options, from: 'agents-md' });
  const beta = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'beta')!;
  await target.client.update(beta.id, { body: 'Native beta C' });
  await writeFile(join(path, 'alpha.md'), '# Alpha B [[beta]]'); await writeFile(join(path, 'beta.md'), '# Beta B');
  await assertSkippedUnchanged(async () => {
    const result = await importDir(path, { ...target.options, from: 'agents-md' });
    assert.deepEqual([result.imported, result.updated], [0, 0]); return result;
  }, target.workspace, 2);
});

test('source namespaces use SDK normalization before computing relationship scope or writes', async t => {
  const target = await tracker(t); const alpha = await remember('Alpha A', { ...target.options, slug: 'alpha', kind: 'reference' });
  const beta = await remember('Beta A', { ...target.options, slug: 'beta', kind: 'reference' });
  for (const namespace of ['external', 'tenant']) {
    await target.client.update(alpha.id, { dep: [`id=${beta.id},kind=related,source_kind=${namespace},author=peer`], replaceDeps: true, allowUnresolvedDeps: true });
    const { path, manifest } = await exportedPolicy(target, `namespace-${namespace}`); const row = manifest.guidance.find(row => row.slug === 'alpha')!;
    const all = await target.store.read(); const memory = all.find(row => row.id === alpha.id)!;
    const ids = new Map(all.map(row => [row.slug, row.id]));
    for (const alias of namespace === 'external' ? ['external', 'global', ' global '] : ['tenant', ' tenant ']) {
      row.relationships[0].source_kind = alias;
      const patch = ownershipPatch(memory, row, memory.body, ids, ids);
      assert.deepEqual(patch.options, {}, `SDK-equivalent namespace ${JSON.stringify(alias)} has no mutation`);
      assert.deepEqual(patch.ownership.graph, memory.relationships);
      await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
      const rows = (await target.client.listAllComplete({ includeBody: true })).items;
      assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 0);
      assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, rows);
    }
  }
});

test('SDK description removal clears an owned value and refuses a later native value', async t => {
  const target = await tracker(t); const alpha = await remember('Alpha A', { ...target.options, slug: 'alpha', kind: 'reference' });
  await target.client.update(alpha.id, { description: 'Owned hook' });
  const native = (await target.store.read())[0]; const metadata = (await target.client.get(alpha.id, { full: true })).item;
  const fields = portableFields(native, native.body);
  const source = sourceDocument('alpha.md', Buffer.from('---\nname: alpha\n---\nAlpha A'), 'agents-md');
  const options: Record<string, unknown> = {};
  assert.deepEqual(unsetSourceFields(options, source, { present: ['description'], native, metadata, fields }), []);
  assert.equal(options.description, ''); await target.client.update(alpha.id, options);
  assert.equal((await target.client.get(alpha.id, { full: true })).item.description, '');
  await target.client.update(alpha.id, { description: 'Independent hook C' });
  const changed = (await target.store.read())[0];
  assert.deepEqual(unsetSourceFields({}, source, { present: ['description'], native: changed, metadata: (await target.client.get(alpha.id, { full: true })).item, fields }), ['description']);
});

for (const original of [undefined, Buffer.from([255]).toString('base64')]) test(`old source tags without decodable immutable bytes never authorize an intake: ${original === undefined ? 'missing' : 'invalid'}`, async t => {
  const target = await tracker(t); await target.store.register();
  await target.client.run('create', { options: { title: 'Alpha A', body: 'Alpha A', type: 'Knowledge', memorySlug: 'alpha', memoryKind: 'reference', memorySource: 'agents-md:relative-file', memoryPath: 'alpha.md', ...(original === undefined ? {} : { memoryOriginal: original }) } });
  const path = join(target.root, 'alpha.md'); await writeFile(path, 'Alpha B');
  await assertSkippedUnchanged(async () => {
    const result = await importDir(path, { ...target.options, from: 'agents-md' });
    assert.ok('skipped' in result && result.skipped.some(row => row.reason === 'Foreign record has no package-owned source'), 'Undecodable immutable bytes must keep the record foreign to package ownership'); return result;
  }, target.workspace);
});

test('changing a native source tag cannot invent missing immutable legacy bytes', async t => {
  const target = await tracker(t); await target.store.register();
  const fields = { title: 'Alpha A', body: 'Alpha A', type: 'Knowledge', memorySlug: 'alpha', memoryKind: 'reference', memorySource: 'native:item' };
  const item = (await target.client.create(fields)).item;
  await target.client.run('update', { id: item.id, options: { memorySource: 'agents-md:relative-file' } });
  const path = join(target.root, 'alpha.md'); await writeFile(path, 'Alpha B');
  await assertSkippedUnchanged(() => importDir(path, { ...target.options, from: 'agents-md' }), target.workspace);
});
