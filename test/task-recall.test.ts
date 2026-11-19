import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { estimatePmOutputTokens, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { grantConsent, recallTask, remember, renew, type TaskRecallPacket } from '../index.ts';
import { installExtension, tracker } from './helpers.ts';

function pm(root: string, workspace: string, args: string[]) {
  return spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PM_PATH: workspace, PM_GLOBAL_PATH: join(root, 'global') },
  });
}

test('native task resume ranks eligible relationships and leaves work and memory history intact', async t => {
  const { options, client, store, root, workspace } = await tracker(t);
  const taskId = (await client.create({ title: 'Compile the release manifest', description: 'Check the assembly inputs', type: 'Task' })).item.id;
  const writeOptions = { ...options, kind: 'project' as const };
  const direct = await remember('Use the release manifest from the assembly outputs.', {
    ...writeOptions, slug: 'assembly-manifest', links: [taskId], why: 'Inputs are verified.', how: 'Use the output manifest.',
  });
  const reverse = await remember('Retain the signing checklist.', { ...writeOptions, slug: 'signing-checklist' });
  await store.link(taskId, reverse.id);
  const unlinked = await remember('Review the release manifest in the source tree.', { ...writeOptions, slug: 'source-review' });
  const scoped = await remember('Separate approved material.', { ...writeOptions, slug: 'scoped', links: [taskId] });
  await grantConsent(scoped.slug, { ...options, purpose: 'review', fields: ['body'] });
  const archived = await remember('Prefer the historical inputs.', { ...writeOptions, slug: 'archived', links: [taskId] });
  await client.update(archived.id, { status: 'canceled', closeReason: 'Historical synthetic guidance' });
  const stale = await remember('Use the older compiler.', { ...writeOptions, slug: 'stale', links: [taskId] });
  await store.fields(stale.id, { verdict: 'stale' });
  const expired = await remember('Use the trial package.', { ...writeOptions, slug: 'expired', links: [taskId], pin: true });
  await renew(expired.slug, { ...options, from: '2020-01-01T00:00:00.000Z', until: '2020-02-01T00:00:00.000Z', evidence: 'Synthetic trial completed.' });

  await installExtension(workspace);
  const ids = [taskId, direct.id, reverse.id, unlinked.id, scoped.id, archived.id, stale.id, expired.id];
  const paths = [join(workspace, 'settings.json'), ...ids.map(id => getHistoryPath(workspace, id))];
  const before = await Promise.all(paths.map(path => readFile(path)));
  const packet = await recallTask(taskId, options);
  assert.equal(packet.task_id, taskId);
  assert.equal(packet.intent, 'resume');
  assert.equal(packet.basis, 'linked');
  assert.deepEqual(packet.memories, [
    { slug: 'assembly-manifest', body: 'Use the release manifest from the assembly outputs.', why: 'Inputs are verified.', how: 'Use the output manifest.' },
    { slug: 'signing-checklist', body: 'Retain the signing checklist.' },
  ]);
  assert.equal(packet.output_fit.total_candidates, 2);
  assert.equal(packet.omission_receipt.has_omissions, false);

  const cli = (args: string[]) => pm(root, workspace, ['memory', 'recall-task', taskId, ...args]);
  for (const format of ['toon', 'json'] as const) {
    const args = format === 'json' ? ['--json', '--for', 'resume', '--token-budget', '450'] : [];
    const result = cli(args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { omission_receipt: receipt, ...actual } = (format === 'json' ? JSON.parse(result.stdout) : decodeToon(result.stdout)) as TaskRecallPacket;
    const { omission_receipt: expectedReceipt, ...expected } = packet;
    assert.deepEqual(actual, expected);
    assert.deepEqual(receipt, format === 'json' ? expectedReceipt : 'complete');
    assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= actual.output_fit.estimated_tokens);
  }
  for (const [flag, value, code] of [['--token-budget', '1', 'budget'], ['--for', 'unmatched', 'intent']]) {
    const refused = cli([flag, value, '--json']);
    const diagnostic = `${flag} ${value} exited with status ${refused.status}\nstdout:\n${refused.stdout}\nstderr:\n${refused.stderr}`;
    assert.equal(refused.status, 2, diagnostic);
    let payload: { code?: unknown } | null;
    try {
      payload = JSON.parse(refused.stderr);
    } catch {
      assert.fail(`Expected a JSON refusal on stderr\n${diagnostic}`);
    }
    assert.equal(payload?.code, code, diagnostic);
  }
  const evidence = await recallTask(taskId, { ...options, intent: 'resume-evidence' });
  assert.deepEqual(new Set(evidence.memories.map(row => row.slug)), new Set(['assembly-manifest', 'signing-checklist', 'stale']));
  assert.deepEqual(evidence.conflicts, []);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
});

