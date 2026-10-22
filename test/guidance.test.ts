import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { getHistoryPath, readHistoryEntries, verifyHistoryEntries } from '@unbrained/pm-cli/sdk';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { remember, recall, index, get, renew, guidanceState, packetTokens, exportDir, consolidate, MemoryError } from '../index.ts';
import type { GuidanceWindow, Packet } from '../index.ts';
import { instant, readWindow, guidancePolicy, eligibleGuidance } from '../src/guidance.ts';
import { runCommand } from '../src/commands.ts';
import { tracker, snapshot, installExtension, gitlessCli } from './helpers.ts';
import type { EmbeddingProvider } from '../src/embeddings.ts';

const from = '2026-10-21T00:00:00.000Z';
const until = '2026-10-22T00:00:00.000Z';
const evidence = 'Release checklist approved after the public policy review';

/** Assert a structured refusal includes an actionable remedy. */
function refusal(code: string) {
  return (error: unknown) => error instanceof MemoryError && error.code === code && error.remedy.length > 0;
}

test('frozen-clock validity boundaries exclude by default and label compact packets', async t => {
  const { options, store } = await tracker(t);
  await remember('Run public release checks', { ...options, kind: 'project', slug: 'policy', pin: true });
  await remember('Keep a reference checklist', { ...options, kind: 'reference', slug: 'legacy' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(from) });
  const original = await get('policy', options);
  const renewed = await renew('policy', { ...options, from, until, evidence });
  assert.equal(renewed.validity.recordedAt, from);
  assert.equal(renewed.validity.revision, 1);
  assert.equal((await get('policy', options)).updated, original.updated);
  assert.equal((await get('policy', options)).verdict, 'unknown');
  assert.equal(guidanceState(await get('policy', options), Date.now()), 'current');
  assert.equal(guidanceState(await get('legacy', options), Date.now()), undefined);
  for (const [now, state, included] of [[Date.parse(from) - 1, 'scheduled', false], [Date.parse(from), 'current', true], [Date.parse(until) - 1, 'current', true], [Date.parse(until), 'expired', false]] as const) {
    t.mock.timers.setTime(now);
    const packet = await recall('release', { ...options, budget: 800 });
    assert.equal(packet.memories!.some(row => row.slug === 'policy'), included);
    const indexed = await index({ ...options, budget: 800 });
    assert.equal(indexed.text!.includes('(policy)'), included);
    const audit = await recall('release', { ...options, validity: 'label', budget: 200 });
    assert.equal(audit.memories![0].validity, state);
    assert.equal(audit.memories![0].valid_from, from);
    assert.equal(audit.memories![0].valid_until, until);
    assert.ok(packetTokens(audit) <= 200);
    assert.match((await index({ ...options, validity: 'label' })).text!, new RegExp(state));
    assert.equal(await store.history(renewed.id) > 1, true);
  }
  const counts = (await get('policy', options)).recalls;
  assert.equal(counts, 6);
  const before = await snapshot(options.workspace);
  await assert.rejects(recall('release', { ...options, validity: 'bad' as 'label' }), refusal('validity'));
  await assert.rejects(index({ ...options, validity: 'bad' as 'label' }), refusal('validity'));
  assert.deepEqual(await snapshot(options.workspace), before);
});

test('content edits invalidate renewal evidence while verification and recall do not renew it', async t => {
  const { options, store } = await tracker(t);
  await remember('Run the signed release checklist', { ...options, kind: 'project', slug: 'policy', pin: true });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(from) });
  const renewed = await renew('policy', { ...options, from, until, evidence });
  await store.fields(renewed.id, { verdict: 'verified', verified_at: from });
  assert.equal((await recall('release', options)).memories![0].validity, 'current');
  await store.client.update(renewed.id, { description: 'An updated release instruction hook' });
  assert.equal((await recall('release', options)).memories!.length, 0);
  await renew('policy', { ...options, from, until, evidence: 'Updated retrieval description reviewed' });
  await remember('Run the updated release checklist', { ...options, kind: 'project', update: 'policy' });
  assert.equal((await recall('release', options)).memories!.length, 0);
  assert.equal((await recall('release', { ...options, validity: 'label' })).memories![0].validity, 'needs-renewal');
  const second = await renew('policy', { ...options, from, until, evidence: 'Updated checklist reviewed' });
  assert.equal(second.validity.revision, 3);
  assert.equal((await recall('release', options)).memories![0].validity, 'current');
  await store.fields(second.id, { pinned: false });
  assert.equal(guidanceState(await get('policy', options), Date.now()), 'needs-renewal');
  await assert.rejects(exportDir(join(options.workspace, 'unused'), { ...options, to: 'agents-md' }), refusal('validity'));
});

