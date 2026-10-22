import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { get, MemoryError, observe, packetTokens, recall, remember, utility } from '../index.ts';
import type { MemoryExposure, MemoryObservation, ObserveOptions } from '../index.ts';
import '../src/utility-types.ts';
import { parseUtility, utilityCounts } from '../src/utility.ts';
import { tracker, snapshot, gitlessCli } from './helpers.ts';
import type { EmbeddingProvider } from '../src/embeddings.ts';

/** One explicit observation input with a public comparison baseline. */
function input(recalled: string, task: string): Omit<ObserveOptions, 'workspace'> {
  return { recall: recalled, task, feedback: 'helpful', outcome: 'improved', attribution: 'isolated', evidence: 'Same test fixture and gate; fewer failures after applying guidance' };
}
/** Assert a safe SDK refusal exposes a machine category and remedy. */
function refusal(code: string) { return (error: unknown): boolean => error instanceof MemoryError && error.code === code && error.remedy.length > 0; }

test('utility keeps honest exposure, task and current-revision denominators without git', async t => {
  const { options, client, workspace, store, root } = await tracker(t);
  const saved = await remember('Run the public release gate', { ...options, kind: 'project', slug: 'release' });
  await store.fields(saved.id, { recalls: 2 }); // Legacy counters cannot establish which task saw guidance.
  const before = await utility('release', options);
  assert.equal(before.legacy_exposures, 2); assert.equal(before.lifetime.observations, 0);
  assert.equal(before.lifetime.scored, 0);
  const packet = await recall('release', options); assert.ok(packet.recall);
  assert.ok(packetTokens(packet) <= 800);
  const task = await client.create({ title: 'Public release task' });
  await client.update(task.item.id, { status: 'closed', closeReason: 'Public acceptance completed' });
  const observation = { ...options, ...input(packet.recall, task.item.id) };
  const concurrent = await Promise.all([observe('release', observation), observe('release', observation)]);
  assert.deepEqual(concurrent.map(row => row.recorded).sort(), [false, true]);
  const recorded = concurrent.find(row => row.recorded)!;
  const bytes = await snapshot(workspace);
  assert.deepEqual(await observe('release', observation), { ...recorded, recorded: false });
  assert.deepEqual(await snapshot(workspace), bytes, 'idempotent feedback must not append native history');
  await assert.rejects(observe('release', { ...observation, feedback: 'unhelpful' }), refusal('conflict'));
  const shortTask = task.item.id.slice(task.item.id.lastIndexOf('-') + 1);
  assert.equal((await observe('release', { ...observation, task: shortTask })).recorded, false, 'native aliases cannot inflate task denominators');
  const another = await recall('release', options); assert.ok(another.recall);
  await assert.rejects(observe('release', { ...observation, recall: another.recall }), refusal('conflict'));
  const report = await utility('release', options);
  assert.equal(report.recalls, 4); assert.equal(report.legacy_exposures, 2);
  assert.equal(report.lifetime.exposures, 2); assert.equal(report.lifetime.observed_exposures, 1);
  assert.equal(report.lifetime.unobserved_exposures, 1); assert.equal(report.lifetime.observations, 1);
  assert.equal(report.lifetime.scored, 1); assert.equal(report.lifetime.by_feedback.helpful.improved, 1);
  assert.deepEqual(report.current, report.lifetime);
  const history = await readHistoryEntries(getHistoryPath(workspace, saved.id), saved.id);
  assert.ok(history.length > 1);
  await remember('Use the alternate verification checklist', { ...options, kind: 'project', update: 'release' });
  const changed = await utility('release', options);
  assert.equal(changed.lifetime.scored, 1); assert.equal(changed.current.scored, 0);
  assert.equal(changed.current.exposures, 0); assert.notEqual(changed.revision, report.revision);
  await client.update(saved.id, { status: 'canceled', closeReason: 'Historical guidance retained' });
  assert.equal((await utility('release', options)).lifetime.scored, 1);
  assert.equal((await store.read()).length, 1, 'utility never deletes or cancels anything');
  // SDK paths are exercised with a ceiling and no git executable in a separate process.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { utility } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)}; console.log(JSON.stringify(await utility('release', {workspace:process.argv[1]})));`, workspace], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: root, GIT_CEILING_DIRECTORIES: dirname(root) } });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).lifetime.scored, 1);
});

test('semantic recall does not rerank after a concurrent utility exposure only', async t => {
  const { options } = await tracker(t);
  await remember('Stable release guidance', { ...options, kind: 'reference', slug: 'release' });
  let queries = 0;
  const provider: EmbeddingProvider = { identity: async () => 'utility-exposure-snapshot', embed: async (inputs, purpose) => {
    if (purpose === 'query' && ++queries === 1) await recall('release', { ...options, semantic: 'off' });
    return inputs.map(() => [1, 0]);
  } };
  const packet = await recall('release', { ...options, provider, semantic: 'on' });
  assert.equal(queries, 1, 'operational exposure receipts must not invalidate ranking snapshots');
  assert.ok(packet.recall); assert.equal(packet.memories![0].source, 'native:item');
  const report = await utility('release', options);
  assert.equal(report.recalls, 2); assert.equal(report.lifetime.exposures, 2);
});

