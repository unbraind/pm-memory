import assert from 'node:assert/strict';
import { mkdir, readFile, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { estimatePmOutputTokens, getHistoryPath, getItemPath, getSettingsPath } from '@unbrained/pm-cli/sdk';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { grantConsent, recallTaskFederated, remember, type FederatedTaskRecallPacket } from '../index.ts';
import { runCommand } from '../src/commands.ts';
import { gitlessCli, installExtension, tracker } from './helpers.ts';

test('federated CLI uses exact selections, returns source-tagged rows, and leaves native history intact', async t => {
  const local = await tracker(t);
  const first = await tracker(t);
  const second = await tracker(t);
  const id = (await local.client.create({ title: 'Assemble the optical bench', id: 'memory-test-primary', type: 'Task' })).item.id;
  await first.client.create({ title: 'Assemble the optical bench', id, type: 'Task' });
  const secondary = (await second.client.create({ title: 'Calibrate the telescope', type: 'Task' })).item.id;
  const fact = await remember('Use the machined plate on the bench.', { ...first.options, kind: 'project', slug: 'installation', links: [id], how: 'Align the outer marks.' });
  const neighbor = await remember('Use a bright star for calibration.', { ...second.options, kind: 'project', slug: 'installation', links: [secondary] });
  const hidden = await remember('Only the owner may see the optical schematic.', { ...local.options, kind: 'project', slug: 'host-only', links: [id] });
  const scoped = await remember('Retain the private calibration record.', { ...second.options, kind: 'project', slug: 'private-record', links: [secondary] });
  await grantConsent(scoped.slug, { ...second.options, purpose: 'review', fields: ['body'] });
  const snapshots = [getSettingsPath(first.workspace), getSettingsPath(second.workspace), getHistoryPath(first.workspace, fact.id), getHistoryPath(second.workspace, neighbor.id), getHistoryPath(second.workspace, scoped.id)];
  const before = await Promise.all(snapshots.map(file => readFile(file)));

  // A foreign extension must never run while this tracker is read through the federation.
  const foreign = join(second.workspace, 'extensions', 'foreign');
  const marker = join(second.root, 'activated');
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, 'manifest.json'), JSON.stringify({ name: 'foreign', version: '2026.11.20', entry: 'entry.mjs', capabilities: ['hooks'] }));
  await writeFile(join(foreign, 'entry.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'activated'); export default { name: 'foreign', version: '2026.11.20' };`);

  await installExtension(local.workspace);
  const cli = gitlessCli(local.root, local.workspace);
  const firstPath = relative(local.root, first.workspace);
  const secondPath = relative(local.root, second.workspace);
  const secondSelector = secondary + '=' + secondPath;
  const args = ['recall-task', id, '--for', 'resume', '--token-budget', '800', '--tracker', firstPath, '--tracker', secondSelector, '--share-tracker', firstPath, '--share-tracker', secondSelector];
  for (const format of ['json', 'toon']) {
    const result = cli([...args, '--output-format', format]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const packet = (format === 'json' ? JSON.parse(result.stdout) : decodeToon(result.stdout)) as FederatedTaskRecallPacket;
    assert.deepEqual(packet.memories, [
      { tracker: firstPath, slug: 'installation', body: 'Use the machined plate on the bench.', how: 'Align the outer marks.' },
      { tracker: secondPath, slug: 'installation', body: 'Use a bright star for calibration.' },
    ]);
    assert.deepEqual(packet.sources, [
      { tracker: firstPath, task_id: id, basis: 'linked', status: 'included', included: 1, omitted: 0, ineligible: 0 },
      { tracker: secondPath, task_id: secondary, basis: 'linked', status: 'included', included: 1, omitted: 0, ineligible: 1 },
    ]);
    assert.equal(packet.output_fit.total_candidates, 2);
    assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= packet.output_fit.estimated_tokens);
    assert.ok(packet.output_fit.estimated_tokens <= 800);
    assert.doesNotMatch(result.stdout, new RegExp(`${hidden.slug}|${scoped.slug}`));
  }
  const denied = cli(['recall-task', id, '--tracker', secondSelector, '--json']);
  assert.equal(denied.status, 0, denied.stderr);
  assert.deepEqual(JSON.parse(denied.stdout).sources, [{ tracker: secondPath, task_id: secondary, status: 'ineligible', reason: 'sharing_not_allowed' }]);
  const literal = await runCommand('recall-task', {
    command: 'memory recall-task', pm_root: local.workspace, args: [id], global: {},
    options: { tracker: './name=literal' },
  }) as FederatedTaskRecallPacket;
  assert.deepEqual(literal.sources, [{ tracker: './name=literal', task_id: id, status: 'ineligible', reason: 'sharing_not_allowed' }]);
  const unmatched = cli(['recall-task', id, '--share-tracker', firstPath, '--json']);
  assert.equal(unmatched.status, 2);
  assert.match(unmatched.stderr, /Sharing approval has no matching tracker selector/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all(snapshots.map(file => readFile(file))), before);
});

test('federation refuses duplicate symlink aliases and matches approvals by canonical directory', async t => {
  const source = await tracker(t);
  const id = (await source.client.create({ title: 'Measure the optical plate', type: 'Task' })).item.id;
  await remember('Align the plate before measuring.', { ...source.options, kind: 'project', slug: 'plate', links: [id] });
  const alias = join(source.root, 'tracker-alias');
  await symlink(source.workspace, alias, 'dir');
  await assert.rejects(recallTaskFederated(id, {
    sources: [source.workspace, alias].map(tracker => ({ tracker, allowSharing: true })),
  }), { code: 'invalid', message: 'Duplicate tracker selection' });

  await installExtension(source.workspace);
  const cli = gitlessCli(source.root, source.workspace);
  const direct = relative(source.root, source.workspace);
  const duplicate = cli(['recall-task', id, '--tracker', direct, '--tracker', 'tracker-alias',
    '--share-tracker', direct, '--share-tracker', 'tracker-alias', '--json']);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /Duplicate tracker selection/);

  const result = cli(['recall-task', id, '--tracker', id + '=tracker-alias', '--share-tracker', id + '=' + direct, '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const packet = JSON.parse(result.stdout) as FederatedTaskRecallPacket;
  assert.deepEqual(packet.sources, [
    { tracker: 'tracker-alias', task_id: id, basis: 'linked', status: 'included', included: 1, omitted: 0, ineligible: 0 },
  ]);
  assert.deepEqual(packet.memories, [{ tracker: 'tracker-alias', slug: 'plate', body: 'Align the plate before measuring.' }]);
  assert.equal(packet.output_fit.total_candidates, 1);

  const mismatchedTask = cli(['recall-task', id, '--tracker', id + '=tracker-alias', '--share-tracker', direct, '--json']);
  assert.equal(mismatchedTask.status, 2);
  assert.match(mismatchedTask.stderr, /Sharing approval has no matching tracker selector/);

  const unavailable = cli(['recall-task', id, '--tracker', 'absent', '--share-tracker', 'absent', '--json']);
  assert.equal(unavailable.status, 0, unavailable.stdout + unavailable.stderr);
  assert.deepEqual(JSON.parse(unavailable.stdout).sources, [
    { tracker: 'absent', task_id: id, status: 'unavailable', reason: 'tracker_read_failed' },
  ]);
});

test('federation accounts for unapproved, unavailable, policy-withheld, and empty sources', async t => {
  const current = await tracker(t);
  const outdated = await tracker(t);
  const corrupt = await tracker(t);
  const linked = await tracker(t);
  const read = (tracker: string, taskId?: string) => ({ tracker, taskId, allowSharing: true });
  const taskId = (await current.client.create({ title: 'Mount the rectangular radio panel', type: 'Task' })).item.id;
  const protectedRow = await remember('Mount the radio panel behind the test mask.', { ...current.options, kind: 'project', slug: 'protected-panel', links: [taskId] });
  await grantConsent(protectedRow.slug, { ...current.options, purpose: 'review', fields: ['body', 'why', 'how'] });
  const legacy = await remember('Mount the spare radio panel.', { ...current.options, kind: 'project', slug: 'legacy-panel', links: [taskId] });
  const itemPath = getItemPath(current.workspace, 'Knowledge', legacy.id, 'toon', { Knowledge: 'knowledge' });
  const bytes = await readFile(itemPath, 'utf8');
  assert.match(bytes, /body: Mount the spare radio panel\./);
  await writeFile(itemPath, bytes.replace('body: Mount the spare radio panel.', 'body: Mount the radio panel using password=synthetic071test.'));

  const settingsPath = getSettingsPath(outdated.workspace);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  await writeFile(settingsPath, JSON.stringify({ ...settings, version: 999 }));
  await writeFile(getSettingsPath(corrupt.workspace), '{');
  await rmdir(join(linked.workspace, 'tasks'));
  await symlink(join(current.workspace, 'knowledge'), join(linked.workspace, 'tasks'));
  const missing = join(current.workspace, 'absent');
  const denied = join(current.workspace, 'outside-selection');
  const noTask = join(corrupt.root, 'empty');
  await mkdir(noTask);
  await writeFile(getSettingsPath(noTask), JSON.stringify(settings));
  const packet = await recallTaskFederated(taskId, {
    sources: [
      { tracker: denied }, read(missing), read(outdated.workspace), read(corrupt.workspace),
      read(linked.workspace), read(noTask), read(current.workspace),
    ],
    tokenBudget: 1800,
  });
  assert.deepEqual(packet.sources.map(source => [source.status, 'reason' in source ? source.reason : undefined]), [
    ['ineligible', 'sharing_not_allowed'],
    ['unavailable', 'tracker_read_failed'],
    ['unavailable', 'unsupported_version'],
    ['unavailable', 'tracker_read_failed'],
    ['unavailable', 'tracker_read_failed'],
    ['unavailable', 'task_missing'],
    ['ineligible', 'memory_policy'],
  ]);
  assert.deepEqual(packet.sources.at(-1), { tracker: current.workspace, task_id: taskId, basis: 'lexical', included: 0, omitted: 0, ineligible: 2, status: 'ineligible', reason: 'memory_policy' });
  assert.deepEqual(packet.memories, []);
  assert.equal(packet.omission_receipt.has_omissions, false);
  assert.equal(packet.output_fit.omitted_count, 0);

  const bare = await tracker(t);
  const emptyId = (await bare.client.create({ title: 'Cultivate fruit trees', type: 'Task' })).item.id;
  const empty = await recallTaskFederated(emptyId, { sources: [read(bare.workspace)] });
  assert.deepEqual(empty.sources[0], { tracker: bare.workspace, task_id: emptyId, basis: 'lexical', included: 0, omitted: 0, ineligible: 0, status: 'included' });
  await assert.rejects(recallTaskFederated(taskId, { sources: [] }), { code: 'invalid' });
  await assert.rejects(recallTaskFederated(taskId, { sources: [read(noTask), read(noTask + '/.')] }), { code: 'invalid' });
});

test('source validation refuses unsupported native revisions and unsafe tracker files', async t => {
  const source = await tracker(t);
  const id = (await source.client.create({ title: 'Prepare the test chamber', type: 'Task' })).item.id;
  const sources = [{ tracker: source.workspace, allowSharing: true }];
  const expectReason = async (reason: string) => {
    const packet = await recallTaskFederated(id, { sources });
    assert.deepEqual(packet.sources, [{ tracker: source.workspace, task_id: id, status: 'unavailable', reason }]);
    assert.deepEqual(packet.memories, []);
  };
  const settingsPath = getSettingsPath(source.workspace);
  const settings = await readFile(settingsPath, 'utf8');
  await unlink(settingsPath);
  await mkdir(settingsPath);
  await expectReason('tracker_read_failed');
  await rmdir(settingsPath);
  await writeFile(settingsPath, settings);
  const ambiguous = join(source.root, 'trailing-space ');
  await mkdir(ambiguous);
  await writeFile(getSettingsPath(ambiguous), settings);
  const packet = await recallTaskFederated(id, { sources: [{ tracker: ambiguous, allowSharing: true }] });
  assert.deepEqual(packet.sources, [{ tracker: ambiguous, task_id: id, status: 'unavailable', reason: 'tracker_read_failed' }]);

  const schema = join(source.workspace, 'schema', 'fields.json');
  const fields = await readFile(schema, 'utf8');
  await writeFile(schema, '{');
  await expectReason('tracker_read_failed');
  await writeFile(schema, fields);

  const dir = join(source.workspace, 'tasks');
  const item = getItemPath(source.workspace, 'Task', id);
  const before = await readFile(item, 'utf8');
  await writeFile(item, before.replace(/^id:.+$/m, '$&\npm_format_version: 999'));
  await expectReason('unsupported_version');
  await writeFile(item, before);
  const foreign = join(dir, 'foreign.toon');
  await symlink(item, foreign);
  await expectReason('tracker_read_failed');
  await unlink(foreign);
  await unlink(item);
  await rmdir(dir);
  await symlink(dir, dir);
  await expectReason('tracker_read_failed');
});

test('incompatible memory field definitions fail closed before projecting shared content', async t => {
  const source = await tracker(t);
  const id = (await source.client.create({ title: 'Prepare the test chamber', type: 'Task' })).item.id;
  await remember('Check the ventilation before testing.', { ...source.options, kind: 'project', slug: 'ventilation', links: [id] });
  const settingsPath = getSettingsPath(source.workspace);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const fieldsPath = join(source.workspace, 'schema', 'fields.json');
  const file = JSON.parse(await readFile(fieldsPath, 'utf8'));
  const inline = settings.schema?.fields ?? [];
  const fields: { key: string; type: string }[] = [...inline, ...file.fields];
  const expected = { tracker: source.workspace, task_id: id, status: 'unavailable', reason: 'unsupported_version' };
  const options = { sources: [{ tracker: source.workspace, allowSharing: true }] };
  assert.ok(fields.some(field => field.key === 'memory_consent'));
  await writeFile(settingsPath, JSON.stringify({ ...settings, schema: { ...settings.schema, fields: [] } }));
  await writeFile(fieldsPath, JSON.stringify({ fields: fields.filter(field => field.key !== 'memory_consent') }));
  assert.deepEqual((await recallTaskFederated(id, options)).sources, [expected]);
  await writeFile(fieldsPath, JSON.stringify({ fields: fields.map(field => field.key === 'memory_slug' ? { ...field, type: 'boolean' } : field) }));
  assert.deepEqual((await recallTaskFederated(id, options)).sources, [expected]);
});

test('the whole envelope budget distinguishes full and partial tracker omission', async t => {
  const first = await tracker(t);
  const second = await tracker(t);
  const id = (await first.client.create({ title: 'Complete the chamber assembly', type: 'Task' })).item.id;
  await second.client.create({ id, title: 'Complete radio assembly', type: 'Task' });
  const large = 'Check each wiring connection against the schematic. '.repeat(75);
  await remember(large, { ...first.options, kind: 'project', slug: 'wiring', links: [id] });
  await remember('Use the calibrated reference gauge.', { ...second.options, kind: 'project', slug: 'reference-gauge', links: [id] });
  await remember('Check the antenna harness. ' + large, { ...second.options, kind: 'project', slug: 'antenna', links: [id], forceNew: true });
  const sources = [first.workspace, second.workspace].map(tracker => ({ tracker, allowSharing: true }));
  const compact = await recallTaskFederated(id, { sources, tokenBudget: 570 });
  assert.deepEqual(compact.sources.map(source => 'included' in source && [source.status, source.included, source.omitted]), [
    ['omitted', 0, 1], ['included', 1, 1],
  ]);
  assert.deepEqual(compact.memories.map(row => row.slug), ['reference-gauge']);
  assert.equal(compact.output_fit.omitted_count, 2);
  assert.ok(compact.output_fit.estimated_tokens <= 570);
  assert.deepEqual(compact.omission_receipt.omitted_field_groups, [{ name: 'matching_memories', restore_with: '--token-budget <larger-number>' }]);
  const restored = await recallTaskFederated(id, { sources, tokenBudget: 3400 });
  assert.deepEqual(restored.memories.map(row => row.slug), ['wiring', 'antenna', 'reference-gauge']);
  assert.equal(restored.omission_receipt.has_omissions, false);
  await assert.rejects(recallTaskFederated(id, { sources, tokenBudget: 1 }), { code: 'output_envelope_infeasible' });
});