test('renewals across independent processes preserve both evidence revisions in native history', async t => {
  const { options, root } = await tracker(t);
  const created = await remember('Concurrent standing policy', { ...options, kind: 'project', slug: 'policy', pin: true });
  const before = await readHistoryEntries(getHistoryPath(options.workspace, created.id), created.id);
  /** Run an independent SDK process against the same non-git tracker. */
  const run = (proof: string) => new Promise<{ validity: GuidanceWindow }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'guidance-writer.ts'), options.workspace, proof], { cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root), PATH: root } });
    let output = ''; let errors = '';
    child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { errors += String(data); });
    child.on('error', reject); child.on('exit', code => { if (code === 0) resolve(JSON.parse(output)); else reject(new Error(errors)); });
  });
  const results = await Promise.all([run('Public policy review alpha'), run('Public policy review beta')]);
  assert.deepEqual(results.map(row => row.validity.revision).sort(), [1, 2]);
  const history = await readHistoryEntries(getHistoryPath(options.workspace, created.id), created.id);
  assert.deepEqual(history.slice(0, before.length), before);
  assert.equal(verifyHistoryEntries(history).ok, true);
  assert.ok(JSON.stringify(history).includes('Public policy review alpha'));
  assert.ok(JSON.stringify(history).includes('Public policy review beta'));
  assert.equal((await get('policy', options)).validity!.revision, 2);
});

test('invalid timestamps, metadata, privacy and nonstanding renewals refuse with no writes', async t => {
  const { options, store } = await tracker(t);
  const created = await remember('Ordinary unpinned reference', { ...options, kind: 'reference', slug: 'reference' });
  const base = { ...options, from, until, evidence };
  const before = await snapshot(options.workspace);
  for (const value of [undefined, 123, '', '2026-02-30T00:00:00.000Z', '2026-10-21', '2026-10-21T00:00:00Z', '2026-99-99T00:00:00.000Z']) assert.throws(() => instant(value), refusal('validity'));
  assert.equal(instant(from), from);
  await assert.rejects(renew('reference', base), refusal('validity'));
  await assert.rejects(renew('absent', base), refusal('missing'));
  await assert.rejects(renew('reference', { ...base, from: until }), refusal('validity'));
  await assert.rejects(renew('reference', { ...base, evidence: 'token=fake0000000000' }), refusal('privacy'));
  await assert.rejects(renew('reference', { ...base, evidence: ' ' }), refusal('invalid'));
  await assert.rejects(renew('reference', { ...base, from: 'bad' }), refusal('validity'));
  assert.deepEqual(await snapshot(options.workspace), before);
  assert.equal(guidancePolicy(undefined), 'exclude'); assert.equal(guidancePolicy('exclude'), 'exclude');
  assert.deepEqual(eligibleGuidance([], 'exclude', Date.now()), []);
  assert.equal(readWindow(undefined), undefined);
  const valid = { from, until, evidence, recordedAt: from, contentHash: 'a'.repeat(64), revision: 1 };
  assert.deepEqual(readWindow(JSON.stringify(valid)), valid);
  for (const value of [null, '', '{', 'null', '1', JSON.stringify({ ...valid, until: from }), JSON.stringify({ ...valid, evidence: 1 }), JSON.stringify({ ...valid, evidence: '' }), JSON.stringify({ ...valid, contentHash: 3 }), JSON.stringify({ ...valid, contentHash: 'invalid' }), JSON.stringify({ ...valid, revision: '1' }), JSON.stringify({ ...valid, revision: 1.5 }), JSON.stringify({ ...valid, revision: 0 }), JSON.stringify({ ...valid, from: 'invalid' })]) assert.throws(() => readWindow(value), refusal('schema'));
  await store.register(); await store.fields(created.id, { pinned: true, validity: JSON.stringify({ ...valid, revision: Number.MAX_SAFE_INTEGER }) });
  await assert.rejects(renew('reference', base), refusal('validity'));
  await store.fields(created.id, { artifact: true });
  await assert.rejects(renew('reference', base), refusal('missing'));
  await exportDir(join(options.workspace, 'artifact-export'), { ...options, to: 'agents-md' });
  await store.fields(created.id, { artifact: false });
  await store.client.update(created.id, { status: 'canceled' });
  await assert.rejects(renew('reference', base), refusal('missing'));
  await exportDir(join(options.workspace, 'canceled-export'), { ...options, to: 'agents-md' });
  await store.client.update(created.id, { status: 'open' });
  await store.fields(created.id, { validity: 'broken' });
  await assert.rejects(recall('reference', options), refusal('schema'));
});