test('confounded and unknown outcomes stay unscored and native lifecycle guards later outcomes', async t => {
  const { options, client } = await tracker(t);
  await remember('Verify the public task outcome', { ...options, kind: 'project', slug: 'outcome' });
  const early = await client.create({ title: 'Already completed public task' });
  await client.update(early.item.id, { status: 'closed', closeReason: 'Complete before guidance' });
  const packet = await recall('outcome', options); assert.ok(packet.recall);
  const cases = [
    { attribution: 'confounded', outcome: 'improved', closed: true },
    { attribution: 'unknown', outcome: 'worsened', closed: true },
    { attribution: 'isolated', outcome: 'unknown', closed: true },
    { attribution: 'isolated', outcome: 'unchanged', closed: false },
    { attribution: 'isolated', outcome: 'worsened', closed: true },
    { attribution: 'isolated', outcome: 'unchanged', closed: true },
  ] as const;
  for (const [index, scenario] of cases.entries()) {
    const task = await client.create({ title: `Public outcome task ${index}` });
    if (scenario.closed) await client.update(task.item.id, { status: 'closed', closeReason: 'Outcome measured' });
    await observe('outcome', { ...options, ...input(packet.recall, task.item.id), feedback: 'unhelpful', attribution: scenario.attribution, outcome: scenario.outcome });
  }
  await observe('outcome', { ...options, ...input(packet.recall, early.item.id) });
  const counts = (await utility('outcome', options)).lifetime;
  assert.equal(counts.exposures, 1); assert.equal(counts.observations, 7); assert.equal(counts.observed_exposures, 1);
  assert.equal(counts.unhelpful, 6); assert.equal(counts.helpful, 1);
  assert.deepEqual(counts.unscored, { confounded: 1, unknown: 2, not_later: 2 });
  assert.equal(counts.scored, 2); assert.deepEqual(counts.by_feedback.unhelpful, { scored: 2, improved: 0, unchanged: 1, worsened: 1 });
  assert.equal(counts.attribution.confounded, 1); assert.equal(counts.outcomes.improved, 2);
});

test('utility refuses unexposed, malformed, private, artifact and missing-task observations safely', async t => {
  const { options, store, client, workspace } = await tracker(t);
  const saved = await remember('Safe public guidance', { ...options, kind: 'reference', slug: 'safe' });
  const task = await client.create({ title: 'Native task' });
  const valid = { ...options, ...input('a'.repeat(24), task.item.id) };
  await assert.rejects(observe('safe', valid), refusal('missing'));
  await assert.rejects(observe('absent', valid), refusal('missing'));
  await assert.rejects(utility('absent', options), refusal('missing'));
  const packet = await recall('safe', options); assert.ok(packet.recall);
  valid.recall = packet.recall;
  const before = await snapshot(workspace);
  for (const bad of [{ feedback: 'maybe' }, { outcome: 'success' }, { attribution: 'proven' }, { evidence: '' }, { evidence: 'x'.repeat(1001) }, { task: '../task' }, { recall: 'bad' }]) {
    await assert.rejects(observe('safe', { ...valid, ...bad } as ObserveOptions), refusal('invalid'));
  }
  await assert.rejects(observe('safe', { ...valid, evidence: 'token=fake00000000000000000000' }), refusal('privacy'));
  await assert.rejects(observe('safe', { ...valid, task: saved.id }), refusal('invalid'));
  await assert.rejects(observe('safe', { ...valid, task: 'missing-task' }), refusal('task'));
  assert.deepEqual(await snapshot(workspace), before);
  await store.fields(saved.id, { artifact: true });
  await assert.rejects(utility('safe', options), refusal('missing'));
  await store.fields(saved.id, { artifact: false, utility: '{bad' });
  await assert.rejects(utility('safe', options), refusal('schema'));
  await store.fields(saved.id, { utility: JSON.stringify({ version: 1, exposures: [{ recall: 'b'.repeat(24), revision: 'a'.repeat(64), at: '2026-01-01T00:00:00.000Z' }, { recall: 'c'.repeat(24), revision: 'a'.repeat(64), at: '2026-01-01T00:00:00.000Z' }], observations: [] }) });
  await assert.rejects(utility('safe', options), refusal('schema'));
});