test('lexical fallback uses task description, preserves rank under pressure, and discloses omissions', async t => {
  const { options, client } = await tracker(t);
  const taskId = (await client.create({ title: 'Resume work', description: 'Calibrate the spectrometer', type: 'Task' })).item.id;
  const unrelatedId = (await client.create({ title: 'Orchard irrigation', type: 'Task' })).item.id;
  const writeOptions = { ...options, kind: 'reference' as const };
  const first = await remember('Calibrate the spectrometer first.\n' + 'Pad the calibration record. '.repeat(120), { ...writeOptions, slug: 'calibrate' });
  await remember('Use a lamp when the spectrometer is ready.', { ...writeOptions, slug: 'lamp' });
  await remember('Keep windows closed during the experiment.', { ...writeOptions, slug: 'windows', pin: true });

  const compact = await recallTask(taskId, { ...options, intent: 'resume', tokenBudget: 300 });
  assert.equal(compact.basis, 'lexical');
  assert.deepEqual(compact.memories, []);
  assert.equal(compact.output_fit.omitted_count, 2);
  assert.ok(compact.output_fit.estimated_tokens <= 300);
  assert.deepEqual(compact.omission_receipt.omitted_field_groups, [{ name: 'matching_memories', restore_with: '--token-budget <larger-number>' }]);
  const restored = await recallTask(taskId, { ...options, tokenBudget: 3000 });
  assert.deepEqual(restored.memories.map(row => row.slug), ['calibrate', 'lamp']);
  assert.equal(restored.omission_receipt.has_omissions, false);
  assert.deepEqual((await recallTask(unrelatedId, options)).memories, []);
  await assert.rejects(recallTask(first.id, options), { code: 'missing' });
  await assert.rejects(recallTask('memory-test-unknown', options), { code: 'missing' });
  await assert.rejects(recallTask(taskId, { ...options, tokenBudget: 1 }), { code: 'output_envelope_infeasible' });
  await assert.rejects(recallTask(taskId, { ...options, intent: 'unmatched' }), { code: 'unknown_context_intent' });
});


test('supersession identifies a single native relationship projection and omits pairs that do not fit', async t => {
  const { client, options, store, root, workspace } = await tracker(t);
  const taskId = (await client.create({ title: 'Run release smoke tests', type: 'Task' })).item.id;
  const previous = await remember('Never run release smoke tests.', {
    ...options, kind: 'project', slug: 'smoke-old', links: [taskId],
  });
  const current = await remember('Always run release smoke tests.', {
    ...options, kind: 'project', slug: 'smoke-new', links: [taskId], forceNew: true,
  });
  await store.link(current.id, previous.id, 'supersedes');
  await installExtension(workspace);

  const expected = [
    { slug: current.slug, body: 'Always run release smoke tests.', freshness: 'unverified', source_id: current.id, field: 'memory_verdict' },
    { slug: previous.slug, body: 'Never run release smoke tests.', freshness: 'superseded', source_id: current.id, field: 'dependencies' },
  ];
  const reference = { left: current.slug, right: previous.slug, item_id: current.id, field: 'dependencies' };
  for (const format of ['toon', 'json'] as const) {
    const result = pm(root, workspace, ['memory', 'recall-task', taskId, '--for', 'resume-evidence', ...(format === 'json' ? ['--json'] : [])]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const packet = (format === 'json' ? JSON.parse(result.stdout) : decodeToon(result.stdout)) as TaskRecallPacket;
    assert.deepEqual(packet.memories, expected);
    assert.deepEqual(packet.conflicts, [reference]);
    assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= packet.output_fit.estimated_tokens);
    assert.equal(packet.output_fit.token_budget, 450);
  }

  const projected = pm(root, workspace, ['get', reference.item_id, '--fields', reference.field, '--json']);
  assert.equal(projected.status, 0, projected.stderr + projected.stdout);
  assert.ok(JSON.parse(projected.stdout).item.dependencies.some((edge: { id: string; kind: string }) =>
    edge.id === previous.id && edge.kind === 'supersedes'));

  const bounded = await recallTask(taskId, { ...options, intent: 'resume-evidence', tokenBudget: 235 });
  assert.equal(bounded.output_fit.omitted_count, 1);
  assert.deepEqual(bounded.memories, expected.slice(0, 1));
  assert.deepEqual(bounded.conflicts, []);
  assert.deepEqual(bounded.omission_receipt.omitted_field_groups, [
    { name: 'matching_memories', restore_with: '--token-budget <larger-number>' },
  ]);

  await store.fields(previous.id, { pinned: true });
  const reversed = await recallTask(taskId, { ...options, intent: 'resume-evidence' });
  assert.deepEqual(reversed.conflicts, [{ ...reference, left: previous.slug, right: current.slug }]);

  await store.link(previous.id, current.id, 'supersedes');
  const reciprocal = await recallTask(taskId, { ...options, intent: 'resume-evidence' });
  assert.deepEqual(reciprocal.conflicts, []);
  assert.equal(reciprocal.omission_receipt.omitted_field_groups[0].name, 'conflict_sources');
});

