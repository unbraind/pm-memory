import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { exportDir, importDir, remember } from '../index.ts';
import { harness, safePath } from '../src/transfer.ts';
import { Store } from '../src/store.ts';
import { tracker, snapshot } from './helpers.ts';

/** A synthetic source directory includes CRLF, BOM, YAML nesting, wiki links and a non-fact index. */
const FIXTURE: Record<string, string> = {
  'MEMORY.md': '# Durable memory\r\n\r\n- [Build](build.md)\r\n',
  'build.md': '\uFEFF---\r\nname: "Build instructions"\r\ndescription: "Deterministic build"\r\nmetadata:\r\n  type: project\r\n---\r\n\r\nRun the clean build.\r\n**Why:** Provenance matters\r\n**How to apply:** Run checks\r\nSee [[review]] and [[absent]].\r\n',
  'review.md': '---\nname: Review instructions\nmetadata:\n  type: feedback\n---\n\nUse two independent checks. See [[build]] and [[review]].\n',
  'nested/standing.md': '---\nname: Standing preference\ntype: user\n---\nUse small context packets.\n',
  'plain.md': '---\nname: Reference: heading\ndescription: Context: retained\n---\nNo frontmatter is required.\n',
};

/** Materialize only synthetic memory fixtures under an automatically removed scratch root. */
async function fixture(root: string, files = FIXTURE): Promise<string> {
  const source = join(root, 'source'); await mkdir(source);
  for (const [name, content] of Object.entries(files)) {
    const path = join(source, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, content);
  }
  return source;
}

test('Claude Code import is idempotent and exports every original file byte-identically after recall and verify metadata changes', async t => {
  const { root, options, store } = await tracker(t); const source = await fixture(root);
  const result = await importDir(source, { ...options, from: 'claude-code' });
  assert.deepEqual(result, { imported: 5, updated: 0, unchanged: 0, unresolved_links: 1 });
  const memories = await store.read(); assert.equal(memories.length, 5);
  const build = memories.find(item => item.slug === 'build')!;
  assert.equal(build.kind, 'project'); assert.equal(build.why, 'Provenance matters'); assert.equal(build.how, 'Run checks');
  assert.deepEqual(build.links, [memories.find(item => item.slug === 'review')!.id]);
  await store.fields(build.id, { recalls: 3, verdict: 'stale', verified_at: new Date().toISOString() });
  const before = await snapshot(options.workspace);
  assert.equal((await importDir(source, { ...options, from: 'claude-code' })).unchanged, 5);
  assert.deepEqual(await snapshot(options.workspace), before);
  const exported = join(root, 'export');
  assert.deepEqual(await exportDir(exported, { ...options, to: 'claude-code' }), { exported: 5, byte_preserved: 5 });
  for (const name of Object.keys(FIXTURE)) assert.ok((await readFile(join(exported, name))).equals(await readFile(join(source, name))));
  assert.equal((await exportDir(exported, { ...options, to: 'claude-code' })).exported, 5);
  await writeFile(join(source, 'review.md'), FIXTURE['review.md'] + '\nNew guidance.\n');
  assert.equal((await importDir(source, { ...options, from: 'claude-code' })).updated, 1);
  await assert.rejects(exportDir(exported, { ...options, to: 'claude-code' }), /overwrite/);
  await remember('Revised build instructions', { ...options, kind: 'project', update: 'build' });
  await assert.rejects(importDir(source, { ...options, from: 'claude-code' }), /independently edited/);
  const revised = join(root, 'revised'); await exportDir(revised, { ...options, to: 'claude-code' });
  assert.match(await readFile(join(revised, 'build.md'), 'utf8'), /Revised build instructions/);
});

test('native memories export portable Claude Code and AGENTS.md files with links', async t => {
  const { options, root, store } = await tracker(t);
  const first = await remember('Standing safety guidance', { ...options, kind: 'user', slug: 'standing', why: 'Consistency', how: 'Read first', pin: true });
  const second = await remember('Code review guidance', { ...options, kind: 'project', slug: 'review', links: [first.id] });
  const out = join(root, 'native'); assert.equal((await exportDir(out, { ...options, to: 'claude-code' })).byte_preserved, 0);
  assert.match(await readFile(join(out, 'review.md'), 'utf8'), /\[\[standing\]\]/);
  assert.match(await readFile(join(out, 'MEMORY.md'), 'utf8'), /standing.md/);
  const agents = join(root, 'agents'); await exportDir(agents, { ...options, to: 'agents-md' });
  assert.match(await readFile(join(agents, 'AGENTS.md'), 'utf8'), /Standing safety guidance/);
  const next = await tracker(t);
  const imported = await importDir(join(agents, 'AGENTS.md'), { ...next.options, from: 'agents-md' }); assert.equal(imported.imported, 1);
  const agentsOut = join(root, 'agents-out'); await exportDir(agentsOut, { ...next.options, to: 'agents-md' });
  assert.ok((await readFile(join(agentsOut, 'AGENTS.md'))).equals(await readFile(join(agents, 'AGENTS.md'))));
  const cursor = join(root, 'cursor'); await mkdir(cursor); await writeFile(join(cursor, 'memory.mdc'), '---\ndescription: Context\n---\n# Cursor guidance\nUse typed memory.');
  assert.equal((await importDir(cursor, { ...next.options, from: 'cursor' })).imported, 1);
  await store.client.update(second.id, { status: 'canceled', closeReason: 'Synthetic archive' });
  await exportDir(join(root, 'archived'), { ...options, to: 'claude-code' });
  await store.fields(first.id, { artifact: true });
  await exportDir(join(root, 'artifact'), { ...options, to: 'agents-md' });
});

