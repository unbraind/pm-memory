import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { get, importDir, exportDir, remember, recall, verify, MemoryError, packetTokens } from '../index.ts';
import { extractClaims, checkClaim, directoryEvidence } from '../src/verify.ts';
import { proposals } from '../src/consolidate.ts';
import { recallPacket, rank } from '../src/memory.ts';
import { tracker, snapshot } from './helpers.ts';

test('verify classifier resolves nested repositories and repeatable roots with conservative absence reasons', async t => {
  const { root, options } = await tracker(t); const other = await tracker(t);
  for (const dir of ['fleet/nested/.github/workflows', 'fleet/nested/src', 'fleet/nested/node_modules/dependency', 'fleet/nested/dist', 'fleet/nested/coverage', 'fleet/nested/.git', 'fleet/nested/empty-dir']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'fleet/nested/.github/workflows/release.yml'), 'name: Release');
  await writeFile(join(root, 'fleet/nested/tsconfig.json'), '{}');
  await writeFile(join(root, 'fleet/nested/src/index.ts'), 'export const localFunction = () => "--local-flag";');
  await writeFile(join(other.root, 'shared.ts'), 'Shared source');
  for (const dir of ['node_modules/dependency', 'dist', 'coverage', '.git']) await writeFile(join(root, `fleet/nested/${dir}/excluded.ts`), 'excludedSymbol --excluded-flag');
  await remember('Nested evidence `release.yml` `tsconfig.json` `index.ts` `src/index.ts` localFunction() --local-flag --sort --stdout --merged --pm-root `shared.ts`', { ...options, kind: 'project', slug: 'nested' });
  await remember('Runtime guidance randomUUID() setTimeout() unknownRuntime() --unknown-context', { ...options, kind: 'project', slug: 'runtime' });
  await remember('Use explicit source `src/deleted.ts`', { ...options, kind: 'project', slug: 'missing' });
  const result = await verify({ ...options, root: [root, join(root, 'fleet/nested'), other.root] });
  assert.equal(result.stale, 1);
  assert.ok(result.results.find(row => row.slug === 'nested')!.claims.every(claim => claim.verdict !== 'stale'));
  for (const value of ['release.yml', 'tsconfig.json', 'index.ts', 'src/index.ts', 'shared.ts', '--sort']) assert.equal(result.results.find(row => row.slug === 'nested')!.claims.find(claim => claim.value === value)!.verdict, 'verified');
  assert.equal(result.results.find(row => row.slug === 'runtime')!.verdict, 'unknown');
  assert.match(result.results.find(row => row.slug === 'missing')!.claims[0].reason!, /not found under the given roots \(add --root if it lives elsewhere\)/);
  assert.deepEqual(extractClaims('randomUUID() fetch() require() JSON.stringify() Math.random()'), []);
  assert.deepEqual(extractClaims('Check `deleted-dir/`'), []);
  assert.equal(extractClaims('https://example.test/docs/file.ts').filter(claim => claim.type === 'file').length, 0);
  await assert.rejects(verify({ ...options, root: [] }), /No verification roots/);
  assert.equal((await checkClaim({ type: 'symbol', value: 'absentSymbol()', context: join(root, 'ephemeral.ts') }, root, false)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'file', value: join(root, 'gone.ts') }, root, false)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'file', value: '~/notes.ts' }, root, false)).verdict, 'unknown');
  assert.equal(extractClaims(`Check \`${join(root, 'ephemeral.ts')}\``)[0].value, join(root, 'ephemeral.ts'));
  assert.equal((await checkClaim({ type: 'file', value: 'fleet/nested/dist/excluded.ts' }, root, false)).verdict, 'unknown');
  assert.equal((await checkClaim({ type: 'file', value: 'empty-dir/' }, root, false)).verdict, 'verified');
  await assert.rejects(directoryEvidence(root, 0), /bounded search limit/);
  assert.equal((await checkClaim({ type: 'file', value: 'excluded.ts' }, root, false)).verdict, 'stale');
  assert.equal((await checkClaim({ type: 'symbol', value: 'localFunction()' }, root, false)).verdict, 'verified');
  assert.equal((await checkClaim({ type: 'symbol', value: 'excludedSymbol()' }, root, false)).verdict, 'unknown');
  const missing = await checkClaim({ type: 'symbol', value: 'absentSymbol()', context: 'src/index.ts' }, root, false);
  assert.equal(missing.verdict, 'stale'); assert.match(missing.reason!, /^symbol absent in \d+ files searched$/);
});

