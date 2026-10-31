import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import promises, { mkdir, readFile, writeFile, stat, rename, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { remember, recall, consolidate, importDir, exportDir, verify } from '../index.ts';
import { proposals } from '../src/consolidate.ts';
import { scored } from '../src/memory.ts';
import { checkClaim, extractClaims, directoryEvidence, searchClaims } from '../src/verify.ts';
import { tracker, snapshot } from './helpers.ts';

test('review tracker describes the eight documented commands without rewriting history', async () => {
  const epic = decodeToon(await readFile(new URL('../.agents/pm/epics/pm-memory-0kwy.toon', import.meta.url), 'utf8')) as { acceptance_criteria: string; comments: { text: string }[] };
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal([...readme.matchAll(/^\| (?:remember|recall|get|index|import|export|verify|consolidate) \|/gm)].length, 8);
  assert.match(epic.acceptance_criteria, /^Eight commands/);
  assert.match(epic.comments[1].text, /all eight commands/);
});

test('supersession never targets a memory archived by the same plan', async t => {
  const { options, store } = await tracker(t);
  await remember('Feature policy\nEnable audit logging', { ...options, kind: 'project', slug: 'old' });
  const target = await remember('Feature policy\nDisable audit logging', { ...options, kind: 'project', slug: 'new', forceNew: true });
  await store.fields(target.id, { verdict: 'stale', reason: 'missing path src/removed.ts under roots' });
  const dry = await consolidate({ ...options, minAgeDays: 0 });
  assert.ok(dry.proposals.some(row => row.action === 'archive' && row.slug === 'new'));
  assert.ok(!dry.proposals.some(row => row.action === 'supersedes'));
  await consolidate({ ...options, minAgeDays: 0, apply: true });
  const rows = await store.read();
  assert.equal(rows.find(row => row.slug === 'new')!.status, 'canceled');
  assert.ok(!rows.find(row => row.slug === 'new')!.links.includes(rows.find(row => row.slug === 'old')!.id));
});

test('supersession is link-only and disappears from subsequent consolidation plans', async t => {
  const { options, store } = await tracker(t);
  const old = await remember('Feature policy\nEnable audit logging', { ...options, kind: 'project', slug: 'old' });
  const newer = await remember('Feature policy\nDisable audit logging', { ...options, kind: 'project', slug: 'new', forceNew: true });
  await store.link(newer.id, old.id);
  assert.equal((await consolidate(options)).proposals[0]?.action, 'supersedes');
  await consolidate({ ...options, apply: true });
  const rows = await store.read();
  assert.ok(rows.every(row => row.status !== 'canceled'));
  assert.deepEqual(rows.find(row => row.id === newer.id)!.supersedes, [old.id]);
  assert.deepEqual((await consolidate(options)).proposals, []);
  assert.deepEqual(proposals(rows.map(row => ({ ...row, supersedes: undefined }))).map(row => row.action), ['supersedes']);
});

test('ranking query work grows linearly while preserving lexical scores', async t => {
  const { options, store } = await tracker(t);
  await remember('Needle ranking corpus', { ...options, kind: 'project', slug: 'base' });
  const base = (await store.read())[0];
  const memories = Array.from({ length: 100 }, (_, i) => ({ ...base, slug: `row-${i}` }));
  let reads = 0; const has = Set.prototype.has;
  const hook = t.mock.method(Set.prototype, 'has', function (this: Set<unknown>, value: unknown) { if (value === 'needle') reads++; return has.call(this, value); });
  const ranked = scored(memories, 'needle'); hook.mock.restore();
  assert.equal(ranked.length, 100);
  assert.ok(reads <= 600, `query membership reads: ${reads}`);
  const expected = 5 * Math.log(1 + 100 / 101) / (1 + Math.log(1 + 5) / 10) * 10;
  assert.ok(Math.abs(ranked[0].score - expected - 0.2) < 0.001);
});

test('recall preflights every emitted counter before writing any increments', async t => {
  const { options, store } = await tracker(t);
  await remember('Needle first ranked memory', { ...options, kind: 'project', slug: 'first', pin: true });
  const second = await remember('Other lower ranked guidance', { ...options, kind: 'reference', slug: 'second' });
  await store.fields(second.id, { recalls: Number.MAX_SAFE_INTEGER });
  const before = await snapshot(options.workspace);
  await assert.rejects(recall('needle', { ...options, budget: 1500 }), /Recall counter exhausted/);
  assert.deepEqual(await snapshot(options.workspace), before);
  assert.equal((await store.read()).find(row => row.slug === 'first')!.recalls, 0);
});

test('export creates nested parents before staging', async t => {
  const { root, options } = await tracker(t);
  await remember('Portable exported guidance', { ...options, kind: 'reference', slug: 'guide' });
  const out = join(root, 'missing', 'nested', 'out');
  await exportDir(out, { ...options, to: 'claude-code' });
  assert.match(await readFile(join(out, 'memories/guide.md'), 'utf8'), /Portable exported guidance/);
  await exportDir(out, { ...options, to: 'claude-code' });
});

test('export publishes normal umask directory permissions', async t => {
  const { root, options } = await tracker(t);
  const out = join(root, 'out');
  await exportDir(out, { ...options, to: 'claude-code' });
  assert.equal((await stat(out)).mode & 0o777, 0o777 & ~process.umask());
});

test('export index escapes titles and destinations and preserves current angle links byte-identically', async t => {
  const { root, options } = await tracker(t);
  const source = join(root, 'source'); await mkdir(source);
  const name = 'my notes (one)<two>#%.md';
  await writeFile(join(source, name), '---\nname: "Title] with [brackets\\nand newline"\n---\nPortable guidance\n');
  await importDir(source, { ...options, from: 'claude-code' });
  const generated = join(root, 'projected-export');
  const generatedResult = await exportDir(generated, { ...options, to: 'claude-code' });
  assert.equal(generatedResult.byte_preserved, 0);
  const index = await readFile(join(generated, 'MEMORY.md'), 'utf8');
  assert.match(index, /pm-memory-policy:v1/);
  assert.doesNotMatch(index, /Title|newline|\] with/);
  // A genuinely lossless legacy index keeps its original angle destinations.
  const custom = '# Custom heading\n- [Title](<my%20notes%20%28one%29%3Ctwo%3E%23%25.md>)\n';
  await writeFile(join(source, 'MEMORY.md'), custom);
  const second = await tracker(t); await importDir(source, { ...second.options, from: 'claude-code' });
  const next = join(root, 'next');
  assert.equal((await exportDir(next, { ...second.options, to: 'claude-code' })).byte_preserved, 2);
  assert.equal(await readFile(join(next, 'MEMORY.md'), 'utf8'), custom);
  await writeFile(join(source, 'MEMORY.md'), '- [Broken](bad%.md)\n');
  const third = await tracker(t); await importDir(source, { ...third.options, from: 'claude-code' });
  const before = (await third.client.listAllComplete({ includeBody: true })).items;
  const repaired = join(root, 'repaired');
  assert.equal((await exportDir(repaired, { ...third.options, to: 'claude-code' })).byte_preserved, 0);
  assert.equal(await readFile(join(repaired, 'MEMORY.md'), 'utf8'), index);
  await importDir(repaired, { ...third.options, from: 'claude-code' });
  assert.deepEqual((await third.client.listAllComplete({ includeBody: true })).items, before);
});

