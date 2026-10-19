import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, delimiter, relative, basename } from 'node:path';
import { remember, verify } from '../index.ts';
import { checkClaim, extractClaims, suffixIndex } from '../src/verify.ts';
import { tracker } from './helpers.ts';

test('round three classifies complete tokens with positive and negative fixtures for every path rule', () => {
  for (const value of ['source.ts', 'config.jsonl', './folder', '../folder', '/absolute/folder', '~/folder', 'src/contracts', 'scripts/build', 'test/suite', 'docs/guide', '.github/workflows', '.agents/pm', 'deep/src/contracts']) {
    assert.equal(extractClaims(`Use \`${value}\``)[0]?.type, 'file', value);
  }
  for (const value of ['unbraind/pm-vcs', 'owner/repository']) assert.deepEqual(extractClaims(`Use \`${value}\``), [{ type: 'repo', value }]);
  for (const text of ['--provider/--model', 'clients.filter/find', 'process.env', 'console.log', 'client.filter()', 'JSON.stringify()', 'release-policy', 'unqualified/', 'folder/noext/deep']) assert.deepEqual(extractClaims(text), [], text);
  assert.deepEqual(extractClaims('https://example.test/src/source.ts'), [{ type: 'url', value: 'https://example.test/src/source.ts' }]);
  for (const text of ['@scope/pkg/sdk/contracts', 'package sdk/contracts', 'npm sdk/contracts', 'subpath `sdk/contracts`', '@scope/pkg/ sdk/contracts']) {
    const claims = extractClaims(text); assert.ok(claims.length > 0); assert.ok(claims.every(claim => claim.type === 'package'));
  }
  for (const value of [join('/', 'tmp', 'task/src/source.ts'), join('/', 'var', 'tmp', 'task/source.ts'), 'scratch/src/source.ts', 'mktemp-project/src/source.ts', 'compat/copyA', 'compat/copyB']) assert.equal(extractClaims(`Use \`${value}\``)[0]?.uncertainty, 'Temporary, historical or hypothetical path mention');
  for (const text of ['Removed `src/old.ts` yesterday.', 'Example: `scripts/sample.ts`.', 'We could add `src/next.ts`.', 'Do not use `src/legacy.ts`.', 'The file `src/absent.ts` does not exist.']) assert.ok(extractClaims(text)[0].uncertainty);
  assert.equal(extractClaims('Use `scripts/removed.ts` today.')[0].uncertainty, undefined);
  const portable = relative(homedir(), join(homedir(), 'synthetic/src/core.ts'));
  assert.equal(extractClaims(`Use \`${join(homedir(), 'synthetic/src/core.ts')}\``)[0].value, portable);
  assert.equal(extractClaims('Use `~/synthetic/src/core.ts`')[0].value, portable);
  assert.equal(extractClaims('Use `~/synthetic/src/core.ts`')[0].home, true);
  for (const value of ['Node.js', 'Vue.member/find']) assert.deepEqual(extractClaims(value), []);
  for (const text of ['Read `src/*.ts`.', 'Use $HOME/.agents/pm.', 'Scratchpad tool.ts', 'Edit config/schema.', 'Use test/foo.test.ts', 'Use ./x.js', 'Use src/{one,two}.ts', 'Use src/<name>/entry.ts', 'Read CHANGELOG.md/NOTES.md', 'Not in sdk/runtime.d.ts', 'node_modules/pkg exports ./lib/version.cjs', 'gitignore block contains `.pm/runtime/`', '```ts\nRead src/invented.ts\n```', 'Use `./workspace/.cache/`', 'Use `.agents/pm/tmp/x`', 'Read `history/.jsonl`', 'Data files (one/two/three.json)', `pgrep -u worker -f 'global/bin/pm'`, 'pkill -f "global/bin/pm"', 'The parser accepts todo.txt records.', 'Use `*-notes.md`', 'File `scripts/new.mjs`:\n```js\ncode\n```']) assert.ok(extractClaims(text).find(claim => claim.type === 'file')?.uncertainty, text);
  assert.equal(extractClaims('Example `src/fixture.ts`.\nUse `src/fixture.ts`.').length, 2);
  assert.equal(extractClaims('Use `src/contracts` absentCall()').find(claim => claim.type === 'symbol')?.context, undefined);
});