test('import preflight refuses secrets, malformed data, collisions, unsupported formats and non-regular inputs without writes', async t => {
  const { root, options } = await tracker(t);
  const before = await snapshot(options.workspace);
  const source = await fixture(root, { 'safe.md': 'Valid harmless note', 'unsafe.md': '---\nname: Pipeline guidance\nmetadata:\n  type: project\n---\nUse api_key=fake0000000000000000 for testing.\n' });
  await assert.rejects(importDir(source, { ...options, from: 'claude-code' }), /Credential/);
  assert.deepEqual(await snapshot(options.workspace), before);
  for (const content of ['---\n[broken\n---\nbody', '---\n- list\n---\nbody', '---\nnull\n---\nbody', '---\ntype: unsupported\n---\nbody']) {
    await writeFile(join(source, 'unsafe.md'), content); await assert.rejects(importDir(source, { ...options, from: 'claude-code' }));
  }
  await writeFile(join(source, 'unsafe.md'), Buffer.from([255, 254])); await assert.rejects(importDir(source, { ...options, from: 'claude-code' }), /UTF-8/);
  await writeFile(join(source, 'unsafe.md'), 'A safe note'); await writeFile(join(source, 'SAFE.md'), 'A different note');
  await assert.rejects(importDir(source, { ...options, from: 'claude-code' }), /duplicate slugs/);
  await rm(join(source, 'SAFE.md')); await symlink(join(source, 'safe.md'), join(source, 'symlink.md'));
  await assert.rejects(importDir(source, { ...options, from: 'claude-code' }), /Non-regular/);
  assert.throws(() => harness('unsupported')); assert.throws(() => harness('cursor', true));
  for (const value of ['../escape', '/absolute', 'dir/../escape', 'dir//file', 'dir/./file', 'dir\\file', 'bad\0file']) assert.throws(() => safePath(value));
  assert.equal(safePath('dir/file.md'), 'dir/file.md');
  assert.deepEqual(await snapshot(options.workspace), before);
});

test('import handles empty sources, names with hashes and absent YAML fields', async t => {
  const { root, options, store } = await tracker(t);
  const empty = join(root, 'empty'); await mkdir(empty);
  assert.equal((await importDir(empty, { ...options, from: 'claude-code' })).imported, 0);
  const source = await fixture(root, { '???': '', 'plain.md': '---\nname: ""\nmetadata: scalar\n---\n', [`${'a'.repeat(121)}.md`]: '---\nname: Long stem fallback\nmetadata: {}\n---\nContent', 'array.md': '---\nname: Scalar metadata\nmetadata: null\n---\nText' });
  assert.equal((await importDir(source, { ...options, from: 'claude-code' })).imported, 4);
  assert.ok((await store.read()).some(item => item.slug.startsWith('import-')));
});

test('export refuses symlink roots, symlink parents and files rather than overwriting them', async t => {
  const { root, options, store } = await tracker(t);
  await remember('Native export fact', { ...options, kind: 'reference', slug: 'native' });
  const outside = join(root, 'outside'); await mkdir(outside);
  const linked = join(root, 'linked'); await symlink(outside, linked);
  await assert.rejects(exportDir(linked, { ...options, to: 'claude-code' }), /regular directory/);
  const out = join(root, 'out'); await mkdir(out); await symlink(outside, join(out, 'memories'));
  await assert.rejects(exportDir(out, { ...options, to: 'agents-md' }), /regular directory/);
  await rm(join(out, 'memories')); await mkdir(join(out, 'native.md'));
  await assert.rejects(exportDir(out, { ...options, to: 'claude-code' }), /overwrite/);
  const item = (await store.read())[0]; await store.fields(item.id, { kind: 'reference', source: 'claude-code:relative-file', original: Buffer.from(item.body).toString('base64'), edited: false, path: '../escape.md' });
  await assert.rejects(exportDir(join(root, 'unsafe'), { ...options, to: 'claude-code' }), /Unsafe source/);
  const rebound = new Store(options); assert.ok(rebound.client);
});

/** Direct native edits invalidate source preservation and empty files retain an explicit source identity. */
test('native semantic changes refuse re-import and empty source files round-trip exactly', async t => {
  const { root, options, store } = await tracker(t);
  const source = await fixture(root, { 'empty.md': '', 'note.md': 'Original semantic reference' });
  await importDir(source, { ...options, from: 'claude-code' });
  const output = join(root, 'original'); await exportDir(output, { ...options, to: 'claude-code' });
  assert.equal((await readFile(join(output, 'empty.md'))).length, 0);
  const item = (await store.read()).find(row => row.slug === 'note')!;
  await store.client.update(item.id, { body: 'Changed through another pm surface' });
  await assert.rejects(importDir(source, { ...options, from: 'claude-code' }), /independently edited/);
  const revised = join(root, 'native-revised'); await exportDir(revised, { ...options, to: 'claude-code' });
  assert.match(await readFile(join(revised, 'note.md'), 'utf8'), /Changed through another pm surface/);
});
