import assert from 'node:assert/strict';
import { test } from 'node:test';
import promises, { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { consolidate, exportDir, importDir, remember, verify, LEGACY_ORIGINS, parseLegacyOrigins } from '../index.ts';
import { privacy } from '../src/core.ts';
import { exportAncestor } from '../src/transfer.ts';
import { tracker, snapshot } from './helpers.ts';

test('archived merge sources cannot contaminate a verified surviving duplicate', async t => {
  const { options, store } = await tracker(t);
  const older = await remember('Retain identical tested guidance', { ...options, kind: 'project', slug: 'older' });
  const newer = await remember('Retain identical tested guidance', { ...options, kind: 'project', slug: 'newer', forceNew: true });
  await store.fields(older.id, { verdict: 'stale', reason: 'missing path src/removed.ts under roots', changed_at: '2020-01-01' });
  await store.fields(newer.id, { verdict: 'verified', verified_at: '2026-01-01', changed_at: '2021-01-01' });
  const before = (await store.read()).find(row => row.id === newer.id)!;
  const dry = await consolidate({ ...options, minAgeDays: 0 });
  assert.deepEqual(dry.proposals.map(row => [row.action, row.slug]), [['archive', 'older']]);
  await consolidate({ ...options, minAgeDays: 0, apply: true });
  const after = await store.read();
  assert.equal(after.find(row => row.id === older.id)!.status, 'canceled');
  assert.deepEqual(after.find(row => row.id === newer.id), before);
});

test('source directories named memories provide symbol and flag evidence while prose stays excluded', async t => {
  const { options, root } = await tracker(t);
  await mkdir(join(root, 'src', 'memories'), { recursive: true });
  await writeFile(join(root, 'src', 'memories', 'store.ts'), 'export function loadMemory() {} // --retain-memory\n');
  await writeFile(join(root, 'src', 'memories', 'guide.md'), 'fabricatedMemory() --fabricated-memory\n');
  await remember('Use `src/memories/store.ts` loadMemory() --retain-memory', { ...options, kind: 'project', slug: 'source' });
  await remember('Use `src/memories/store.ts` fabricatedMemory() --fabricated-memory', { ...options, kind: 'project', slug: 'prose', forceNew: true });
  const result = await verify({ ...options, root });
  const source = result.results.find(row => row.slug === 'source')!;
  assert.equal(source.verdict, 'verified');
  assert.equal(source.claims.find(claim => claim.type === 'symbol')!.verdict, 'verified');
  assert.equal(source.claims.find(claim => claim.type === 'flag')!.verdict, 'verified');
  assert.equal(result.results.find(row => row.slug === 'prose')!.verdict, 'stale');
});

test('agents aggregates remove archived components and replace revised sections exactly once', async t => {
  const first = await tracker(t);
  for (const slug of ['archived', 'revised', 'unchanged']) await remember(`Original ${slug} standing guidance`, { ...first.options, kind: 'project', slug, forceNew: true });
  const original = join(first.root, 'original'); await exportDir(original, { ...first.options, to: 'agents-md' });
  const heading = 'Standalone instructions\n\n';
  const repeatedComponents = await Promise.all(['archived', 'revised'].map(slug => readFile(join(original, 'memories', `${slug}.md`), 'utf8')));
  await writeFile(join(original, 'AGENTS.md'), heading + await readFile(join(original, 'AGENTS.md'), 'utf8') + repeatedComponents.join(''));
  const second = await tracker(t); await importDir(original, { ...second.options, from: 'agents-md' });
  const rows = await second.store.read();
  await second.client.update(rows.find(row => row.slug === 'archived')!.id, { status: 'canceled', closeReason: 'Synthetic archive' });
  await remember('Replacement revised standing guidance', { ...second.options, kind: 'project', update: 'revised' });
  const output = join(second.root, 'output');
  assert.deepEqual(await exportDir(output, { ...second.options, to: 'agents-md' }), { exported: 4, byte_preserved: 0 });
  const aggregate = await readFile(join(output, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(aggregate, /Original archived|Original revised|Replacement revised/);
  assert.match(await readFile(join(output, 'memories/revised.md'), 'utf8'), /Replacement revised standing guidance/);
  assert.match(await readFile(join(output, 'memories/unchanged.md'), 'utf8'), /Original unchanged standing guidance/);
  const before = (await second.client.listAllComplete({ includeBody: true })).items;
  await importDir(output, { ...second.options, from: 'agents-md' });
  assert.deepEqual((await second.client.listAllComplete({ includeBody: true })).items, before);
  const third = await tracker(t); await importDir(output, { ...third.options, from: 'agents-md' });
  const repeated = join(third.root, 'repeated');
  assert.deepEqual(await exportDir(repeated, { ...third.options, to: 'agents-md' }), { exported: 4, byte_preserved: 0 });
  assert.equal(await readFile(join(repeated, 'AGENTS.md'), 'utf8'), aggregate);
});

test('export accepts POSIX system link ancestors but refuses user links and destination links', async t => {
  const { root, options } = await tracker(t);
  const fact = await remember('Portable system directory export', { ...options, kind: 'reference' });
  const target = join(root, 'target'); await mkdir(target);
  const alias = join(root, 'alias'); await symlink(target, alias);
  const linkStat = await lstat(alias); const directoryStat = await lstat(target);
  const rootLink = Object.assign(Object.create(Object.getPrototypeOf(linkStat)) as typeof linkStat, linkStat, { uid: 0 });
  assert.equal(exportAncestor(directoryStat), true);
  assert.equal(exportAncestor(rootLink, 'win32'), false);
  assert.equal(exportAncestor(rootLink, 'linux'), true);
  assert.equal(exportAncestor(Object.assign(Object.create(Object.getPrototypeOf(linkStat)) as typeof linkStat, linkStat, { uid: 1000 }), 'linux'), false);
  const file = join(root, 'file'); await writeFile(file, 'regular file');
  assert.equal(exportAncestor(await lstat(file)), false);
  const original = promises.lstat;
  const hook = t.mock.method(promises, 'lstat', (async (...args: Parameters<typeof original>) => args[0] === alias ? rootLink : original(...args)) as typeof original);
  syncBuiltinESMExports();
  const output = join(alias, 'nested', 'output');
  try {
    await exportDir(output, { ...options, to: 'claude-code' });
    assert.ok((await readFile(join(target, 'nested', 'output', 'memories', `${fact.slug}.md`), 'utf8')).includes('Portable system directory export'));
    await assert.rejects(exportDir(alias, { ...options, to: 'claude-code' }), /regular directory/);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});


test('JWT privacy scanning preserves credential boundaries and malformed-token handling', () => {
  for (const value of ['eyJshort', 'eyJabcdefghijkl', 'eyJabcdefghijkl.short.signature', 'eyJabcdefghijkl.abcdefghijkl.short']) privacy(value);
  for (const value of ['eyJabcdefghijkl.abcdefghijkl.abcdefgh', 'prefix-eyJabcdefghijkl.abcdefghijkl.abcdefgh.', 'eyJshort eyJabcdefghijkl.abcdefghijkl.abcdefgh']) assert.throws(() => privacy(value), /Credential-shaped/);
});


test('agents aggregate preservation tolerates empty and nonembedded imported components', async t => {
  const { root, options, store, client } = await tracker(t);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'AGENTS.md'), 'Standalone instructions\n');
  await writeFile(join(source, 'empty.md'), '');
  await writeFile(join(source, 'separate.md'), 'Separate standing guidance\n');
  await importDir(source, { ...options, from: 'agents-md' });
  const separate = (await store.read()).find(row => row.path === 'separate.md')!;
  await client.update(separate.id, { status: 'canceled', closeReason: 'Synthetic archive' });
  const output = join(root, 'output');
  assert.deepEqual(await exportDir(output, { ...options, to: 'agents-md' }), { exported: 3, byte_preserved: 2 });
  assert.equal(parseLegacyOrigins(JSON.parse(await readFile(join(output, LEGACY_ORIGINS), 'utf8')), 'agents-md').length, 2);
  assert.equal(await readFile(join(output, 'AGENTS.md'), 'utf8'), 'Standalone instructions\n');
  assert.equal((await readFile(join(output, 'empty.md'))).length, 0);
});
