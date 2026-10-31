import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, copyFile, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { getItemPath, getHistoryPath, locateItem, readSettings, resolveItemTypeRegistry, serializeItemDocument } from '@unbrained/pm-cli/sdk';
import { remember, verify, exportDir, MemoryError } from '../index.ts';
import { documentHash, nativeState, observeTargets, trackerSchema } from '../src/native-revision.ts';
import { metadata } from '../src/store.ts';
import { tracker } from './helpers.ts';

test('native capture binds the exact corpus and retains SDK empty and missing states', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  const target = await tracker(t);
  const item = await remember('Frozen SDK corpus', { ...target.options, slug: 'frozen', kind: 'reference' });
  const corpus = (await target.client.listAllComplete({ includeBody: true })).items;
  const captured = await observeTargets(target.store, corpus);
  assert.deepEqual(captured.get(item.id), await nativeState(target.store, item.id));
  await target.client.update(item.id, { body: 'Native C' });
  assert.equal((await target.client.get(item.id, { full: true })).item.updated_at, corpus[0].updated_at);
  await assert.rejects(observeTargets(target.store, corpus), error => error instanceof MemoryError && error.code === 'conflict');
  const current = (await target.client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(observeTargets(target.store, [{ ...current[0], body: undefined }]), error => error instanceof MemoryError && error.code === 'conflict');
  const missing = await nativeState(target.store, 'memory-test-missing');
  assert.equal(missing.document, null); assert.equal(missing.proof.hash, null); assert.equal(missing.proof.length, 0); assert.equal(missing.proof.version, null);
  assert.equal(documentHash(null), null);
  const empty = await target.client.create({ title: 'Empty native fixture', type: 'Knowledge', body: '', ...metadata({ slug: 'empty', kind: 'reference' }) });
  const row = (await target.client.listAllComplete({ includeBody: true })).items.find(row => row.id === empty.item.id)!;
  const accepted = await observeTargets(target.store, [{ ...row, body: undefined }]);
  assert.equal(accepted.get(row.id)!.document!.body, '');
});

test('native capture refuses item/history disagreement without adopting unrecorded bytes', async t => {
  const target = await tracker(t);
  const item = await remember('Audited SDK content', { ...target.options, slug: 'audited', kind: 'reference' });
  const before = await nativeState(target.store, item.id); assert.ok(before.document);
  const settings = await readSettings(target.workspace);
  const location = await locateItem(target.workspace, item.id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder); assert.ok(location);
  const bytes = await readFile(location.itemPath);
  try {
    const changed = { ...before.document, body: 'Unrecorded native content' };
    await writeFile(location.itemPath, serializeItemDocument(changed, { schema: await trackerSchema(target.workspace) }));
    await assert.rejects(nativeState(target.store, item.id), error => error instanceof MemoryError && error.code === 'conflict');
  } finally { await writeFile(location.itemPath, bytes); }
  assert.deepEqual((await nativeState(target.store, item.id)).proof, before.proof);
});

test('the published previous-release native record remains readable and verifiable', async t => {
  const target = await tracker(t); await target.store.register();
  const fixture = JSON.parse(await readFile(new URL('./fixtures/native-revision/provenance.json', import.meta.url), 'utf8')) as { item_id: string; version: string };
  assert.equal(fixture.version, '2026.10.28');
  const settings = await readSettings(target.workspace);
  const path = getItemPath(target.workspace, 'Knowledge', fixture.item_id, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
  await copyFile(new URL('./fixtures/native-revision/released-item.toon', import.meta.url), path, constants.COPYFILE_EXCL);
  await copyFile(new URL('./fixtures/native-revision/released-history.jsonl', import.meta.url), getHistoryPath(target.workspace, fixture.item_id), constants.COPYFILE_EXCL);
  const state = await nativeState(target.store, fixture.item_id); assert.equal(state.proof.length, 1);
  assert.equal((await target.store.read())[0].body, 'Released native guidance without executable claims');
  const result = await verify({ ...target.options, root: target.root, slug: 'released' });
  assert.equal(result.checked, 1); assert.deepEqual(result.skipped, []);
  const verified = (await nativeState(target.store, fixture.item_id)).proof;
  assert.ok((await exportDir(join(target.root, 'released-export'), { ...target.options, to: 'agents-md' })).exported > 0);
  assert.deepEqual((await nativeState(target.store, fixture.item_id)).proof, verified);
});
