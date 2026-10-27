import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { exportDir, importDir, remember, MemoryError } from '../index.ts';
import { parsePolicy } from '../src/portable.ts';
import { previousOwnership, resolvedRelationships } from '../src/portable-ownership.ts';
import { expectedTargets, importIdentity, validateImportPlan, type ImportPlan } from '../src/portable-plan.ts';
import { tracker, snapshot, exportedPolicy, importText } from './helpers.ts';

test('independent wire origin slots reject malformed and contradictory lineage before writes', async t => {
  const source = await tracker(t);
  await remember('First origin', { ...source.options, slug: 'alpha', kind: 'reference' });
  await remember('Second origin', { ...source.options, slug: 'beta', kind: 'reference' });
  const { manifest } = await exportedPolicy(source);
  for (const slot of ['origin', 'baseline', 'mismatch']) {
    const invalid = structuredClone(manifest);
    if (slot === 'origin') Object.assign(invalid.guidance[0], { origin: {} });
    else if (slot === 'baseline') Object.assign(invalid.guidance[0].baseline!, { origin: {} });
    else invalid.guidance[0].baseline!.origin = invalid.guidance[1].origin;
    assert.throws(() => parsePolicy(invalid), MemoryError);
  }
  for (const removed of ['root', 'baseline-origin', 'baseline']) {
    const valid = structuredClone(manifest);
    if (removed === 'root') delete valid.guidance[0].origin;
    else if (removed === 'baseline-origin') delete valid.guidance[0].baseline!.origin;
    else delete valid.guidance[0].baseline;
    assert.equal(parsePolicy(valid).guidance.length, 2);
  }
});

test('SDK birth authority rejects corrupt portable bytes and unresolved graph identities', async t => {
  const target = await tracker(t); await target.store.register();
  await target.client.run('create', { options: { title: 'Invalid birth', body: 'Native body', type: 'Knowledge', memorySlug: 'bad', memoryKind: 'reference', memorySource: 'portable:policy-v1', memoryOriginal: Buffer.from('{').toString('base64') } });
  const item = (await target.store.read())[0];
  assert.equal(await previousOwnership(target.store, item, new Map()), undefined);
  const edges = [{ slug: 'bad', kind: 'related' as const }];
  assert.deepEqual(resolvedRelationships(edges, new Map()), []);
  assert.deepEqual(resolvedRelationships(edges, new Map([['bad', item.id]])), [{ id: item.id, kind: 'related' }]);
});

test('CAS lineage validation refuses malformed immutable SDK birth origins without a write', async t => {
  const source = await tracker(t); await remember('Authoritative origin', { ...source.options, slug: 'alpha', kind: 'reference' });
  const { manifest } = await exportedPolicy(source);
  const target = await tracker(t); await target.store.register();
  await target.client.run('create', { options: { title: 'Malformed origin', body: 'Retain this', type: 'Knowledge', memorySlug: 'bad', memoryKind: 'reference', memorySource: 'native:item', memoryOrigin: 'not-json' } });
  const row = (await target.client.listAllComplete()).items[0]; const before = await snapshot(target.workspace);
  await target.store.write(async () => {
    const expected = await expectedTargets(target.store, [{ id: row.id, slug: 'bad', origin: manifest.guidance[0].origin }]);
    const plan: ImportPlan = { ...(await importIdentity(target.store, 'lineage-validation')), input: 'lineage-validation', author: 'memory-test', members: [row.id], expected, mutations: [{ op: 'update', id: row.id, match: { key: 'updated_at', value: expected[0].version! }, options: { body: 'Must not write' } }], result: { imported: 0, updated: 1, unchanged: 0, unresolved_links: 0, skipped: [] } };
    await assert.rejects(validateImportPlan(target.store, plan), error => error instanceof MemoryError && error.code === 'conflict');
  });
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('legacy companion reserved file names select canonical lossless guidance before publication', async t => {
  const target = await tracker(t); await target.store.register();
  await importText(target, 'MEMORY.md', '- [Reserved source](pm-memory-origins.json)\n', 'claude-code');
  await target.client.run('create', { options: { title: 'Reserved source', body: '# Reserved source', type: 'Knowledge', memorySlug: 'pm-memory-origins', memoryKind: 'reference', memorySource: 'claude-code:relative-file', memoryPath: 'pm-memory-origins.json', memoryOriginal: Buffer.from('# Reserved source').toString('base64'), memoryEdited: false } });
  const output = join(target.root, 'output'); const receipt = await exportDir(output, { ...target.options, to: 'claude-code' });
  assert.equal(receipt.byte_preserved, 0); assert.equal(receipt.exported, 3);
  const fresh = await tracker(t); await importDir(output, { ...fresh.options, from: 'claude-code' });
  const row = (await fresh.client.listAllComplete({ includeBody: true })).items[0];
  assert.equal(row.memory_slug, 'pm-memory-origins'); assert.equal(row.body, '# Reserved source');
});

test('indexed legacy frontmatter and mixed unresolved references select faithful output', async t => {
  const source = await tracker(t); const input = join(source.root, 'input'); await mkdir(input);
  const files = { 'MEMORY.md': '- [Alpha](alpha.md)\n- [Beta](beta-file.md)\n', 'alpha.md': '---\nname: alpha\ndescription: Description\n---\nSee [[beta-file]].\n', 'beta-file.md': '---\nname: beta\n---\nReference\n' };
  for (const [name, text] of Object.entries(files)) await writeFile(join(input, name), text);
  await importDir(input, { ...source.options, from: 'claude-code' });
  const output = join(source.root, 'raw');
  assert.equal((await exportDir(output, { ...source.options, to: 'claude-code' })).byte_preserved, 3);
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(join(output, name), 'utf8'), text);
  await writeFile(join(input, 'alpha.md'), files['alpha.md'] + 'Also [[unknown]].\n');
  await importDir(input, { ...source.options, from: 'claude-code' });
  const canonical = join(source.root, 'canonical');
  assert.equal((await exportDir(canonical, { ...source.options, to: 'claude-code' })).byte_preserved, 0);
  const fresh = await tracker(t); await importDir(canonical, { ...fresh.options, from: 'claude-code' });
  const rows = (await fresh.client.listAllComplete({ includeBody: true })).items;
  const alpha = rows.find(row => row.memory_slug === 'alpha')!; const beta = rows.find(row => row.memory_slug === 'beta')!;
  assert.equal(typeof alpha.body, 'string'); assert.match(alpha.body as string, /\[\[unknown\]\]/);
  assert.equal(alpha.dependencies!.length, 1); assert.equal(alpha.dependencies![0].id, beta.id);
});