test('native verification classifies each row and names a persisted reason for opposing guidance', async t => {
  const { client, options, store } = await tracker(t);
  const taskId = (await client.create({ title: 'Review release smoke tests', type: 'Task' })).item.id;
  const seed = (body: string, slug: string) => remember(body, {
    ...options, kind: 'project', slug, links: [taskId], forceNew: true,
  });
  const current = await seed('Always run the release smoke tests.', 'smoke-current');
  const outdated = await seed('Never run the release smoke tests.', 'smoke-outdated');
  const legacy = await seed('Retain the signed manifest.', 'manifest');
  const changed = await seed('Review the build log.', 'build-log');
  const missing = await seed('Retain the test results.', 'results');
  const hidden = await seed('Check the internal example.', 'separate-example');
  await grantConsent(hidden.slug, { ...options, purpose: 'review', fields: ['body'] });
  await store.link(hidden.id, current.id, 'supersedes');
  await store.link(current.id, taskId, 'supersedes');

  await store.fields(current.id, { verdict: 'verified', verified_at: new Date().toISOString() });
  await store.fields(outdated.id, { verdict: 'stale', reason: 'The trial exemption expired when the smoke suite was restored.' });
  await store.fields(legacy.id, { verdict: 'verified', verified_at: '2020-01-01T00:00:00.000Z' });
  await client.update(legacy.id, { unset: ['memory_changed_at'] });
  await store.fields(changed.id, { verdict: 'verified', verified_at: '2020-01-01T00:00:00.000Z' });
  await store.fields(missing.id, { verdict: 'verified' });
  await client.update(missing.id, { unset: ['memory_verified_at'] });

  const recall = () => recallTask(taskId, { ...options, intent: 'resume-evidence', tokenBudget: 1800 });
  const packet = await recall();
  assert.deepEqual(Object.fromEntries(packet.memories.map(row => [row.slug, [row.freshness, row.source_id, row.field]])), {
    [current.slug]: ['fresh', current.id, 'memory_verified_at'],
    [outdated.slug]: ['stale', outdated.id, 'memory_verdict'],
    [legacy.slug]: ['unverified', legacy.id, 'updated_at'],
    [changed.slug]: ['unverified', changed.id, 'memory_changed_at'],
    [missing.slug]: ['unverified', missing.id, 'memory_verified_at'],
  });
  assert.equal(packet.conflicts?.length, 1);
  const conflict = packet.conflicts[0];
  assert.deepEqual(new Set([conflict.left, conflict.right]), new Set([current.slug, outdated.slug]));
  assert.equal(conflict.item_id, outdated.id);
  assert.equal(conflict.field, 'memory_reason');
  const proof = await client.get(conflict.item_id, { fields: conflict.field });
  assert.ok('item' in proof);
  assert.equal(proof.item.memory_reason, 'The trial exemption expired when the smoke suite was restored.');

  await store.fields(current.id, { verdict: 'stale', reason: 'The trial required skipping the smoke suite.' });
  assert.deepEqual((await recall()).conflicts, []);
  await store.fields(outdated.id, { verdict: 'unknown' });
  assert.equal((await recall()).conflicts?.[0].item_id, current.id);
  await store.fields(current.id, { verdict: 'verified' });
  await store.fields(outdated.id, { verdict: 'stale', reason: '' });
  const unresolved = await recall();
  assert.deepEqual(unresolved.conflicts, []);
  assert.deepEqual(unresolved.omission_receipt.omitted_field_groups, [
    { name: 'conflict_sources', restore_with: 'pm memory get <slug>' },
  ]);
});