test('last-line file claims after closed fences retain confident absence', async t => {
  const { root } = await tracker(t);
  for (const fence of ['```', '~~~']) {
    const claim = extractClaims(`${fence}ts\nconst value = 1;\n${fence}\nUse \`src/absent.ts\``)[0];
    assert.equal(claim.uncertainty, undefined);
    assert.equal((await checkClaim(claim, root, false)).verdict, 'stale');
  }
});

test('inventory rechecks queued directories before descending after a symlink swap', async t => {
  const { root } = await tracker(t); const outside = await tracker(t);
  await mkdir(join(root, 'queued')); await mkdir(join(outside.root, 'marker')); await writeFile(join(outside.root, 'escape.ts'), 'externalOnly');
  const read = promises.readdir;
  const hook = t.mock.method(promises, 'readdir', (async (path: Parameters<typeof read>[0], options: Parameters<typeof read>[1]) => {
    const entries = await read(path, options);
    if (path === join(root, '')) { await rename(join(root, 'queued'), join(root, 'saved')); await symlink(outside.root, join(root, 'queued')); }
    return entries;
  }) as typeof read);
  syncBuiltinESMExports();
  try { assert.ok(!(await directoryEvidence(root)).includes('queued/marker')); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test('text evidence refuses raced file and directory symlinks outside the root', async t => {
  const { root } = await tracker(t); const outside = await tracker(t);
  await writeFile(join(outside.root, 'secret.ts'), 'externalOnly');
  await symlink(join(outside.root, 'secret.ts'), join(root, 'file.ts'));
  await symlink(outside.root, join(root, 'parent'));
  for (const file of ['file.ts', 'parent/secret.ts']) {
    const source = { roots: [root], files: [[file]], directories: [[]], suffixes: new Map<string, string>(), matches: new Map<string, boolean | undefined>() };
    await assert.rejects(searchClaims([{ type: 'symbol', value: 'externalOnly()' }], source), /Source escapes the declared root/);
    assert.equal(source.matches.get('externalOnly'), false);
  }
});

test('text evidence opens with no-follow even if a regular file is swapped at open time', async t => {
  const { root } = await tracker(t); const outside = await tracker(t);
  const path = join(root, 'source.ts'); await writeFile(path, 'local'); await writeFile(join(outside.root, 'external.ts'), 'externalOnly');
  const open = promises.open;
  const hook = t.mock.method(promises, 'open', (input: Parameters<typeof open>[0], options: Parameters<typeof open>[1]) => {
    fs.unlinkSync(path); fs.symlinkSync(join(outside.root, 'external.ts'), path);
    return open(input, options);
  });
  syncBuiltinESMExports();
  const source = { roots: [root], files: [['source.ts']], directories: [[]], suffixes: new Map<string, string>(), matches: new Map<string, boolean | undefined>() };
  try {
    await assert.rejects(searchClaims([{ type: 'symbol', value: 'externalOnly()' }], source), /could not be read/);
    assert.equal(source.matches.get('externalOnly'), false);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});


test('verification refuses a symlink root rather than treating an unsearched tree as absent', async t => {
  const { root, options } = await tracker(t); const outside = await tracker(t);
  await writeFile(join(outside.root, 'source.ts'), 'presentSymbol');
  const alias = join(root, 'alias'); await symlink(outside.root, alias);
  await assert.rejects(directoryEvidence(alias), /Verification root is not a regular directory/);
  await remember('Use `source.ts` presentSymbol()', { ...options, kind: 'project', slug: 'root-evidence' });
  assert.equal((await verify({ ...options, root: outside.root })).results[0].verdict, 'verified');
  const before = await snapshot(options.workspace);
  await assert.rejects(verify({ ...options, root: alias }), /Verification root is not a regular directory/);
  assert.deepEqual(await snapshot(options.workspace), before);
});
