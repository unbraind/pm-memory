import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTransactionInterruptedError, getHistoryPath, readHistoryEntries, readSettings } from '@unbrained/pm-cli/sdk';
import { remember, renew, get, guidanceState, exportDir, importDir, parsePolicy, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortablePolicyManifest, PortableGuidance } from '../index.ts';
import { digest } from '../src/core.ts';
import { policyRecord, policyBody, importPolicy } from '../src/portable.ts';
import { tracker, snapshot, installExtension, gitlessCli } from './helpers.ts';

const from = '2026-10-01T00:00:00.000Z';
const until = '2026-11-01T00:00:00.000Z';

/** Select portable refusal codes without exposing source data. */
const refused = (error: unknown) => error instanceof MemoryError && error.remedy.length > 0;
/** Read the editable versioned manifest. */
async function manifest(path: string): Promise<PortablePolicyManifest> { return JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')); }
/** Persist a harness-side manifest edit. */
async function save(path: string, value: unknown): Promise<void> { await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(value)); }
/** Create a real bounded source and its portable directory. */
async function fixture(t: Parameters<typeof tracker>[0], to: 'agents-md' | 'claude-code' = 'agents-md') {
  const source = await tracker(t);
  await remember('Run the public checks', { ...source.options, slug: 'policy', kind: 'project', pin: true, tags: ['public'], why: 'Reproducibility', how: 'Check before delivery' });
  await renew('policy', { ...source.options, from, until, evidence: 'Public review alpha' });
  await renew('policy', { ...source.options, from, until, evidence: 'Public review beta' });
  const path = join(source.root, 'portable'); await exportDir(path, { ...source.options, to });
  return { ...source, path, to };
}

/** Create two independent policy rows for batch boundary tests. */
async function twoPolicies(t: Parameters<typeof tracker>[0]) {
  const source = await fixture(t); const valid = await manifest(source.path);
  const row = structuredClone(valid.guidance[0]); row.slug = 'second'; row.path = 'memories/second.md'; valid.guidance.push(row);
  await save(source.path, valid); await writeFile(join(source.path, row.path), policyBody(row, 'Second policy'));
  return { source, valid, row };
}
/** Check that recovery retained the one policy and its latest evidence revision. */
async function assertRecovered(target: Awaited<ReturnType<typeof tracker>>) {
  assert.equal((await target.store.read()).length, 1);
  assert.equal((await get('policy', target.options)).validity!.revision, 2);
}
/** Interrupt a selected public boundary once. */
function crashAt(boundary: string) {
  return (step: string) => { if (step === boundary) throw new WorkspaceTransactionInterruptedError(); };
}

