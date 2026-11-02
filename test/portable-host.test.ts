import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { importDir, MemoryError } from '../index.ts';
import { nativeState } from '../src/native-revision.ts';
import { nativeHost, nativePeer } from './native-host-helpers.ts';
import { tracker, snapshot } from './helpers.ts';

/** Use raw owned sources to exercise actual host creation and native update dispatch. */
async function source(t: Parameters<typeof tracker>[0], existing: boolean) {
  const target = await tracker(t); const path = join(target.root, 'source'); await mkdir(path);
  await writeFile(join(path, 'alpha.md'), 'Alpha A');
  if (existing) await importDir(path, { ...target.options, from: 'agents-md' });
  await writeFile(join(path, 'alpha.md'), 'Alpha B');
  return { ...target, path };
}

for (const existing of [false, true]) test(`portable host ${existing ? 'update' : 'create'} honors every active mutation policy`, async t => {
  const target = await source(t, existing); let denied = 0; let publishing = false;
  await nativeHost(target.workspace, async client => {
    await assert.rejects(importDir(target.path, { ...target.options, client, from: 'agents-md', onStep: step => { if (step === 'intent') publishing = true; } }), error => error instanceof MemoryError && error.code === 'transaction' && error.cause instanceof Error && /policy|guard/iu.test(error.cause.message));
  }, context => {
    if (publishing && context.after?.metadata.memory_slug === 'alpha') { denied++; return { allow: false, code: 'test_portable_policy', remediation: 'Retain native guidance' }; }
  });
  assert.equal(denied, 1);
  const rows = (await target.client.listAllComplete({ includeBody: true })).items;
  assert.equal(rows.length, existing ? 1 : 0);
  if (existing) assert.equal(rows[0].body, 'Alpha A');
});

for (const existing of [false, true]) test(`portable host ${existing ? 'update' : 'create'} refuses an inactive publication guard`, async t => {
  const target = await source(t, existing);
  const before = await snapshot(target.workspace);
  const client = new PmClient({ pmRoot: target.workspace, noExtensions: true });
  await assert.rejects(importDir(target.path, { ...target.options, client, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'host_guard');
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('portable host guard refuses an independent same-timestamp ABA before publication', async t => {
  const target = await source(t, true); const item = (await target.client.listAllComplete({ includeBody: true })).items[0];
  const saved = await nativeState(target.store, item.id); let intervened = false;
  await nativeHost(target.workspace, async client => {
    const result = await importDir(target.path, { ...target.options, client, from: 'agents-md', onStep: step => {
      if (step === 'intent') { intervened = true; nativePeer({ ...target, id: item.id }, saved.proof.version!, saved.document!.body); }
    } });
    assert.equal(result.updated, 0); assert.ok('skipped' in result); assert.equal(result.skipped.length, 1);
  });
  assert.equal(intervened, true); assert.equal((await target.client.get(item.id, { full: true })).item.body, 'Alpha A');
});

for (const existing of [false, true]) test(`portable host ${existing ? 'update' : 'create'} publishes through the attested SDK guard`, async t => {
  const target = await source(t, existing); let guards = 0;
  await nativeHost(target.workspace, async client => {
    const result = await importDir(target.path, { ...target.options, client, from: 'agents-md', onStep: step => { if (step === 'write-guard') guards++; } });
    assert.equal(result[existing ? 'updated' : 'imported'], 1);
  }, context => {
    if (resolve(context.pm_root) !== resolve(target.workspace)) return { allow: false, code: 'test_foreign_projection', remediation: 'Only the actual target tracker is authorized' };
  });
  assert.ok(guards > 0);
  const rows = (await target.client.listAllComplete({ includeBody: true })).items;
  assert.equal(rows.length, 1); assert.equal(rows[0].body, 'Alpha B');
});
