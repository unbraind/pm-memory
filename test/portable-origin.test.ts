import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, readHistoryEntries, writeFileAtomic, canonicalDocument, serializeItemDocument, getItemPath, resolveItemTypeRegistry, readSettings, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { ensureTrackerOrigin, readTrackerOrigin, TRACKER_ORIGIN_FILE, originCatalog, validOrigin, creator, selectOrigin, itemOrigin, originCursor, creatorMatchesOrigin } from '../src/portable-origin.ts';
import { MemoryError, remember, importDir, exportDir } from '../index.ts';
import { policyBody, POLICY_MANIFEST } from '../src/portable.ts';
import { previousOwnership } from '../src/portable-ownership.ts';
import { tracker, snapshot, crashAtStep, exportedPolicy } from './helpers.ts';

/** Metadata refusals retain foreign bytes and provide an actionable typed result. */
const refusal = (error: unknown) => error instanceof MemoryError && error.code === 'origin_missing' && error.remedy.length > 0;

test('origin publication converges after every crash and peer publication boundary on one non-git tracker', async t => {
  const source = await tracker(t); const file = join(source.workspace, TRACKER_ORIGIN_FILE);
  assert.equal(await readTrackerOrigin(source.store), undefined);
  for (const boundary of ['origin-read', 'origin-staged', 'origin-published']) {
    await assert.rejects(ensureTrackerOrigin(source.store, crashAtStep(boundary)), WorkspaceTransactionInterruptedError);
    const id = await ensureTrackerOrigin(source.store);
    assert.equal(await ensureTrackerOrigin(source.store), id);
    assert.deepEqual((await readdir(join(source.workspace, 'runtime'))).filter(name => name.startsWith('memory-origin-')), []);
    await rm(file);
    const peer = randomUUID(); let injected = false;
    const actual = await ensureTrackerOrigin(source.store, async step => {
      if (step !== boundary) return;
      injected = true; await writeFileAtomic(file, JSON.stringify({ owner: 'pm-memory-origin:1', id: peer }));
    });
    assert.ok(injected); assert.equal(actual, peer); assert.equal(await readTrackerOrigin(source.store), peer);
    await rm(file);
  }
  const one = ensureTrackerOrigin(source.store); const two = ensureTrackerOrigin(source.store);
  assert.equal(await one, await two);
});

test('tracker namespaces refuse foreign files and never overwrite or follow them', async t => {
  const source = await tracker(t); const file = join(source.workspace, TRACKER_ORIGIN_FILE);
  for (const value of ['{', 'null', '[]', '{}', JSON.stringify({ owner: 'foreign', id: randomUUID() }), JSON.stringify({ owner: 'pm-memory-origin:1', id: 3 }), JSON.stringify({ owner: 'pm-memory-origin:1', id: 'bad' }), JSON.stringify({ owner: 'pm-memory-origin:1', id: randomUUID(), extra: true })]) {
    await writeFile(file, value); const before = await snapshot(source.workspace);
    await assert.rejects(ensureTrackerOrigin(source.store), refusal); assert.deepEqual(await snapshot(source.workspace), before);
  }
  await rm(file); await mkdir(file); await assert.rejects(readTrackerOrigin(source.store), refusal); await rm(file, { recursive: true });
  const other = join(source.root, 'other'); await writeFile(other, 'foreign'); await symlink(other, file);
  await assert.rejects(ensureTrackerOrigin(source.store), refusal); assert.equal(await readFile(other, 'utf8'), 'foreign');
});