test('round three suffix resolution handles nested, truncated home, basename ambiguity and tracker path names', async t => {
  const { root, options } = await tracker(t);
  for (const path of ['fleet/nested/src', 'fleet/nested/.agents/pm/runtime', 'fleet/nested/empty', 'different']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'fleet/nested/src/entry.ts'), 'export const live = true;');
  await writeFile(join(root, 'fleet/nested/.agents/pm/runtime/usage.jsonl'), '{}');
  await writeFile(join(root, 'different/shared.ts'), 'shared');
  await remember('Read `src/entry.ts`, `runtime/usage.jsonl` and `./nested/empty`.', { ...options, kind: 'project', slug: 'suffix' });
  const result = await verify({ ...options, root }); assert.equal(result.stale, 0); assert.equal(result.results[0].verdict, 'verified');
  for (const value of ['src/entry.ts', 'runtime/usage.jsonl', 'nested/empty', join(basename(root), 'fleet/nested/src/entry.ts')]) assert.equal((await checkClaim({ type: 'file', value }, root, false)).verdict, 'verified');
  const homeIndex = suffixIndex([join(homedir(), 'synthetic/project')], [['src/entry.ts']]);
  assert.equal(homeIndex.get('synthetic/project/src/entry.ts'), 'src/entry.ts');
  assert.equal(homeIndex.get('project/src/entry.ts'), 'src/entry.ts');
  assert.equal(homeIndex.get('synthetic/project'), '.');
  assert.ok(![...homeIndex.keys()].some(key => key.startsWith(homedir())));
  assert.throws(() => suffixIndex(['root'], [['src/entry.ts']], 0), /bounded search limit/);
  const ambiguous = await checkClaim({ type: 'file', value: 'src/shared.ts' }, root, false);
  assert.equal(ambiguous.verdict, 'unknown'); assert.equal(ambiguous.reason, 'basename found elsewhere: different/shared.ts');
  assert.equal((await checkClaim({ type: 'file', value: 'scripts/gone.mjs' }, root, false)).verdict, 'stale');
  assert.equal((await checkClaim({ type: 'file', value: '~/outside-roots/entry.ts' }, root, false)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'file', value: 'compat/copyA' }, root, false)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'file', value: 'src/history.ts', uncertainty: 'Historical mention' }, root, false)).verdict, 'unknown');
  const outside = await tracker(t); await writeFile(join(outside.root, 'external.ts'), 'external');
  await symlink(join(outside.root, 'external.ts'), join(root, 'fleet/nested/src/link.ts'));
  assert.equal((await checkClaim({ type: 'file', value: 'link.ts' }, root, false)).verdict, 'unknown');
  const originalHome = process.env.HOME; process.env.HOME = root;
  t.after(() => { process.env.HOME = originalHome; });
  const homeClaim = await checkClaim({ type: 'file', value: '~/fleet/nested/src/entry.ts' }, root, false);
  assert.equal(homeClaim.verdict, 'verified'); assert.equal(homeClaim.value, 'fleet/nested/src/entry.ts');
  assert.equal((await checkClaim({ type: 'file', value: 'src/uncreated.ts', home: true }, root, false)).verdict, 'stale');
  assert.equal(suffixIndex([root], [['src/entry.ts']]).get('src/entry.ts'), 'src/entry.ts');
  const previousDirectory = process.cwd();
  try { process.chdir(root); assert.equal((await verify(options)).stale, 0); } finally { process.chdir(previousDirectory); }
});

test('round three never treats repository or package-subpath claims as local file absence', async t => {
  const { root, options } = await tracker(t);
  await remember('Use `unbraind/pm-vcs`, @scope/pkg/sdk/contracts, `--provider/--model`, and `clients.filter/find`.', { ...options, kind: 'reference', slug: 'nonfiles' });
  const result = await verify({ ...options, root }); assert.equal(result.stale, 0); assert.equal(result.results[0].verdict, 'unknown');
  assert.deepEqual(result.results[0].claims.map(claim => claim.type), ['repo', 'package']);
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nif [ "$6" = "owner/present" ] && [ "$1" = repo ] && [ "$2" = view ] && [ "$3" = --json ] && [ "$5" = -- ]; then echo present; else exit 1; fi\n'); await chmod(join(bin, 'gh'), 0o755);
  const priorPath = process.env.PATH;
  t.after(() => { process.env.PATH = priorPath; });
  process.env.PATH = [bin, priorPath].join(delimiter);
  assert.equal((await checkClaim({ type: 'repo', value: 'owner/present' }, root, false)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'repo', value: 'owner/present' }, root, true)).verdict, 'verified');
  assert.equal((await checkClaim({ type: 'repo', value: 'owner/absent' }, root, true)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'repo', value: '-bmain/x' }, root, true)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'package', value: '@scope/pkg/sdk/contracts' }, root, true)).verdict, 'unknown');
});


test('round three indexed paths that disappear remain unknown', async t => {
  const { root } = await tracker(t);
  const source = { roots: [root], files: [[]], directories: [[]], suffixes: new Map([['src/raced.ts', 'src/raced.ts']]) };
  const result = await checkClaim({ type: 'file', value: 'src/raced.ts' }, root, false, source);
  assert.equal(result.verdict, 'unknown'); assert.equal(result.reason, 'Indexed path changed during verification');
});