test('real CLI renew and recall render bounded TOON and JSON without any git executable', async t => {
  const { root, workspace } = await tracker(t);
  await installExtension(workspace);
  /** Invoke the installed host with no possible git lookup. */
  const cli = gitlessCli(root, workspace);
  const remembered = cli(['remember', 'Run the release checklist', '--kind', 'project', '--slug', 'policy', '--pin', '--json']); assert.equal(remembered.status, 0, remembered.stderr);
  const renewed = cli(['renew', 'policy', '--valid-from', from, '--valid-until', until, '--evidence', evidence, '--json']); assert.equal(renewed.status, 0, renewed.stderr);
  assert.equal(JSON.parse(renewed.stdout).validity.revision, 1);
  for (const format of [[], ['--json']]) {
    const result = cli(['recall', 'release', '--validity', 'label', '--budget', '250', ...format]); assert.equal(result.status, 0, result.stderr);
    const packet = (format.length === 0 ? decodeToon(result.stdout) : JSON.parse(result.stdout)) as Packet;
    assert.equal(packet.memories![0].valid_until, until); assert.ok(packetTokens(packet) <= 250);
    const indexed = cli(['index', '--validity', 'label', ...format]); assert.equal(indexed.status, 0, indexed.stderr); assert.ok(indexed.stdout.includes(until));
  }
  const invalid = cli(['recall', 'release', '--validity', 'bogus']); assert.equal(invalid.status, 2); assert.match(invalid.stderr, /Remedy: Use --validity/);
  const missing = cli(['renew', 'policy']); assert.equal(missing.status, 2); assert.match(missing.stderr, /Remedy:/);
  const ctx = { command: 'memory renew', pm_root: workspace, args: ['policy'], options: { validFrom: from, validUntil: until, evidence }, global: {} } as CommandHandlerContext;
  await runCommand('renew', ctx);
});


test('semantic recall rechecks expiry after embedding outside the writer lock', async t => {
  const { options } = await tracker(t);
  await remember('Signed release checklist', { ...options, kind: 'project', slug: 'policy', pin: true });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(from) });
  await renew('policy', { ...options, from, until, evidence });
  let calls = 0;
  const provider = {
    identity: async () => 'guidance-clock-fixture',
    embed: async (inputs: readonly string[]) => { calls++; t.mock.timers.setTime(Date.parse(until)); return inputs.map(() => [1, 0]); },
  };
  const packet = await recall('release', { ...options, semantic: 'on', provider });
  assert.equal(packet.memories!.length, 0); assert.ok(calls > 0);
  assert.equal((await get('policy', options)).recalls, 0);
  const labelled = await recall('release', { ...options, semantic: 'on', provider, validity: 'label' });
  assert.equal(labelled.memories![0].validity, 'expired');
});


test('stacked auto fallback preserves labelled validity and provenance after expiry', async t => {
  const { options } = await tracker(t);
  await remember('Time-bound release policy', { ...options, kind: 'project', slug: 'policy', pin: true });
  await remember('Unbounded fallback guidance', { ...options, kind: 'reference', slug: 'legacy' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(from) });
  await renew('policy', { ...options, from, until, evidence });
  let queries = 0;
  const provider: EmbeddingProvider = { identity: async () => 'stacked-validity-fallback', embed: async (inputs, purpose) => {
    if (purpose === 'query') {
      await remember(`Fallback guidance revision ${++queries}`, { ...options, kind: 'reference', update: 'legacy' });
      if (queries === 5) t.mock.timers.setTime(Date.parse(until));
    }
    return inputs.map(() => [1, 0]);
  } };
  const packet = await recall('release policy', { ...options, provider, semantic: 'auto', validity: 'label', budget: 800 });
  assert.equal(queries, 5); assert.match(packet.note!, /corpus kept changing; using lexical ranking/);
  const policy = packet.memories!.find(row => row.slug === 'policy');
  assert.ok(policy); assert.equal(policy.validity, 'expired'); assert.equal(policy.valid_from, from); assert.equal(policy.valid_until, until);
  assert.equal(policy.source, 'native:item'); assert.equal(packet.memories!.length, 2); assert.ok(packetTokens(packet) <= 800);
  assert.equal((await get('policy', options)).recalls, 1); assert.equal((await get('legacy', options)).recalls, 1);
});

test('consolidation refuses bounded merge endpoints before any mutation', async t => {
  const { options, store } = await tracker(t);
  const first = await remember('The signed release checklist governs public delivery', { ...options, kind: 'project', slug: 'policy', pin: true });
  const second = await remember('The signed release checklist governs public delivery', { ...options, kind: 'project', slug: 'copy', pin: true, forceNew: true });
  await renew('policy', { ...options, from, until, evidence });
  const window = (await get('policy', options)).validity!;
  for (const [older, newer] of [[first.id, second.id], [second.id, first.id]]) {
    await store.fields(older, { changed_at: '2026-10-01T00:00:00.000Z' });
    await store.fields(newer, { changed_at: '2026-10-02T00:00:00.000Z' });
    const before = await snapshot(options.workspace);
    assert.equal((await consolidate(options)).proposals[0].action, 'merge');
    await assert.rejects(consolidate({ ...options, apply: true }), refusal('validity'));
    assert.deepEqual(await snapshot(options.workspace), before);
    assert.deepEqual((await get('policy', options)).validity, window);
  }
});
