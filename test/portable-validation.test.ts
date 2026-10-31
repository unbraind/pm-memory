import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { exportDir, importDir, remember, renew, MemoryError } from '../index.ts';
import { parsePolicy } from '../src/portable.ts';
import { previousOwnership, resolvedRelationships, legacyBirth, creationMetadata, exportedSource } from '../src/portable-ownership.ts';
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
  const row = (await target.client.listAllComplete()).items[0];
  const compatible = await remember('Compatible native origin', { ...target.options, slug: 'compatible', kind: 'reference', forceNew: true });
  const before = await snapshot(target.workspace);
  await target.store.write(async () => {
    const expected = await expectedTargets(target.store, [{ id: row.id, slug: 'bad', origin: manifest.guidance[0].origin }]);
    const plan: ImportPlan = { ...(await importIdentity(target.store, 'lineage-validation')), input: 'lineage-validation', author: 'memory-test', members: [row.id], expected, mutations: [{ op: 'update', id: row.id, match: { key: 'updated_at', value: expected[0].version! }, options: { body: 'Must not write' } }], result: { imported: 0, updated: 1, unchanged: 0, unresolved_links: 0, skipped: [] } };
    await assert.rejects(validateImportPlan(target.store, plan), error => error instanceof MemoryError && error.code === 'conflict');
    const missing = 'memory-test-missing-origin';
    await assert.rejects(validateImportPlan(target.store, { ...plan, members: [missing], expected: [{ ...expected[0], id: missing }], mutations: [{ ...plan.mutations[0], id: missing }] }), error => error instanceof MemoryError && error.code === 'conflict');
    const unbound = await expectedTargets(target.store, [{ id: compatible.id, slug: 'compatible' }]);
    const permitted = { ...plan, members: [compatible.id], expected: unbound, mutations: [{ ...plan.mutations[0], id: compatible.id }] };
    await validateImportPlan(target.store, permitted);
    await assert.rejects(validateImportPlan(target.store, { ...permitted, expected: [{ ...unbound[0], origin: manifest.guidance[0].origin }] }), error => error instanceof MemoryError && error.code === 'conflict');
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

test('raw intake refuses bounded and differently born copies and explicitly recreates deleted origins', async t => {
  const target = await tracker(t);
  const file = await importText(target, 'alpha.md', 'Alpha instructions');
  const original = (await target.client.listAllComplete()).items[0];
  const { manifest } = await exportedPolicy(target); const origin = manifest.guidance[0].origin!;
  await target.store.fields(original.id, { pinned: true });
  await renew('alpha', { ...target.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Bounded raw intake' });
  const before = await snapshot(target.workspace);
  await assert.rejects(importDir(file, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'validity');
  assert.deepEqual(await snapshot(target.workspace), before);
  await target.client.run('delete', { id: original.id, options: { force: true } });
  await target.client.run('create', { options: { title: 'Different birth', body: 'Native copy', type: 'Knowledge', memorySlug: 'copy', memoryKind: 'reference', memorySource: 'native:item', memoryOrigin: JSON.stringify(origin) } });
  const copy = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'copy')!;
  const copied = await snapshot(target.workspace);
  await assert.rejects(importDir(file, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict');
  assert.deepEqual(await snapshot(target.workspace), copied);
  await target.client.run('delete', { id: copy.id, options: { force: true } });
  await assert.rejects(importDir(file, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'origin_missing');
  assert.equal((await importDir(file, { ...target.options, from: 'agents-md', createMissingOrigins: true })).imported, 1);
  const recreated = (await target.client.listAllComplete({ includeBody: true })).items[0];
  assert.notEqual(recreated.id, original.id); assert.equal(recreated.body, 'Alpha instructions');
  assert.deepEqual(JSON.parse(String(recreated.memory_origin)), origin);
});

test('legacy birth authority preserves foreign records on import retry and export while admitting native defaults', async t => {
  const target = await tracker(t); await target.store.register();
  const file = join(target.root, 'alpha.md'); await writeFile(file, 'Alpha instructions');
  const options = { title: 'Alpha instructions', body: 'Peer native body', type: 'Knowledge', memorySlug: 'alpha', memoryKind: 'reference', memorySource: 'agents-md:relative-file', memoryPath: 'alpha.md', memoryOriginal: Buffer.from('Alpha instructions').toString('base64') };
  await target.client.run('create', { options });
  const row = (await target.client.listAllComplete({ includeBody: true })).items[0]; const before = await snapshot(target.workspace);
  for (let retry = 0; retry < 2; retry++) {
    const receipt = await importDir(file, { ...target.options, from: 'agents-md' });
    assert.deepEqual(await snapshot(target.workspace), before);
    assert.ok('skipped' in receipt); assert.ok(receipt.skipped.some(row => row.reason.includes('Foreign')));
  }
  const exported = await exportDir(join(target.root, 'out'), { ...target.options, to: 'agents-md' });
  assert.ok(exported.skipped?.some(item => item.slug === row.id));
  assert.deepEqual(await snapshot(target.workspace), before);
  assert.equal(await legacyBirth(target.store, row.id, (await creationMetadata(target.store, row.id))!), undefined);
  const memory = (await target.store.read())[0]; assert.equal(await previousOwnership(target.store, memory, new Map()), undefined);
  for (const patch of [{ memorySlug: 'different' }, { memorySlug: 'malformed', memoryOriginal: Buffer.from('---\n[\n---\n').toString('base64') }]) {
    await target.client.run('create', { options: { ...options, ...patch } });
    const item = (await target.client.listAllComplete()).items.find(item => item.memory_slug === patch.memorySlug)!;
    assert.equal(await legacyBirth(target.store, item.id, (await creationMetadata(target.store, item.id))!), undefined);
  }
  const allowed = await tracker(t); await allowed.store.register();
  // Earlier raw records and project-native defaults remain readable: absent source fields grant no authority.
  await allowed.client.run('create', { options: { ...options, body: 'Alpha instructions\r\n', memoryPinned: true, memoryWhy: 'Native default', description: 'Native retrieval hint', tags: 'native-default', priority: 1 } });
  const native = (await allowed.client.listAllComplete({ includeBody: true })).items[0];
  assert.ok(await legacyBirth(allowed.store, native.id, (await creationMetadata(allowed.store, native.id))!));
  const nativeBefore = (await allowed.client.get(native.id, { full: true })).item;
  const unchanged = await importDir(file, { ...allowed.options, from: 'agents-md' }); assert.equal(unchanged.unchanged, 1);
  assert.deepEqual((await allowed.client.get(native.id, { full: true })).item, nativeBefore);
  await allowed.client.run('create', { options: { ...options, memorySlug: 'historical-alias', title: 'Native title at birth', body: 'Alpha instructions' } });
  const historical = (await allowed.client.listAllComplete()).items.find(item => item.memory_slug === 'historical-alias')!;
  const authority = await legacyBirth(allowed.store, historical.id, (await creationMetadata(allowed.store, historical.id))!);
  assert.ok(authority?.fields.body); assert.equal(authority.fields.title, undefined, 'Source metadata cannot claim a differing native birth field');
});


test('new imports bind content time to edited full source bytes and preserve untouched snapshot ages', async t => {
  const source = await tracker(t); const raw = await importText(source, 'alpha.md', '---\nname: alpha\ncustom: old-value\n---\nAlpha');
  const row = (await source.client.listAllComplete()).items[0];
  for (const age of [0, 29, 30, 31, 400]) {
    const old = new Date(Date.now() - age * 86400000).toISOString();
    await source.client.run('update', { id: row.id, options: { memoryChangedAt: old } });
    const exported = await exportedPolicy(source, `aged-${age}`);
    const untouched = await tracker(t); await importDir(exported.path, { ...untouched.options, from: 'agents-md' });
    assert.equal((await untouched.client.listAllComplete()).items[0].memory_changed_at, old);
    const file = join(exported.path, exported.manifest.guidance[0].path); const content = await readFile(file, 'utf8');
    await writeFile(file, content.replace('custom: old-value', 'custom: new-value'));
    const target = await tracker(t); const before = Date.now(); await importDir(exported.path, { ...target.options, from: 'agents-md' });
    const actual = (await target.client.listAllComplete({ includeBody: true })).items[0];
    assert.ok(Date.parse(String(actual.memory_changed_at)) >= before); assert.equal(actual.body, 'Alpha');
    assert.match(Buffer.from(JSON.parse(String(actual.memory_document)).original, 'base64').toString('utf8'), /custom: new-value/);
  }
  assert.match(await readFile(raw, 'utf8'), /custom: old-value/);
});

test('exported representation baselines validate before writes and older snapshots grant only proven scope', async t => {
  const target = await tracker(t); await importText(target, 'alpha.md', '---\ndescription: Hook\n---\n# Alpha\n**How to apply:** Apply\n[[beta]]');
  const { manifest } = await exportedPolicy(target); const row = manifest.guidance[0];
  assert.deepEqual(exportedSource(row), { present: ['title', 'description', 'how'], links: ['beta'] });
  for (const [key, values] of Object.entries({ sourcePresence: [null, {}, [1], ['bogus'], ['title', 'title']], sourceLinks: [null, {}, [1], ['has space'], ['beta', 'beta']] })) for (const value of values) {
    const invalid = structuredClone(manifest); Object.assign(invalid.guidance[0].baseline!, { [key]: value });
    assert.throws(() => parsePolicy(invalid), MemoryError);
  }
  delete row.baseline!.sourceLinks; assert.deepEqual(exportedSource(row).links, ['beta']);
  delete row.baseline!.sourcePresence;
  assert.deepEqual(exportedSource(row).links, ['beta']);
  const sourceFields = row.baseline!.sourceFields; delete row.baseline!.sourceFields;
  assert.deepEqual(exportedSource(row).links, ['beta']);
  row.baseline!.sourceFields = { ...sourceFields!, body: '0'.repeat(64) };
  assert.deepEqual(exportedSource(row), { present: ['description'], links: [] });
  row.document!.original = Buffer.from('---\ndescription: Hook\n---\n').toString('base64');
  assert.deepEqual(exportedSource(row), { present: ['description'], links: [] });
  delete row.baseline; assert.deepEqual(exportedSource(row), { present: ['description'], links: [] });
  row.document!.format = 'policy'; assert.deepEqual(exportedSource(row), { present: [], links: [] });
  delete row.document; assert.deepEqual(exportedSource(row), { present: [], links: [] });
});
