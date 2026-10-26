import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exportDir, importDir } from '../index.ts';
import type { Harness } from '../src/types.ts';
import { tracker } from './helpers.ts';

type Tracker = Awaited<ReturnType<typeof tracker>>;
/** The oracle reads SDK values directly, independently of exporter field fingerprints. */
async function semantics(target: Tracker) {
  const rows = (await target.client.listAllComplete({ includeBody: true })).items;
  return rows.filter(row => row.memory_artifact !== true && row.status !== 'canceled').map(row => ({
    slug: row.memory_slug, title: row.title, description: row.description, body: row.body,
    kind: row.memory_kind, why: row.memory_why, how: row.memory_how, pinned: row.memory_pinned, tags: row.tags,
    relationships: (row.dependencies ?? []).map(edge => {
      // The SDK reasserts author_source on a new write; it is a native attribution receipt.
      const { author_source: _assertion, ...semantic } = edge;
      return { ...semantic, id: rows.find(candidate => candidate.id === edge.id)?.memory_slug ?? edge.id };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}
/** Minimal legacy fixtures omit every optional semantic field without omitting the harness index. */
async function legacy(target: Tracker, from: Harness) {
  const path = join(target.root, 'source'); await mkdir(path);
  if (from === 'claude-code') await writeFile(join(path, 'MEMORY.md'), '- [Alpha](alpha.md)\n- [Beta](beta.md)\n');
  await writeFile(join(path, from === 'agents-md' ? 'AGENTS.md' : 'alpha.md'), '# Alpha\nPortable source\n');
  if (from === 'claude-code') await writeFile(join(path, 'beta.md'), '# Beta\nSecond portable source\n');
  await importDir(path, { ...target.options, from });
  return (await target.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === (from === 'agents-md' ? 'agents' : 'alpha'))!;
}
/** Every tested projection must recreate the complete current portable semantics. */
async function freshRoundTrip(t: Parameters<typeof tracker>[0], source: Tracker, name: string, to: 'claude-code' | 'agents-md') {
  const expected = await semantics(source); const output = join(source.root, name);
  const receipt = await exportDir(output, { ...source.options, to });
  const destination = await tracker(t); await importDir(output, { ...destination.options, from: to });
  assert.deepEqual(await semantics(destination), expected, name);
  assert.equal(receipt.byte_preserved, 0, name);
}

test('lossless export refuses stale indexed Claude bytes after absent-field native edits', async t => {
  const source = await tracker(t); const alpha = await legacy(source, 'claude-code');
  await source.client.run('update', { id: alpha.id, options: { description: 'Native retrieval hook', memoryKind: 'feedback', memoryWhy: 'Native rationale', memoryHow: 'Native application' } });
  await freshRoundTrip(t, source, 'export', 'claude-code');
});

test('fresh tracker export law covers every portable field and legacy adapter without git', async t => {
  for (const from of ['claude-code', 'agents-md', 'cursor'] as const) {
    const source = await tracker(t); const alpha = await legacy(source, from);
    const changes = { title: 'Native title', description: 'Native description', body: 'Native body\r\n', memoryKind: 'project', memoryWhy: 'Native reason', memoryHow: 'Native application', memoryPinned: true, tags: 'native,portable' };
    const oldPath = process.env.PATH; const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.PATH = source.root; process.env.GIT_CEILING_DIRECTORIES = dirname(source.root);
    try {
      for (const [field, value] of Object.entries(changes)) {
        await source.client.run('update', { id: alpha.id, options: { [field]: value } });
        for (const to of ['claude-code', 'agents-md'] as const) {
          await freshRoundTrip(t, source, `${from}-${field}-${to}`, to);
        }
        const key = field.startsWith('memory') ? `memory_${field.slice(6).toLowerCase()}` : field;
        const original = field === 'tags' ? alpha.tags.join(',') : alpha[key];
        await source.client.run('update', { id: alpha.id, options: { [field]: original } });
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    }
  }
});

test('lossless export retains native relationship additions, removals and provenance edits in a fresh tracker', async t => {
  for (const transition of ['add', 'remove', 'provenance'] as const) {
    const source = await tracker(t); const alpha = await legacy(source, 'claude-code');
    const beta = (await source.client.listAllComplete()).items.find(row => row.memory_slug === 'beta')!;
    if (transition !== 'add') {
      await writeFile(join(source.root, 'source', 'alpha.md'), '# Alpha\nPortable source [[beta]]\n');
      await importDir(join(source.root, 'source'), { ...source.options, from: 'claude-code' });
    }
    const before = await semantics(source);
    if (transition === 'provenance') await source.client.run('update', { id: alpha.id, options: { depRemove: `id=${beta.id},kind=related` } });
    await source.client.run('update', { id: alpha.id, options: transition === 'remove' ? { depRemove: `id=${beta.id},kind=related` } : { dep: `id=${beta.id},kind=${transition === 'add' ? 'supersedes' : 'related'},source_kind=native-evidence,created_at=2025-01-01T00:00:00.000Z` } });
    assert.notDeepEqual(await semantics(source), before);
    await freshRoundTrip(t, source, `graph-${transition}`, 'claude-code');
  }
});