test('frontmatter names are stable keys, file stems remain aliases and only truly absent wiki targets stay unresolved', async t => {
  const { root, options, store } = await tracker(t); const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'legacy-file.md'), '---\nname: release-policy\ndescription: Safe release workflow\nmetadata:\n  type: project\n---\nRun gates. See [[review-policy]] [[review-file]] [[absent]].\n');
  await writeFile(join(source, 'review-file.md'), '---\nname: review-policy\ndescription: Review builds\n---\nSee [[release-policy]] [[legacy-file]].\n');
  const result = await importDir(source, { ...options, from: 'claude-code' });
  assert.equal(result.unresolved_links, 1);
  const rows = await store.read(); const release = rows.find(row => row.slug === 'release-policy')!; const review = rows.find(row => row.slug === 'review-policy')!;
  assert.equal(release.description, 'Safe release workflow'); assert.deepEqual(release.links, [review.id]); assert.deepEqual(review.links, [release.id]);
  const before = await snapshot(options.workspace); assert.equal((await importDir(source, { ...options, from: 'claude-code' })).unchanged, 2); assert.deepEqual(await snapshot(options.workspace), before);
  const out = join(root, 'out'); await exportDir(out, { ...options, to: 'claude-code' });
  for (const item of [release, review]) assert.equal((await readFile(join(out, 'memories', `${item.slug}.md`), 'utf8')).split('\n').slice(1).join('\n'), item.body);
  const retained = (await store.client.listAllComplete({ includeBody: true })).items;
  await importDir(out, { ...options, from: 'claude-code' });
  assert.deepEqual((await store.client.listAllComplete({ includeBody: true })).items, retained);
});

test('compact recall retains a huge top result at 200 tokens, shows scores and descriptions, and get returns full content', async t => {
  const { options, store } = await tracker(t);
  const body = `Release workflow\n${'Run deterministic build checks. '.repeat(1000)}`;
  await remember(body, { ...options, kind: 'project', slug: 'release-policy', why: 'Release safely', pin: true });
  for (let i = 0; i < 12; i++) await remember(`Unrelated topic ${i}`, { ...options, kind: 'reference', slug: `other-${i}`, forceNew: true });
  for (const limit of [200, 800]) {
    const packet = await recall('release workflow', { ...options, budget: limit });
    assert.equal(packet.memories![0].slug, 'release-policy'); assert.equal(packet.memories![0].kind, 'project'); assert.equal(packet.memories![0].pinned, true);
    assert.equal(typeof packet.memories![0].score, 'number'); assert.equal(packet.memories![0].description, 'Release safely'); assert.ok(packetTokens(packet) <= limit);
  }
  assert.equal((await get('release-policy', options)).body, body.trim());
  await assert.rejects(get('missing', options), /does not exist/);
  const memory = (await store.read()).find(row => row.slug === 'release-policy')!;
  const packet = recallPacket([{ slug: memory.slug, description: 'x'.repeat(3000) }], [memory], 'release', 200);
  assert.equal(packet.memories![0].slug, memory.slug);
  const excerpt = recallPacket([{ slug: memory.slug, description: 'Build guidance' }], [memory], 'release', 400);
  assert.match(excerpt.memories![0].text!, /truncated/);
  assert.throws(() => recallPacket([{ slug: 'x'.repeat(120) }], [memory], 'release', 40), /top memory row/);
  const empty = recallPacket([], [], 'anything', 200); assert.equal(empty.omitted, 0);
});