test('origin catalog uses immutable SDK creation fields and ignores foreign history subjects', async t => {
  const source = await tracker(t); const a = await remember('Origin alpha', { ...source.options, slug: 'alpha', kind: 'reference' });
  const id = await ensureTrackerOrigin(source.store); const origin = await itemOrigin(source.store, a.id);
  assert.equal(origin.tracker, id); assert.equal(origin.id, a.id); assert.ok(validOrigin(origin)); assert.ok(validOrigin({ ...origin, tracker: origin.creation }));
  const invalid: unknown[] = [null, [], {}, { ...origin, tracker: 'bad' }, { ...origin, id: '' }, { ...origin, id: 'has space' }, { ...origin, creation: 1 }, { ...origin, creation: 'x'.repeat(64) }, { ...origin, extra: true }];
  for (const value of invalid) assert.equal(validOrigin(value), false);
  await source.client.create({ title: 'Foreign Task' });
  await source.client.run('create', { options: { title: 'Malformed foreign origin', type: 'Knowledge', memorySlug: 'bad-origin', memorySource: 'foreign:tool', memoryOrigin: '{' } });
  await source.client.run('create', { options: { title: 'Unknown foreign origin', type: 'Knowledge', memorySlug: 'unknown-origin', memorySource: 'foreign:tool', memoryOrigin: '{}' } });
  const catalog = await originCatalog(source.store, undefined, 1); assert.equal(catalog.creators.length, 1);
  await source.client.run('update', { id: a.id, options: { memorySlug: 'renamed', memoryOrigin: JSON.stringify({ ...origin, id: 'replacement' }) } });
  assert.deepEqual(await itemOrigin(source.store, a.id), origin);
  const entries = await readHistoryEntries(getHistoryPath(source.workspace, a.id), a.id);
  assert.equal(creator(a.id, entries[0], undefined)!.origin.tracker, origin.creation);
  assert.equal(creator(a.id, { ...entries[0], patch: null as unknown as typeof entries[0]['patch'] }, id), undefined);
  await assert.rejects(itemOrigin(source.store, 'missing-id'), refusal);
  const live = await source.store.read(new Set([a.id]));
  assert.equal(selectOrigin(origin, live, catalog, false)!.id, a.id);
  const missingNamespace = { creators: [{ ...catalog.creators[0], origin: { ...origin, tracker: origin.creation } }] };
  assert.throws(() => selectOrigin(origin, [], missingNamespace, false), refusal);
  assert.throws(() => selectOrigin(origin, [...live, { ...live[0], id: 'copy' }], { ...catalog, creators: [...catalog.creators, { ...catalog.creators[0], id: 'copy' }] }, false), refusal);
});

test('origin continuations reject missing or repeated SDK cursors rather than guessing names', () => {
  assert.equal(originCursor({ has_more: false }), undefined);
  assert.equal(originCursor({ has_more: true, next_cursor: 'next' }), 'next');
  assert.throws(() => originCursor({ has_more: true }), refusal);
  assert.throws(() => originCursor({ has_more: true, next_cursor: 'same' }, 'same'), refusal);
});

test('failed origin publication returns a typed retry remedy and a rerun converges', async t => {
  const source = await tracker(t);
  await assert.rejects(ensureTrackerOrigin(source.store, async step => {
    if (step === 'origin-staged') for (const file of await readdir(join(source.workspace, 'runtime'))) if (file.startsWith('memory-origin-')) await rm(join(source.workspace, 'runtime', file));
  }), refusal);
  assert.ok(await ensureTrackerOrigin(source.store));
});

test('malformed foreign intake bytes close dependent skips without throwing or writing', async t => {
  for (const bytes of [Buffer.from([255]), Buffer.from('---\nbroken: [\n---\nForeign')]) {
    const source = await tracker(t); await source.store.register();
    await source.client.run('create', { options: { title: 'Foreign intake', body: 'Foreign native body', type: 'Knowledge', memorySlug: 'alpha', memorySource: 'agents-md:relative-file', memoryPath: 'alpha.md', memoryKind: 'reference', memoryOriginal: bytes.toString('base64') } });
    const directory = join(source.root, 'raw'); await mkdir(directory); await writeFile(join(directory, 'alpha.md'), 'Alpha incoming'); await writeFile(join(directory, 'beta.md'), 'Beta links [[alpha]]');
    const before = (await source.client.listAllComplete({ includeBody: true })).items;
    const result = await importDir(directory, { ...source.options, from: 'agents-md' });
    assert.ok('skipped' in result); assert.equal(result.skipped.length, 2); assert.equal(result.imported, 0);
    assert.deepEqual((await source.client.listAllComplete({ includeBody: true })).items, before);
  }
});

