import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consolidate, exportDir, get, importDir, index, recall, verify } from '../index.ts';
import { contentRevision } from '../src/content.ts';
import { unsetSourceFields } from '../src/portable-ownership.ts';
import { sourceDocument } from '../src/portable-source.ts';
import { tracker, snapshot } from './helpers.ts';

for (const from of ['claude-code', 'agents-md', 'cursor'] as const) {
  test(`${from}: changed re-import preserves native archival and invalidates previous verification`, async t => {
    const { root, options, store } = await tracker(t);
    const file = join(root, 'policy.md');
    await writeFile(file, 'Original deployment policy\nUse src/removed.ts\n');
    await importDir(file, { ...options, from });
    const original = (await store.read())[0];
    assert.equal((await verify({ ...options, root })).stale, 1);
    assert.deepEqual((await consolidate({ ...options, apply: true, minAgeDays: 0 })).proposals.map(row => row.action), ['archive']);
    assert.equal((await store.read())[0].status, 'canceled');
    const revised = 'Revised deployment policy\nUse src/current.ts\n';
    await writeFile(file, revised);
    assert.deepEqual(await importDir(file, { ...options, from }), { imported: 0, updated: 1, unchanged: 0, unresolved_links: 0 });
    const memory = (await store.read())[0];
    assert.equal(memory.id, original.id);
    assert.equal(memory.status, 'canceled');
    assert.equal(memory.body, revised.trim());
    assert.equal(memory.verdict, 'unknown'); assert.equal(memory.reason, '');
    assert.equal((await store.client.get(original.id, { full: true })).item.memory_verified_at, undefined);
    assert.ok(Date.parse(memory.updated) >= Date.parse(original.updated));
    assert.equal(memory.original, original.original);
    assert.doesNotMatch((await index(options)).text ?? '', /Revised deployment policy/);
    assert.deepEqual((await recall('current', options)).memories, []);
    assert.equal((await verify({ ...options, root })).checked, 0);
    const output = join(root, 'output');
    await exportDir(output, { ...options, to: 'claude-code' });
    await assert.rejects(readFile(join(output, 'policy.md')), { code: 'ENOENT' });
    await store.client.update(original.id, { status: 'in_progress' });
    await writeFile(file, revised + 'Keep current guidance.\n');
    assert.equal((await importDir(file, { ...options, from })).updated, 1);
    assert.equal((await get('policy', options)).status, 'in_progress');
  });

  test(`${from}: unchanged re-import and source edits both retain native lifecycle ownership`, async t => {
    const { root, options, store } = await tracker(t);
    const file = join(root, 'retained.md');
    const content = 'Retained source policy\nUse src/removed.ts\n';
    await writeFile(file, content);
    await importDir(file, { ...options, from });
    await verify({ ...options, root });
    assert.equal((await consolidate({ ...options, apply: true, minAgeDays: 0 })).proposals[0].action, 'archive');
    const before = await snapshot(options.workspace);
    assert.deepEqual(await importDir(file, { ...options, from }), { imported: 0, updated: 0, unchanged: 1, unresolved_links: 0 });
    assert.deepEqual(await snapshot(options.workspace), before);
    assert.equal((await store.read())[0].status, 'canceled');
    await assert.rejects(get('retained', options), /does not exist/);
    assert.deepEqual((await recall('policy', options)).memories, []);
    const output = join(root, 'archived');
    await exportDir(output, { ...options, to: 'claude-code' });
    await assert.rejects(readFile(join(output, 'retained.md')), { code: 'ENOENT' });
    await writeFile(file, content + 'Changed guidance now applies.\n');
    assert.equal((await importDir(file, { ...options, from })).updated, 1);
    assert.equal((await store.read())[0].status, 'canceled');
    await assert.rejects(get('retained', options), /does not exist/);
  });
}


test('revision option composition preserves SDK no-ops and combines explicit field unsets', async t => {
  const target = await tracker(t); const file = join(target.root, 'alpha.md');
  await writeFile(file, 'Alpha\n**How to apply:** Original application'); await importDir(file, { ...target.options, from: 'agents-md' });
  const memory = (await target.store.read())[0]; const at = '2025-01-01T00:00:00.000Z';
  await target.store.fields(memory.id, { changed_at: at, verdict: 'stale', verified_at: at, reason: 'missing path src/retired.ts under roots' });
  const before = (await target.client.get(memory.id, { full: true })).item; const count = await target.store.history(memory.id);
  const empty: Record<string, unknown> = {}; contentRevision(empty);
  await target.client.run('update', { id: memory.id, options: { body: String(before.body), ...empty } });
  assert.deepEqual((await target.client.get(memory.id, { full: true })).item, before); assert.equal(await target.store.history(memory.id), count);
  const options: Record<string, unknown> = { body: 'Alpha', memoryHow: '' };
  contentRevision(options); unsetSourceFields(options, sourceDocument('alpha.md', Buffer.from('Alpha'), 'agents-md'));
  await target.client.run('update', { id: memory.id, options });
  const actual = (await target.client.get(memory.id, { full: true })).item;
  assert.equal(actual.body, 'Alpha'); assert.equal(actual.memory_how, undefined);
  assert.deepEqual([actual.memory_reason, actual.memory_verified_at], [undefined, undefined]); assert.equal(actual.memory_verdict, 'unknown');
});
