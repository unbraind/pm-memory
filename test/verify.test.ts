import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, writeFile, symlink, chmod } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { remember, verify } from '../index.ts';
import { checkClaim, extractClaims } from '../src/verify.ts';
import { tracker } from './helpers.ts';

test('extractor finds each supported claim type and deduplicates repeated evidence', () => {
  const claims = extractClaims('Use `src/core.ts`, `package.json`, checkClaim(), --json and @scope/example@1.2.3-beta.1; https://example.test/docs. Repeat --json.');
  for (const type of ['file', 'symbol', 'flag', 'package', 'url']) assert.ok(claims.some(claim => claim.type === type));
  assert.equal(claims.filter(claim => claim.value === '--json').length, 1);
  assert.deepEqual(extractClaims('No concrete claims here'), []);
});

test('verification differentiates stale, verified and unknown with native audit writes', async t => {
  const { options, root, store } = await tracker(t);
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'entry.ts'), 'export function example() { return "--sample-flag"; }\n');
  await remember('Local verified evidence: `src/entry.ts` example() --sample-flag', { ...options, kind: 'project', slug: 'verified' });
  await remember('Stale references: `src/missing.ts` missingSymbol() --missing-flag', { ...options, kind: 'project', slug: 'stale' });
  await remember('General personal preference', { ...options, kind: 'user', slug: 'unknown' });
  await remember('Version claim: example@1.2.3 https://example.test/docs', { ...options, kind: 'reference', slug: 'network' });
  const result = await verify({ ...options, root }); assert.equal(result.checked, 4); assert.equal(result.stale, 1);
  assert.equal(result.results.find(row => row.slug === 'verified')!.verdict, 'verified');
  assert.equal(result.results.find(row => row.slug === 'unknown')!.verdict, 'unknown');
  assert.equal(result.results.find(row => row.slug === 'network')!.verdict, 'unknown');
  assert.equal((await store.read()).find(row => row.slug === 'stale')!.verdict, 'stale');
  assert.equal((await verify({ ...options, root, slug: 'verified' })).checked, 1);
  await assert.rejects(verify({ ...options, root, slug: 'absent' }), /does not exist/);
  await assert.rejects(verify({ ...options, root: join(root, 'src', 'entry.ts') }), /not a directory/);
  assert.equal((await checkClaim({ type: 'file', value: '/absolute/file.ts' }, root, false)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'file', value: '../escape.ts' }, root, false)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'file', value: 'src' }, root, false)).verdict, 'verified');
  assert.equal((await checkClaim({ type: 'file', value: 'src/entry.ts/missing.ts' }, root, false)).verdict, 'stale');
  const outside = await tracker(t); await writeFile(join(outside.root, 'outside.ts'), 'outside');
  await symlink(join(outside.root, 'outside.ts'), join(root, 'src', 'link.ts'));
  assert.equal((await checkClaim({ type: 'file', value: 'src/link.ts' }, root, false)).verdict, 'unknown');
  await assert.rejects(checkClaim({ type: 'symbol', value: 'nope()' }, join(root, 'absent'), false), /Verification root could not be read/);
});

test('network URL evidence uses a real HTTP server and classifies unavailable or denied endpoints as unknown', async t => {
  const server = createServer((request, response) => { response.statusCode = request.url === '/ok' ? 200 : request.url === '/missing' ? 404 : request.url === '/gone' ? 410 : 403; response.end(); });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const [path, expected] of [['ok', 'verified'], ['missing', 'stale'], ['gone', 'stale'], ['denied', 'unknown']] as const) assert.equal((await checkClaim({ type: 'url', value: `${origin}/${path}` }, '.', true)).verdict, expected);
  assert.equal((await checkClaim({ type: 'url', value: 'invalid-url' }, '.', true)).verdict, 'unknown');
});

test('npm evidence uses safe exact version arguments only with explicit network opt-in', async t => {
  const { root } = await tracker(t); const bin = join(root, 'bin'); await mkdir(bin);
  const executable = join(bin, 'npm');
  await writeFile(executable, '#!/bin/sh\ncase "$2" in\n good@1.2.3) echo \'"1.2.3"\';;\n missing@1.2.3) echo E404 >&2; exit 1;;\n *) echo ENETWORK >&2; exit 1;;\nesac\n'); await chmod(executable, 0o755);
  const previous = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previous}`; t.after(() => { process.env.PATH = previous; });
  assert.equal((await checkClaim({ type: 'package', value: 'good@1.2.3' }, root, true)).verdict, 'verified');
  assert.equal((await checkClaim({ type: 'package', value: 'missing@1.2.3' }, root, true)).verdict, 'stale');
  assert.equal((await checkClaim({ type: 'package', value: 'offline@1.2.3' }, root, true)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'package', value: 'good@1.2.3' }, root, false)).verdict, 'unknown');
});