test('utility ledger validation refuses corrupt cohorts instead of dropping rows', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const row: MemoryExposure = { recall: 'a'.repeat(24), revision: 'b'.repeat(64), at };
  const observation: MemoryObservation = { ...input(row.recall, 'task-id'), at, completed_at: at, terminal: true, task_status: 'closed' };
  const ledger = { version: 1, exposures: [row], observations: [observation] };
  assert.deepEqual(parseUtility(JSON.stringify(ledger)), ledger);
  assert.equal(parseUtility('').exposures.length, 0);
  const invalid: unknown[] = ['{', 'null', '{}', JSON.stringify({ ...ledger, version: 2 })];
  for (const patch of [{ recall: 1 }, { recall: 'bad' }, { revision: 1 }, { revision: 'bad' }, { at: 1 }, { at: 'bad' }, { at: '2026-02-30T00:00:00.000Z' }]) invalid.push(JSON.stringify({ ...ledger, exposures: [{ ...row, ...patch }] }));
  invalid.push(JSON.stringify({ ...ledger, exposures: [row, row] }), JSON.stringify({ ...ledger, observations: [observation, observation] }));
  for (const patch of [{ recall: 1 }, { recall: 'c'.repeat(24) }, { at: 'bad' }, { task_status: 1 }, { terminal: 1 }, { completed_at: 'bad' }, { evidence: '' }, { task: 1 }]) invalid.push(JSON.stringify({ ...ledger, observations: [{ ...observation, ...patch }] }));
  invalid.push(JSON.stringify({ ...ledger, observations: [null] }), JSON.stringify({ ...ledger, exposures: [null] }), JSON.stringify({ ...ledger, observations: 'bad' }), JSON.stringify({ ...ledger, exposures: 'bad' }));
  for (const raw of invalid) assert.throws(() => parseUtility(raw), refusal('schema'));
  const future = { ...observation, completed_at: '2027-01-01T00:00:00.000Z' };
  assert.equal(utilityCounts([row], [future]).unscored.not_later, 1);
  assert.equal(utilityCounts([row], [{ ...observation, terminal: true, completed_at: '' }]).unscored.not_later, 1);
  assert.equal(utilityCounts([], [observation]).observations, 0);
});

test('actual native observe and utility commands work without git in compact TOON and JSON', async t => {
  const { root, workspace, options, client } = await tracker(t);
  const directory = join(workspace, 'extensions', 'pm-memory'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ name: 'pm-memory', version: '2026.10.19', entry: 'entry.js', capabilities: ['commands', 'schema'] }));
  await writeFile(join(directory, 'entry.js'), `export { default } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};\n`);
  /** Invoke the installed pm host with git absent from PATH and ancestor discovery fenced. */
  const cli = gitlessCli(root, workspace);
  await remember('Run native acceptance', { ...options, kind: 'project', slug: 'native' });
  const recallResult = cli(['recall', 'native', '--json']); assert.equal(recallResult.status, 0, recallResult.stderr);
  const packet = JSON.parse(recallResult.stdout) as { recall: string };
  const task = await client.create({ title: 'Native public task' });
  await client.update(task.item.id, { status: 'closed', closeReason: 'Acceptance complete' });
  const args = ['observe', 'native', '--recall', packet.recall, '--task', task.item.id, '--feedback', 'helpful', '--outcome', 'improved', '--attribution', 'confounded', '--evidence', 'Another fix changed the gate too'];
  const observed = cli([...args, '--json']); assert.equal(observed.status, 0, observed.stderr); assert.equal(JSON.parse(observed.stdout).recorded, true);
  const retry = cli(args); assert.equal(retry.status, 0, retry.stderr); assert.equal((decodeToon(retry.stdout) as { recorded: boolean }).recorded, false);
  const durable = await snapshot(workspace);
  for (const format of [[], ['--json']]) {
    const report = cli(['utility', 'native', ...format]); assert.equal(report.status, 0, report.stderr);
    const decoded = (format.length ? JSON.parse(report.stdout) : decodeToon(report.stdout)) as { lifetime: { scored: number; observations: number; unscored: { confounded: number } } };
    assert.equal(decoded.lifetime.observations, 1); assert.equal(decoded.lifetime.scored, 0); assert.equal(decoded.lifetime.unscored.confounded, 1);
    assert.ok(Buffer.byteLength(report.stdout) < 4000, 'selected-memory report remains compact');
  }
  assert.deepEqual(await snapshot(workspace), durable, 'reports do not mutate durable data');
  const bad = cli(['observe', 'native']); assert.equal(bad.status, 2); assert.match(bad.stderr, /Remedy:/);
  const conflict = cli([...args, '--outcome', 'worsened']); assert.equal(conflict.status, 3); assert.match(conflict.stderr, /memory conflict:/);
  assert.equal((await get('native', options)).recalls, 1);
});


test('recall preflights every emitted ledger before changing any counter', async t => {
  const { options, store, workspace } = await tracker(t);
  await remember('Guidance alpha about a release', { ...options, kind: 'project', slug: 'alpha' });
  const second = await remember('Guidance beta about validation', { ...options, kind: 'reference', slug: 'beta' });
  await store.fields(second.id, { utility: '{broken' });
  const before = await snapshot(workspace);
  await assert.rejects(recall('alpha release', options), refusal('schema'));
  assert.deepEqual(await snapshot(workspace), before);
});