test('current ownership tags cannot adopt provably foreign SDK creation identities', async t => {
  for (const shape of ['task', 'task-source', 'no-slug', 'no-source', 'foreign-source']) {
    const target = await tracker(t); await target.store.register();
    await target.client.run('create', { options: { title: 'Foreign birth', body: 'Foreign body', ...(shape.startsWith('task') ? (shape === 'task-source' ? { memorySource: 'agents-md:relative-file', memorySlug: 'foreign' } : {}) : { type: 'Knowledge', memoryKind: 'reference', ...(shape === 'no-source' ? {} : { memorySource: shape === 'foreign-source' ? 'foreign:tool' : 'native:item' }), ...(shape === 'no-slug' ? {} : { memorySlug: 'foreign' }) }) } });
    const born = (await target.client.listAllComplete()).items[0];
    await target.client.run('delete', { id: born.id, options: { force: true } });
    const document = canonicalDocument({ metadata: { ...born, type: 'Knowledge', memory_slug: 'foreign', memory_source: 'native:item', memory_kind: shape === 'foreign-source' ? 'unsupported' : 'reference' }, body: 'Foreign body' });
    const registry = resolveItemTypeRegistry(await readSettings(target.workspace));
    await writeFile(getItemPath(target.workspace, 'Knowledge', born.id, 'toon', registry.type_to_folder), serializeItemDocument(document, { format: 'toon' }));
    const before = (await target.client.listAllComplete({ includeBody: true })).items;
    if (shape !== 'foreign-source') {
      const value = (await target.store.read())[0];
      assert.equal(await previousOwnership(target.store, value, new Map()), undefined);
    }
    const output = join(target.root, 'export'); const result = await exportDir(output, { ...target.options, to: 'agents-md' });
    assert.equal(result.skipped?.[0].slug, born.id); assert.match(result.skipped[0].reason, /Foreign/);
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  }
});


test('legacy history identity survives namespace initialization on the first edited import', async t => {
  for (const from of ['agents-md', 'claude-code'] as const) {
    const target = await tracker(t); const input = join(target.root, 'alpha.md'); await writeFile(input, '# Alpha\nBody A');
    await importDir(input, { ...target.options, from });
    await rm(join(target.workspace, TRACKER_ORIGIN_FILE), { force: true });
    const before = (await target.client.listAllComplete({ includeBody: true })).items[0];
    const fallback = (await originCatalog(target.store)).creators[0];
    assert.equal(fallback.origin.tracker, fallback.origin.creation);
    await writeFile(input, '# Alpha\nBody B');
    const result = await importDir(input, { ...target.options, from }); assert.equal(result.updated, 1);
    const after = (await target.client.get(before.id, { full: true })).item;
    assert.equal(after.body, '# Alpha\nBody B'); assert.equal(after.id, before.id);
    assert.equal((await importDir(input, { ...target.options, from })).unchanged, 1);
    const current = (await originCatalog(target.store)).creators[0];
    assert.ok(creatorMatchesOrigin(current, fallback.origin));
    assert.equal(creatorMatchesOrigin(current, { ...fallback.origin, id: 'wrong-item' }), false);
    assert.equal(creatorMatchesOrigin(current, { ...fallback.origin, creation: 'a'.repeat(64) }), false);
    assert.equal(creatorMatchesOrigin(current, { ...fallback.origin, tracker: randomUUID() }), false);
    assert.equal(creatorMatchesOrigin({ ...current, metadata: { ...current.metadata, memory_origin: JSON.stringify(current.origin) } }, fallback.origin), false);
    const { path, manifest } = await exportedPolicy(target);
    const row = manifest.guidance[0]; row.origin = fallback.origin; row.baseline!.origin = fallback.origin;
    await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
    await writeFile(join(path, row.path), policyBody(row, 'Portable C'));
    assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 1);
    assert.equal((await target.client.get(before.id, { full: true })).item.body, 'Portable C');

  }
});