test('property: import(export(x)) == x for random guidance sets and both harnesses', async t => {
  let seed = 1363;
  /** Deterministic generator retains a reproducible failing seed. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const to of ['agents-md', 'claude-code'] as const) {
    const source = await tracker(t);
    for (let index = 0; index < 12; index++) {
      const key = `policy-${index}`; const pinned = index % 3 !== 0;
      const start = Date.parse(from) + random() % 100000000;
      const randomFrom = new Date(start).toISOString(); const randomUntil = new Date(start + 1 + random() % 100000000).toISOString();
      await remember(`Guidance ${random()}\nUnicode policy Ω ${random()}`, { ...source.options, slug: key, kind: ['user', 'feedback', 'project', 'reference'][random() % 4] as 'project', tags: [`topic-${random() % 4}`], pin: pinned, forceNew: true });
      if (pinned) for (let rev = 0, count = 1 + random() % 3; rev < count; rev++) await renew(key, { ...source.options, from: randomFrom, until: randomUntil, evidence: `Review ${random()}` });
    }
    const path = join(source.root, 'export'); await exportDir(path, { ...source.options, to });
    const before = await manifest(path);
    const target = await tracker(t);
    assert.equal((await importDir(path, { ...target.options, from: to })).imported, 12);
    const actual = await Promise.all((await target.store.read()).map(item => policyRecord(target.store, item)));
    assert.deepEqual(actual.sort((a, b) => a.slug.localeCompare(b.slug)), [...before.guidance].sort((a, b) => a.slug.localeCompare(b.slug)));
    for (const item of await source.store.read()) assert.equal((await get(item.slug, target.options)).body, item.body);
    const saved = await snapshot(target.workspace);
    assert.equal((await importDir(path, { ...target.options, from: to })).unchanged, 12);
    assert.deepEqual(await snapshot(target.workspace), saved);
    const again = join(target.root, 'again'); await exportDir(again, { ...target.options, to });
    assert.deepEqual(await manifest(again), before);
    // A later native renewal appends to imported ancestry instead of replacing it.
    const key = before.guidance.find(row => row.validity !== null)!.slug;
    await renew(key, { ...target.options, from, until, evidence: 'New native review' });
    const native = await policyRecord(target.store, await get(key, target.options));
    assert.equal(native.renewals.length, before.guidance.find(row => row.slug === key)!.renewals.length + 1);
  }
});

test('harness body edits retain bounds, evidence and needs-renewal state across fresh and original trackers', async t => {
  for (const to of ['agents-md', 'claude-code'] as const) {
    const source = await fixture(t, to);
    const initial = (await manifest(source.path)).guidance[0];
    await writeFile(join(source.path, initial.path), policyBody(initial, 'Run revised public checks'));
    const target = await tracker(t);
    await importDir(source.path, { ...target.options, from: to });
    assert.deepEqual((await get('policy', target.options)).validity, initial.validity);
    assert.equal(guidanceState(await get('policy', target.options), Date.parse(from)), 'needs-renewal');
    await importDir(source.path, { ...source.options, from: to });
    assert.equal((await get('policy', source.options)).body, 'Run revised public checks');
    assert.equal(guidanceState(await get('policy', source.options), Date.parse(from)), 'needs-renewal');
    const out = join(target.root, 'out'); await exportDir(out, { ...target.options, to });
    assert.deepEqual((await manifest(out)).guidance[0].renewals, initial.renewals);
  }
});

test('every malformed or expanded policy field refuses the whole batch before any durable writes', async t => {
  const source = await fixture(t);
  const valid = await manifest(source.path);
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const changes: ((value: PortablePolicyManifest) => void)[] = [
    value => { value.version = 2 as 1; },
    value => { value.format = 'future' as 'pm-memory-policy'; },
    value => { value.harness = 'cursor' as 'agents-md'; },
    value => { value.guidance.push(value.guidance[0]); },
    value => { value.guidance[0].path = '../escape.md'; },
    value => { value.guidance[0].pinned = 'true' as unknown as boolean; },
    value => { value.guidance[0].tags = [1] as unknown as string[]; },
    value => { value.guidance[0].title = 3 as unknown as string; },
    value => { value.guidance[0].snapshotHash = 'invalid'; },
    value => { value.guidance[0].updated = 'invalid'; },
    value => { value.guidance[0].pinned = false; },
    value => { value.guidance[0].validity = null; },
    value => { value.guidance[0].validity = null; value.guidance[0].renewals = []; },
    value => { value.guidance[0].validity!.until = '2027-01-01T00:00:00.000Z'; value.guidance[0].renewals.at(-1)!.until = '2027-01-01T00:00:00.000Z'; },
    value => { value.guidance[0].renewals = []; },
    value => { value.guidance[0].renewals.pop(); },
    value => { value.guidance[0].renewals.reverse(); },
    value => { value.guidance[0].renewals[1].recordedAt = '2020-01-01T00:00:00.000Z'; },
    value => { value.guidance[0].validity!.from = '2026-09-01T00:00:00.000Z'; },
    value => { value.guidance[0].validity!.until = '2027-01-01T00:00:00.000Z'; },
    value => { value.guidance[0].validity!.evidence = 'Replaced evidence'; },
    value => { value.guidance[0].validity!.contentHash = 'b'.repeat(64); },
    value => { value.guidance[0].validity!.recordedAt = from; },
    value => { value.guidance[0].validity!.revision++; },
  ];
  for (const change of changes) { const value = structuredClone(valid); change(value); await save(source.path, value); await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), refused); assert.deepEqual(await snapshot(target.workspace), before); }
  const window = valid.guidance[0].validity!;
  for (const patch of [{ from: 'invalid' }, { until: from }, { evidence: '' }, { contentHash: 'wrong' }, { revision: 0 }, { revision: 1.5 }, { recordedAt: '2026-02-30T00:00:00.000Z' }, { extra: 'unsupported' }]) {
    const value = structuredClone(valid); value.guidance[0].validity = { ...window, ...patch }; await save(source.path, value);
    await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), refused);
  }
  for (const value of [null, [], {}, { ...valid, extra: true }, { ...valid, guidance: null }, { ...valid, guidance: [null] }]) assert.throws(() => parsePolicy(value), refused);
  await save(source.path, valid);
  await assert.rejects(importDir(source.path, { ...target.options, from: 'claude-code' }), refused);
  await writeFile(join(source.path, valid.guidance[0].path), 'Removed policy marker');
  await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), refused);
  await rm(join(source.path, valid.guidance[0].path));
  await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), refused);
  await writeFile(join(source.path, valid.guidance[0].path), Buffer.from([255]));
  await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), refused);
  await writeFile(join(source.path, POLICY_MANIFEST), '{');
  await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), refused);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('SDK transaction crashes at every transition resume without duplicate items or lost renewal evidence', async t => {
  const { source, valid, row } = await twoPolicies(t);
  const probe = await tracker(t); const boundaries: string[] = [];
  await importDir(source.path, { ...probe.options, from: 'agents-md', onTransition: event => { boundaries.push(`${event.transition}:${event.stepId ?? ''}`); } });
  assert.equal(boundaries.length, 14);
  for (let index = 0; index < boundaries.length; index++) {
    const target = await tracker(t); let step = 0;
    await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md', onTransition: () => { if (step++ === index) throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    await importDir(source.path, { ...target.options, from: 'agents-md' });
    const rows = await target.store.read(); assert.equal(rows.length, 2);
    for (const item of rows) assert.deepEqual((await policyRecord(target.store, item)).renewals, row.renewals);
    const saved = await snapshot(target.workspace);
    assert.equal((await importDir(source.path, { ...target.options, from: 'agents-md' })).unchanged, 2);
    assert.deepEqual(await snapshot(target.workspace), saved);
  }
});

test('competing imports injected at every transaction boundary share one non-git tracker and report peer success', async t => {
  const source = await fixture(t);
  for (let boundary = 0; boundary < 10; boundary++) {
    const target = await tracker(t); let step = 0; let peer: ReturnType<typeof importDir> | undefined;
    const first = await importDir(source.path, { ...target.options, from: 'agents-md', onTransition: () => { if (step++ === boundary) peer = importDir(source.path, { ...target.options, author: 'peer', from: 'agents-md' }); } });
    assert.equal(first.imported, 1); assert.ok(peer);
    assert.equal((await peer).unchanged, 1); await assertRecovered(target);
  }
});

test('native policy changes and manifest loss cannot silently remove or replace bounded evidence', async t => {
  const source = await fixture(t); const valid = await manifest(source.path);
  await renew('policy', { ...source.options, from, until, evidence: 'Competing native review' });
  await assert.rejects(importDir(source.path, { ...source.options, from: 'agents-md' }), refused);
  const bare = join(source.root, 'policy.md'); await writeFile(bare, 'Unbounded replacement');
  await assert.rejects(importDir(bare, { ...source.options, from: 'agents-md' }), refused);
  const target = await tracker(t); await importDir(source.path, { ...target.options, from: 'agents-md' });
  const policy = await get('policy', target.options);
  await target.store.client.update(policy.id, { body: 'Independently edited native content' });
  await writeFile(join(source.path, valid.guidance[0].path), policyBody(valid.guidance[0], 'Harness revision'));
  const result = await importDir(source.path, { ...target.options, from: 'agents-md' });
  assert.ok('skipped' in result); assert.equal(result.skipped.length, 1); assert.match(result.skipped[0].reason, /Independently/);
  assert.equal((await get('policy', target.options)).body, 'Independently edited native content');
});

test('foreign adjacent files are skipped and CLI imports render compact TOON and JSON without git', async t => {
  const source = await fixture(t); await writeFile(join(source.path, 'foreign.md'), 'Foreign note');
  const target = await tracker(t); await installExtension(target.workspace);
  const cli = gitlessCli(target.root, target.workspace);
  for (const format of [[], ['--json']]) {
    const result = cli(['import', source.path, '--from', 'agents-md', ...format]);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Foreign file absent/); assert.ok(result.stdout.length < 600);
  }
  const imported = await get('policy', target.options);
  assert.ok((await readHistoryEntries(getHistoryPath(target.workspace, imported.id), imported.id)).every(entry => entry.author === 'memory-test'));
  const out = join(target.root, 'out'); const exported = cli(['export', out, '--to', 'claude-code', '--json']);
  assert.equal(exported.status, 0, exported.stderr); assert.equal(JSON.parse(exported.stdout).exported, 3);
  const row = (await manifest(out)).guidance[0]; row.validity = null; const broken = await manifest(out); broken.guidance = [row]; await save(out, broken);
  const refused = cli(['import', out, '--from', 'claude-code']); assert.equal(refused.status, 2); assert.match(refused.stderr, /memory validity.*Remedy:/);
});

test('preparation crashes at every schema and preview boundary converge on rerun', async t => {
  const source = await fixture(t); const probe = await tracker(t); const boundaries: string[] = [];
  await importDir(source.path, { ...probe.options, from: 'agents-md', onStep: step => { boundaries.push(step); } });
  assert.ok(boundaries.length > 20);
  for (const boundary of boundaries) {
    const target = await tracker(t);
    await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md', onStep: crashAt(boundary) }), WorkspaceTransactionInterruptedError);
    await importDir(source.path, { ...target.options, from: 'agents-md' });
    await assertRecovered(target);
  }
});

test('export crashes and competing exporters at every file-publication boundary converge without overwrites', async t => {
  const source = await fixture(t); const boundaries: string[] = [];
  await exportDir(join(source.root, 'probe'), { ...source.options, to: 'agents-md', onStep: step => { boundaries.push(step); } });
  assert.equal(boundaries.length, 6);
  for (const [index, boundary] of boundaries.entries()) {
    const out = join(source.root, `crash-${index}`);
    await assert.rejects(exportDir(out, { ...source.options, to: 'agents-md', onStep: crashAt(boundary) }), WorkspaceTransactionInterruptedError);
    await exportDir(out, { ...source.options, to: 'agents-md' });
    assert.deepEqual(await manifest(out), await manifest(source.path));
    const peerOut = join(source.root, `peer-${index}`); let peer: ReturnType<typeof exportDir> | undefined;
    await exportDir(peerOut, { ...source.options, to: 'agents-md', onStep: step => { if (step === boundary) peer = exportDir(peerOut, { ...source.options, author: 'peer', to: 'agents-md' }); } });
    assert.ok(peer); assert.equal((await peer).exported, 3);
  }
});

test('missing manifests and foreign native records are refused or skipped with explicit reasons', async t => {
  const source = await fixture(t); const target = await tracker(t);
  await assert.rejects(importDir(join(source.path, 'memories/policy.md'), { ...target.options, from: 'agents-md' }), refused);
  await remember('Foreign authored content', { ...target.options, kind: 'reference', slug: 'policy' });
  const result = await importDir(source.path, { ...target.options, from: 'agents-md' });
  assert.ok('skipped' in result); assert.match(result.skipped[0].reason, /Foreign native/);
  assert.equal((await get('policy', target.options)).body, 'Foreign authored content');
  assert.deepEqual(await importPolicy([{ path: POLICY_MANIFEST, bytes: Buffer.from(JSON.stringify({ version: 1, format: 'pm-memory-policy', harness: 'agents-md', guidance: [] })) }], { ...target.options, from: 'agents-md' }), { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: [] });
});

test('updates recover and compensate at every SDK write boundary with no duplicate or lost evidence', async t => {
  const { source, valid } = await twoPolicies(t);
  const target = await tracker(t); await importDir(source.path, { ...target.options, from: 'agents-md' });
  for (let boundary = 0; boundary < 14; boundary++) {
    const expected = `Policy harness edit ${boundary}`;
    for (const row of valid.guidance) await writeFile(join(source.path, row.path), policyBody(row, expected));
    let step = 0;
    await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md', onTransition: () => { if (step++ === boundary) throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    await importDir(source.path, { ...target.options, from: 'agents-md' });
    assert.equal((await target.store.read()).length, 2);
    for (const row of valid.guidance) assert.equal((await get(row.slug, target.options)).body, expected);
  }
  const before = await get('policy', target.options); const history = await readHistoryEntries(getHistoryPath(target.workspace, before.id), before.id);
  for (const row of valid.guidance) await writeFile(join(source.path, row.path), policyBody(row, 'Compensated edit'));
  await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md', onTransition: event => { if (event.transition === 'step_recorded') throw new Error('Ordinary publication failure'); } }), /Ordinary publication failure/);
  assert.equal((await get('policy', target.options)).body, before.body);
  assert.deepEqual((await readHistoryEntries(getHistoryPath(target.workspace, before.id), before.id)).slice(0, history.length), history);
  await importDir(source.path, { ...target.options, from: 'agents-md' });
  assert.equal((await get('policy', target.options)).body, 'Compensated edit');
});

test('independent trackers recognize identical export peer success and refuse differing peer publication', async t => {
  const source = await fixture(t); const peer = await tracker(t);
  await importDir(source.path, { ...peer.options, from: 'agents-md' });
  for (const different of [false, true]) {
    const out = join(source.root, `independent-${different}`);
    if (different) await remember('Peer changed the semantic instruction', { ...peer.options, kind: 'project', update: 'policy' });
    const publish = exportDir(out, { ...source.options, to: 'agents-md', onStep: async step => { if (step === 'permissions') await exportDir(out, { ...peer.options, to: 'agents-md' }); } });
    if (different) await assert.rejects(publish, /peer published different/); else assert.equal((await publish).exported, 3);
    assert.deepEqual((await manifest(out)).guidance[0].validity, (await manifest(source.path)).guidance[0].validity);
  }
});

test('the last invalid row prevents every earlier row from being written', async t => {
  const { source, valid } = await twoPolicies(t); const target = await tracker(t);
  const before = await snapshot(target.workspace);
  valid.guidance[1].validity!.evidence = ''; await save(source.path, valid);
  await assert.rejects(importDir(source.path, { ...target.options, from: 'agents-md' }), refused);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('foreign deterministic identities and malformed package provenance are skipped without adoption or deletion', async t => {
  const source = await fixture(t); const target = await tracker(t);
  const valid = parsePolicy(await manifest(source.path)); const row = valid.guidance[0];
  const body = (await readFile(join(source.path, row.path), 'utf8')).slice(policyBody(row, '').length);
  const inputHash = digest(JSON.stringify([valid, [body]]));
  const transactionId = `memory-policy-${digest(JSON.stringify([inputHash, []])).slice(0, 40)}`;
  const id = `${(await readSettings(target.workspace)).id_prefix}${digest(`${transactionId}:${row.slug}`).slice(0, 24)}`;
  await target.client.run('create', { options: { title: 'Foreign deterministic identity', id } });
  const result = await importDir(source.path, { ...target.options, from: 'agents-md' });
  assert.ok('skipped' in result); assert.match(result.skipped[0].reason, /deterministic import id/);
  assert.equal((await target.client.get(id)).item.title, 'Foreign deterministic identity');
  const imported = await tracker(t); await importDir(source.path, { ...imported.options, from: 'agents-md' });
  for (const original of ['{', 'null', '[]', '[{},3]', '[{},"body"]']) {
    await imported.store.fields((await get('policy', imported.options)).id, { original: Buffer.from(original).toString('base64') });
    const receipt = await importDir(source.path, { ...imported.options, from: 'agents-md' });
    assert.ok('skipped' in receipt); assert.match(receipt.skipped[0].reason, /unreadable import provenance/);
  }
});

test('conflicting historical evidence refuses export and unrelated removed metadata stays outside policy ancestry', async t => {
  const source = await fixture(t); const item = await get('policy', source.options);
  await source.store.client.update(item.id, { removeTags: ['public'] });
  assert.equal((await policyRecord(source.store, await get('policy', source.options))).renewals.length, 2);
  await source.store.fields(item.id, { validity: JSON.stringify({ ...item.validity, evidence: 'Conflicting same revision' }) });
  await assert.rejects(exportDir(join(source.root, 'invalid'), { ...source.options, to: 'agents-md' }), refused);
});

test('preparation boundaries serialize a competing import and retain its completed work', async t => {
  const source = await fixture(t); const probe = await tracker(t); const steps: string[] = [];
  await importDir(source.path, { ...probe.options, from: 'agents-md', onStep: step => { steps.push(step); } });
  for (const boundary of steps) {
    const target = await tracker(t); let peer: ReturnType<typeof importDir> | undefined;
    const first = await importDir(source.path, { ...target.options, from: 'agents-md', onStep: step => { if (step === boundary) peer = importDir(source.path, { ...target.options, author: 'peer', from: 'agents-md' }); } });
    assert.ok(peer); const second = await peer;
    assert.equal(first.imported + second.imported, 1);
    await assertRecovered(target);
  }
});

test('malformed foreign Knowledge metadata cannot abort or be adopted by a portable import', async t => {
  const source = await fixture(t); const target = await tracker(t); await target.store.register();
  for (const key of ['policy', 'unrelated']) await target.client.run('create', { options: { title: 'Foreign context', type: 'Knowledge', memorySlug: key, memorySource: 'foreign-tool', memoryKind: 'unsupported' } });
  await target.client.create({ title: 'Unrelated Knowledge without memory metadata', type: 'Knowledge' });
  const receipt = await importDir(source.path, { ...target.options, from: 'agents-md' });
  assert.ok('skipped' in receipt); assert.equal(receipt.skipped.length, 2); assert.equal(receipt.imported, 0);
  assert.ok(receipt.skipped.every(row => /no package-owned source/.test(row.reason)));
  assert.equal((await target.client.listAllComplete()).items.length, 3);
});

test('publication permission failures retain the source and rerun after permissions recover', async t => {
  const source = await fixture(t); const parent = join(source.root, 'permission-case'); await mkdir(parent);
  const destination = join(parent, 'output');
  try {
    await assert.rejects(exportDir(destination, { ...source.options, to: 'agents-md', onStep: async step => { if (step === 'permissions') await chmod(parent, 0o555); } }));
  } finally { await chmod(parent, 0o755); }
  await exportDir(destination, { ...source.options, to: 'agents-md' });
  assert.deepEqual(await manifest(destination), await manifest(source.path));
});
