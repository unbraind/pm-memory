import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { estimatePmOutputTokens, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { grantConsent, recallTask, remember, renew, type TaskRecallPacket } from '../index.ts';
import { installExtension, tracker } from './helpers.ts';

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

  const cli = (args: string[]) => spawnSync(process.execPath, [
    join(import.meta.dirname, '../node_modules/.bin/pm'), 'memory', 'recall-task', taskId, ...args,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, PM_PATH: workspace, PM_GLOBAL_PATH: join(root, 'global') } });
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
  const refused = cli(['--token-budget', '1', '--json']);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout || refused.stderr).code, 'budget');
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
  await assert.rejects(recallTask(taskId, { ...options, intent: 'unmatched' }), { code: 'intent' });
});