test('privacy preflight reports every offending relative file, line and matched class without echoing values or writing', async t => {
  const { root, options } = await tracker(t); const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'email.md'), '---\nname: email-note\ndescription: person@example.test\n---\nBody\n');
  await writeFile(join(source, 'secret.md'), '---\nname: secret-note\n---\napi_key=fake0000000000000000\n');
  const before = await snapshot(options.workspace);
  await assert.rejects(importDir(source, { ...options, from: 'claude-code' }), error => {
    assert.ok(error instanceof MemoryError); assert.match(error.message, /email.md:line 3 \(Email address refused\)/); assert.match(error.message, /secret.md:line 4 \(Credential-shaped memory refused\)/);
    assert.ok(!error.message.includes('person@example.test')); assert.ok(!error.message.includes('fake000')); assert.match(error.remedy, /--allow-email/); assert.match(error.remedy, /Edit each listed file/); return true;
  });
  assert.deepEqual(await snapshot(options.workspace), before);
  await writeFile(join(source, 'secret.md'), 'A safe standalone note');
  assert.equal((await importDir(source, { ...options, from: 'claude-code', allowEmail: true })).imported, 2);
});

test('archive proposals require confident stale reasons, zero recalls, an age threshold and no pin', async t => {
  const { options, store } = await tracker(t); await remember('Old synthetic source', { ...options, kind: 'project', slug: 'old' });
  const base = { ...(await store.read())[0], verdict: 'stale' as const, reason: 'missing path src/deleted.ts under roots', updated: new Date(Date.now() - 31 * 86400000).toISOString() };
  assert.equal(proposals([base]).length, 1);
  for (const row of [{ ...base, reason: '' }, { ...base, reason: undefined }, { ...base, reason: 'Uncertain historical claim' }, { ...base, verdict: 'unknown' as const }, { ...base, recalls: 1 }, { ...base, pinned: true }, { ...base, updated: new Date().toISOString() }, { ...base, updated: 'invalid' }]) assert.equal(proposals([row]).length, 0);
  assert.equal(proposals([base], 60).length, 0); assert.equal(proposals([{ ...base, updated: new Date().toISOString() }], 0).length, 1);
  assert.throws(() => proposals([base], -1), /Invalid archive age/);
});

test('top-1 packing never replaces an oversized highest-ranked memory with a smaller lower-ranked result', async t => {
  const { options } = await tracker(t);
  const key = `release-${'x'.repeat(110)}`;
  await remember(`Release workflow ${'😀'.repeat(100)}\n${'release workflow detailed guidance '.repeat(500)}`, { ...options, kind: 'project', slug: key, why: 'Run release checks' });
  await remember('Secondary unrelated fallback', { ...options, kind: 'reference', slug: 'fallback' });
  const packet = await recall('release workflow', { ...options, budget: 200 });
  assert.equal(packet.memories![0]?.slug, key); assert.ok(packetTokens(packet) <= 200);
});

test('bounded evidence failures remain unknown or refuse, and contextual missing symbols retain a file-count reason', async t => {
  const { root, options } = await tracker(t);
  await writeFile(join(root, 'source.ts'), 'export const known = true;');
  await remember('Check `source.ts` absentContextSymbol() --tags', { ...options, kind: 'project', slug: 'symbol' });
  const checked = await verify({ ...options, root });
  assert.equal(checked.stale, 1); assert.match(checked.results[0].claims.find(claim => claim.type === 'symbol')!.reason!, /symbol absent in \d+ files searched/);
});

test('ranking distinguishes title, description, slug and body evidence', async t => {
  const { options, store } = await tracker(t); await remember('Baseline neutral fact', { ...options, kind: 'reference', slug: 'base' });
  const base = (await store.read())[0];
  const rows = [
    { ...base, slug: 'needle', title: 'Neutral heading', description: '', body: 'Plain body' },
    { ...base, slug: 'heading', title: 'Needle heading', description: '', body: 'Plain body' },
    { ...base, slug: 'description', title: 'Neutral heading', description: 'Needle hook', body: 'Plain body' },
    { ...base, slug: 'body', title: 'Neutral heading', description: '', body: 'Needle body' },
  ];
  assert.deepEqual(rank(rows, 'needle').map(row => row.slug), ['heading', 'description', 'needle', 'body']);
});
