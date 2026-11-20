import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { estimatePmOutputTokens, EXIT_CODE, getHistoryPath, loadMutationCheckpoint, parseMutationReceipt, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { grantConsent, recallTask, remember, renew, type TaskRecallPacket } from '../index.ts';
import { installExtension, tracker } from './helpers.ts';
import { hostPublication } from './native-host-helpers.ts';
import { commitNativeFields, nativeState } from '../src/native-revision.ts';
import { nativeContentRevision } from '../src/content.ts';
import { conflictProjection } from '../src/task-recall.ts';

function pm(root: string, workspace: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), ...args], {
    cwd: root, encoding: 'utf8', input, env: { ...process.env, PM_PATH: workspace, PM_GLOBAL_PATH: join(root, 'global') },
  });
}

function update(root: string, workspace: string, id: string, flags: readonly string[], input?: string): void {
  const result = pm(root, workspace, ['update', id, ...flags, '--json'], input);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

/** Keep the CLI's selection order when arranging faults between native bulk rows. */
function previewBulkBodyUpdate(root: string, workspace: string, ids: string[], body: string) {
  const flags = ['update-many', '--ids', ids.join(','), '--body', body, '--json'];
  const preview = pm(root, workspace, [...flags, '--dry-run']);
  assert.equal(preview.status, EXIT_CODE.SUCCESS, preview.stdout + preview.stderr);
  const { item_plans } = JSON.parse(preview.stdout) as { item_plans: { id: string }[] };
  return { flags, orderedIds: item_plans.map(row => row.id) };
}

/** Install a tracker-local hook that runs a real mutation through an independent SDK client. */
async function installPeerHook(workspace: string, capabilities: string[], registration: string): Promise<void> {
  const dir = join(workspace, 'extensions', 'native-peer');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'native-peer', version: '1.0.0', entry: 'entry.js', capabilities }));
  await writeFile(join(dir, 'entry.js'), `
    import { PmClient } from ${JSON.stringify(import.meta.resolve('@unbrained/pm-cli/sdk'))};
    const peer = new PmClient({ pmRoot: ${JSON.stringify(workspace)}, author: 'native-peer', noExtensions: true });
    export default { activate(api) { ${registration} } };
  `);
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
  const stored = await store.read();
  const ranked = [current, previous].map(memory => stored.find(row => row.id === memory.id)!);
  const replacements = new Map([[previous.id, new Set(ranked.filter(row =>
    row.relationships.some(edge => edge.id === previous.id && edge.kind === 'supersedes')).map(row => row.id))]]);
  const project = conflictProjection(ranked, replacements, new Set());
  assert.deepEqual(project(2), { conflicts: [reference], unresolved: false });
  assert.deepEqual(project(1), { conflicts: [], unresolved: false });
  assert.deepEqual(project(2), { conflicts: [reference], unresolved: false });
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


test('stale conflict reasons must cover the current guidance', async t => {
  const { client, options, store } = await tracker(t);
  const { item: { id: task } } = await client.create({ type: 'Task', title: 'Review release smoke tests' });
  const instruction = 'run the release smoke tests before signing and packaging the final artifacts';
  const linked = { ...options, kind: 'project' as const, links: [task], forceNew: true };
  await remember(`Always ${instruction}.`, { ...linked, slug: 'current' });
  const stale = await remember(`Never ${instruction}.`, { ...linked, slug: 'stale' });
  const recall = () => recallTask(task, { ...options, intent: 'resume-evidence', tokenBudget: 1800 });
  await store.fields(stale.id, { verdict: 'stale', reason: 'The trial exemption has expired.' });
  await client.update(stale.id, { priority: '1' });
  assert.equal((await recall()).conflicts?.[0]?.item_id, stale.id);

  const body = `Never ${instruction} locally.`;
  await client.update(stale.id, { body });
  const { item } = await client.get(stale.id, { full: true });
  assert.equal(item.memory_verdict, 'stale');
  assert.equal(item.memory_reason, 'The trial exemption has expired.');
  const edited = await recall();
  assert.deepEqual(edited.conflicts, []);
  assert.ok(edited.omission_receipt.omitted_field_groups.some(group => group.name === 'conflict_sources'));
  assert.equal(edited.memories.find(row => row.slug === stale.slug)!.body, body);

  await store.fields(stale.id, { reason: 'The operator-only exemption has expired.' });
  assert.equal((await recall()).conflicts?.[0]?.field, 'memory_reason');

  await client.run('update', { id: stale.id, options: {
    body: `Never ${instruction} remotely.`, memoryReason: 'The remote exemption has expired.',
  } });
  assert.equal((await recall()).conflicts?.[0]?.item_id, stale.id);
});

test('guidance edits invalidate native verification in the same history entry', async t => {
  const { client, options, root, store, workspace } = await tracker(t);
  const taskId = (await client.create({ title: 'Review packaging instructions', type: 'Task' })).item.id;
  const old = '2020-01-01T00:00:00.000Z';
  const recall = () => recallTask(taskId, { ...options, intent: 'resume-evidence', tokenBudget: 1800 });
  const memory = await remember('Use the original packaging instructions.', { ...options, kind: 'project', slug: 'packaging', links: [taskId] });
  await installExtension(workspace);
  const editNative = (flags: readonly string[], input?: string) => update(root, workspace, memory.id, flags, input);
  const edits = [
    { field: 'body', value: 'Use the revised packaging instructions.', edit: (value: string) => remember(value, { ...options, update: memory.slug, kind: 'project' }) },
    { field: 'body', value: 'Read the packaging checklist.', edit: (value: string) => editNative(['--body', value]) },
    { field: 'title', value: 'Packaging checklist', edit: (value: string) => editNative(['--title', value]) },
    { field: 'body', value: 'Follow the file-backed checklist.', edit: async (value: string) => {
      const file = join(root, 'guidance.md');
      await writeFile(file, value);
      editNative(['--body-file', file]);
    } },
    { field: 'body', value: 'Process the JSON packaging instructions.', edit: (value: string) => editNative(['--stdin-json'], JSON.stringify({ body: value })) },
    { field: 'body', value: '-', edit: (value: string) => {
      const full = pm(root, workspace, ['get', memory.id, '--full', '--json']);
      assert.equal(full.status, 0, full.stderr + full.stdout);
      const document = JSON.parse(full.stdout);
      assert.equal(document.item.memory_verdict, 'verified');
      assert.equal(document.item.memory_reason, 'Approved packaging guidance');
      assert.ok(document.item.memory_verified_at);
      document.item.body = value;
      editNative(['--stdin-json'], JSON.stringify(document));
    } },
    { field: 'title', value: 'Standalone packaging guidance', edit: async (value: string) => {
      const { proof } = await nativeState(store, memory.id);
      assert.equal(await commitNativeFields(store, memory.id, proof, { title: value }), true);
    } },
    { field: 'body', value: 'Apply the signed packaging checklist.', edit: async (value: string) => {
      const { proof } = await nativeState(store, memory.id);
      assert.equal(await hostPublication({ id: memory.id, options }, proof, { body: value }), true);
    } },
  ] as const;
  for (const [index, { field, value, edit }] of edits.entries()) {
    const prior = index === 0 ? '2090-01-01T00:00:00.000Z' : old;
    await store.fields(memory.id, { changed_at: prior, verdict: 'verified', verified_at: prior, reason: 'Approved packaging guidance' });
    assert.equal((await recall()).memories[0].freshness, 'fresh', value);
    const path = getHistoryPath(workspace, memory.id);
    const before = await readHistoryEntries(path, memory.id);
    await edit(value);
    const { item } = await client.get(memory.id, { full: true });
    assert.equal(item[field], value);
    assert.ok(Date.parse(String(item.memory_changed_at)) > Date.parse(prior), value);
    assert.equal(item.memory_verified_at, undefined, value);
    assert.equal(item.memory_reason, undefined, value);
    assert.equal((await recall()).memories[0].freshness, 'unverified', value);
    const after = await readHistoryEntries(path, memory.id);
    assert.equal(after.length, before.length + 1, value);
    const paths = after.at(-1)!.patch.map(patch => patch.path);
    for (const changed of [field === 'body' ? '/body' : '/metadata/title', '/metadata/memory_changed_at', '/metadata/memory_verified_at']) {
      assert.ok(paths.includes(changed), changed);
    }
  }
});


test('native operational edits and identical guidance retain current verification', async t => {
  const { client, options, root, store, workspace } = await tracker(t);
  const task = (await client.create({ title: 'Unrelated work item', type: 'Task' })).item.id;
  const memory = await remember('Read the instructions.', { ...options, kind: 'reference', slug: 'guidance', why: 'Use the published instructions', how: 'Use the checklist' });
  const old = '2020-01-01T00:00:00.000Z';
  await store.fields(memory.id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Approved guidance' });
  await installExtension(workspace);

  update(root, workspace, task, ['--body', 'Unrelated work change']);
  update(root, workspace, memory.id, ['--priority', '1', '--body', 'Read the instructions.']);
  const nativeDocument = pm(root, workspace, ['get', memory.id, '--full', '--json']);
  assert.equal(nativeDocument.status, 0, nativeDocument.stderr + nativeDocument.stdout);
  update(root, workspace, memory.id, ['--stdin-json'], nativeDocument.stdout);
  update(root, workspace, memory.id, ['--stdin-json', '--priority', '2'], nativeDocument.stdout);
  const sameBody = join(root, 'same.md');
  await writeFile(sameBody, 'Read the instructions.');
  update(root, workspace, memory.id, ['--stdin-json', '--body-file', sameBody], '{}');
  const invalid = pm(root, workspace, ['update', memory.id, '--stdin-json', '--body', '-', '--json'], '{}');
  assert.equal(invalid.status, 2, invalid.stderr + invalid.stdout);
  assert.match(JSON.parse(invalid.stderr).detail, /Only one option may consume stdin/);
  const malformed = pm(root, workspace, ['update', memory.id, '--stdin-json'], '{');
  assert.equal(malformed.status, 2, malformed.stderr + malformed.stdout);
  assert.match(malformed.stderr, /JSON/i);
  update(root, workspace, memory.id, ['--priority', '0', '--field', 'memory_how =Use the checklist ']);
  const { item } = await client.get(memory.id, { full: true });
  assert.equal(item.priority, 0);
  assert.deepEqual([item.memory_how, item.memory_changed_at, item.memory_verdict, item.memory_verified_at, item.memory_reason],
    ['Use the checklist', old, 'verified', old, 'Approved guidance']);

  await client.update(memory.id, { unset: ['memory_changed_at'] });
  for (const [field, value, flags] of [
    ['tags', ['packaging'], ['--add-tags', 'packaging']],
    ['tags', [], ['--remove-tags', 'packaging']],
    ['memory_why', undefined, ['--unset', 'memory_why']],
    ['memory_how', 'Use the revised checklist', ['--field', 'memory_how=Use the revised checklist']],
  ] as const) {
    await store.fields(memory.id, { verdict: 'verified', verified_at: old });
    update(root, workspace, memory.id, flags);
    const edited = (await client.get(memory.id, { full: true })).item;
    assert.deepEqual(edited[field], value);
    assert.equal(edited.memory_verified_at, undefined);
  }
});

/** Assert that a committed guidance change advanced the clock and removed its prior evidence. */
function assertInvalidatedVerification(item: Record<string, unknown>, previous: string): void {
  assert.ok(Date.parse(String(item.memory_changed_at)) > Date.parse(previous));
  assert.deepEqual([item.memory_verdict, item.memory_verified_at, item.memory_reason], ['unknown', undefined, undefined]);
}

test('native body files preserve unchanged guidance and treat file data as literal', async t => {
  const { client, options, root, store, workspace } = await tracker(t);
  const memory = await remember('Read the instructions.', { ...options, kind: 'reference', slug: 'body-file' });
  const old = '2020-01-01T00:00:00.000Z';
  await store.fields(memory.id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Approved guidance' });
  await installExtension(workspace);
  const history = () => readHistoryEntries(getHistoryPath(workspace, memory.id), memory.id);
  const before = await history();
  const stored = (await client.get(memory.id, { full: true })).item;
  const path = join(root, 'body.md');
  await writeFile(path, stored.body!);
  update(root, workspace, memory.id, ['--body-file', path]);
  update(root, workspace, memory.id, ['--body-file', '-'], stored.body);
  assert.deepEqual((await client.get(memory.id, { full: true })).item, stored);
  assert.deepEqual(await history(), before);

  const conflict = pm(root, workspace, ['update', memory.id, '--body-file', '-', '--description', '-', '--json'], 'Conflicting stdin');
  assert.equal(conflict.status, EXIT_CODE.USAGE, conflict.stdout + conflict.stderr);
  assert.match(conflict.stderr, /Only one option may consume stdin/u);
  const twoBodies = pm(root, workspace, ['update', memory.id, '--body-file', path, '--body', 'Inline', '--json']);
  assert.equal(twoBodies.status, EXIT_CODE.USAGE, twoBodies.stdout + twoBodies.stderr);
  assert.match(twoBodies.stderr, /mutually exclusive/u);
  assert.deepEqual(await history(), before);

  await writeFile(path, '-');
  update(root, workspace, memory.id, [
    '--body-file', path, '--description', '-', '--acceptance-criteria', 'Check examples', '--acceptance-criteria', 'Check output', '--regression',
  ], 'Read this description from stdin');
  const { item } = await client.get(memory.id, { full: true });
  assert.equal(item.body, '-');
  assert.equal(item.description, 'Read this description from stdin');
  assert.equal(item.acceptance_criteria, 'Check examples; Check output');
  assert.equal(item.regression, true);
  assertInvalidatedVerification(item, old);
  const after = await history();
  assert.equal(after.length, before.length + 1);
  const changes = after.at(-1)!.patch.map(patch => patch.path);
  for (const field of ['/body', '/metadata/memory_changed_at', '/metadata/memory_verdict', '/metadata/memory_verified_at', '/metadata/memory_reason']) assert.ok(changes.includes(field), field);
});

test('deferred stdin descriptions preserve verification only when the resolved text matches', async t => {
  const { client, options, root, store, workspace } = await tracker(t);
  const memory = await remember('-', { ...options, kind: 'reference', slug: 'stdin-description' });
  const old = '2020-01-01T00:00:00.000Z';
  await client.update(memory.id, { description: 'The publication checklist.' });
  await store.fields(memory.id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Approved checklist' });
  await installExtension(workspace);
  const bodyFile = join(root, 'literal-body.md');
  await writeFile(bodyFile, '-');
  const flags = ['--body-file', bodyFile, '--description', '-'];
  const history = () => readHistoryEntries(getHistoryPath(workspace, memory.id), memory.id);
  const stored = (await client.get(memory.id, { full: true })).item;
  const before = await history();
  update(root, workspace, memory.id, flags, stored.description);
  assert.deepEqual((await client.get(memory.id, { full: true })).item, stored);
  assert.deepEqual(await history(), before);

  update(root, workspace, memory.id, flags, '-');
  const { item } = await client.get(memory.id, { full: true });
  assert.equal(item.body, '-');
  assert.equal(item.description, '-');
  assertInvalidatedVerification(item, old);
  const entries = (await history()).slice(before.length);
  assert.deepEqual(entries.map(entry => entry.patch.some(patch => patch.path === '/metadata/description')), [true]);
});

test('native JSON document updates leave Tasks free of memory verification fields', async t => {
  const { client, options, root, workspace } = await tracker(t);
  const task = (await client.create({ title: 'Ordinary document item', type: 'Task' })).item.id;
  const memory = await remember('Previous project guidance', { ...options, kind: 'reference', slug: 'converted-task' });
  await installExtension(workspace);
  await installPeerHook(workspace, ['preflight'], `
    api.registerPreflight({ commands: ['update'], async run({ args }) {
      if (args[0] === ${JSON.stringify(memory.id)}) {
        await peer.update(args[0], { type: 'Task', unset: ['memory_slug', 'memory_changed_at', 'memory_verdict'] });
      }
      return {};
    } });
  `);

  for (const id of [task, memory.id]) {
    update(root, workspace, id, ['--stdin-json'], JSON.stringify({ body: 'New Task instructions.' }));
    const { item } = await client.get(id, { full: true });
    assert.equal(item.type, 'Task');
    assert.equal(item.body, 'New Task instructions.');
    assert.equal(item.memory_changed_at, undefined);
    assert.equal(item.memory_verdict, undefined);
    const history = await readHistoryEntries(getHistoryPath(workspace, id), id);
    assert.ok(history.at(-1)!.patch.some(patch => patch.path === '/body'));
    assert.ok(history.at(-1)!.patch.every(patch => !patch.path.startsWith('/metadata/memory_')));
  }
});

test('native bulk updates revise each changed memory and retain ordinary batch rows', async t => {
  const { client, options, root, store, workspace } = await tracker(t);
  const task = (await client.create({ title: 'Ordinary batch item', type: 'Task', body: 'Old task guidance' })).item.id;
  const seed = (body: string, slug: string) => remember(body, { ...options, slug, kind: 'reference', forceNew: true });
  const next = 'Use the revised instructions.';
  const first = await seed('Read the original instructions.', 'first');
  const second = await seed('Read the other instructions.', 'second');
  const same = await seed(next, 'same');
  const old = '2020-01-01T00:00:00.000Z';
  const future = '2090-01-01T00:00:00.000Z';
  const clocks = new Map([[first.id, old], [second.id, future], [same.id, old]]);
  for (const [id, at] of clocks) await store.fields(id, { changed_at: at, verdict: 'verified', verified_at: at, reason: 'Prior review' });
  await installExtension(workspace);

  const bulk = (...flags: string[]) => {
    const result = pm(root, workspace, ['update-many', ...flags, '--json']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const ids = [task, first.id, second.id, same.id];
  const flags = ['--ids', ids.join(','), '--body', next, '--priority', '1', '--message', 'Apply the batch checklist.'];
  const histories = () => Promise.all(ids.map(id => readHistoryEntries(getHistoryPath(workspace, id), id)));
  const before = await histories();
  assert.equal(bulk(...flags, '--dry-run').matched_count, 4);
  assert.deepEqual(await histories(), before);
  const applied = bulk(...flags);
  assert.equal(applied.updated_count, 4);
  assert.equal(applied.failed_count, 0);
  for (const [index, history] of (await histories()).entries()) {
    assert.equal(history.length, before[index].length + 1);
    assert.equal(history.at(-1)?.message, 'Apply the batch checklist.');
  }
  for (const id of ids) {
    const { item } = await client.get(id, { full: true });
    assert.equal(item.body, next);
    assert.equal(item.priority, 1);
    if (id === task) {
      assert.equal(item.memory_changed_at, undefined);
      assert.equal(item.memory_verdict, undefined);
    } else if (id === same.id) {
      assert.deepEqual([item.memory_changed_at, item.memory_verdict, item.memory_verified_at, item.memory_reason], [old, 'verified', old, 'Prior review']);
    } else {
      assert.ok(Date.parse(String(item.memory_changed_at)) > Date.parse(clocks.get(id)!));
      assert.deepEqual([item.memory_verdict, item.memory_verified_at, item.memory_reason], ['unknown', undefined, undefined]);
      const paths = new Set((await readHistoryEntries(getHistoryPath(workspace, id), id)).at(-1)!.patch.map(patch => patch.path));
      for (const field of ['/body', '/metadata/memory_changed_at', '/metadata/memory_verdict', '/metadata/memory_verified_at', '/metadata/memory_reason']) assert.ok(paths.has(field), field);
    }
  }
  const rollback = bulk('--rollback', applied.checkpoint.id);
  assert.equal(rollback.restored_count, 4);
  assert.equal(rollback.failed_count, 0);
  const restored = (await client.get(second.id, { full: true })).item;
  assert.equal(restored.body, 'Read the other instructions.');
  assert.deepEqual([restored.memory_changed_at, restored.memory_verdict, restored.memory_verified_at, restored.memory_reason], [future, 'verified', future, 'Prior review']);
  assert.equal(bulk('--ids', task, '--priority', '0').updated_count, 1);
  const withoutCheckpoint = bulk('--ids', first.id, '--body', next, '--no-checkpoint');
  assert.equal(withoutCheckpoint.updated_count, 1);
  assert.equal(withoutCheckpoint.checkpoint, undefined);
});

/** Seed a bulk rollback with verified guidance so restored verification is observable. */
async function seedVerifiedBulk({ options, store, workspace }: Awaited<ReturnType<typeof tracker>>, slugs: string[]) {
  const original = 'Previous guidance.';
  const old = '2020-01-01T00:00:00.000Z';
  const ids: string[] = [];
  for (const slug of slugs) {
    const { id } = await remember(original, { ...options, kind: 'reference', slug, forceNew: true });
    ids.push(id);
    await store.fields(id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Prior review' });
  }
  await installExtension(workspace);
  return { ids, original, old };
}

/** Check the complete restored guidance and its native verification evidence. */
async function assertBulkRestored(client: Awaited<ReturnType<typeof tracker>>['client'], ids: string[], original: string, old: string) {
  for (const id of ids) {
    const { item } = await client.get(id, { full: true });
    assert.deepEqual([item.body, item.memory_changed_at, item.memory_verdict, item.memory_verified_at, item.memory_reason],
      [original, old, 'verified', old, 'Prior review']);
  }
}

test('native bulk receipts preserve committed rows and rollback after a later row throws', async t => {
  const trackerState = await tracker(t);
  const { client, root, workspace } = trackerState;
  const { ids, original, old } = await seedVerifiedBulk(trackerState, ['first', 'later', 'last']);
  const revised = 'Updated guidance.';
  const { flags, orderedIds: [first, later, last] } = previewBulkBodyUpdate(root, workspace, ids, revised);
  await installPeerHook(workspace, ['hooks'], `
    api.hooks.onWrite(async ({ item_id, op }) => {
      if (item_id === ${JSON.stringify(first)} && op === 'update') {
        await peer.delete(${JSON.stringify(later)}, { force: true });
      }
    });
  `);

  const failed = pm(root, workspace, flags);
  await assert.rejects(client.get(later, { full: true }), /was deleted/u);
  assert.equal((await client.get(first, { full: true })).item.body, revised);
  assert.equal(failed.status, EXIT_CODE.PARTIAL_EFFECT, failed.stdout + failed.stderr);
  const receipt = JSON.parse(failed.stdout);
  assert.equal(receipt.outcome, 'partial_effect');
  assert.equal(receipt.exit_code, EXIT_CODE.PARTIAL_EFFECT);
  assert.deepEqual([receipt.matched_count, receipt.updated_count, receipt.failed_count, receipt.skipped_count], [3, 2, 1, 0]);
  assert.deepEqual(receipt.ids, [first, last]);
  assert.deepEqual(receipt.rows.map(({ id, status }: { id: string; status: string }) => [id, status]),
    [[first, 'updated'], [later, 'failed'], [last, 'updated']]);
  assert.match(receipt.rows[1].error, /was deleted/u);
  assert.equal((await client.get(last, { full: true })).item.body, revised);

  assert.equal(receipt.checkpoint.rollback_command, `pm update-many --rollback ${receipt.checkpoint.id}`);
  const { record } = await loadMutationCheckpoint(workspace, 'update-many', receipt.checkpoint.id, 2);
  const checkpoints = record.memory_checkpoints as string[];
  assert.equal(checkpoints.length, 2);
  const children = await Promise.all(checkpoints.map(id => loadMutationCheckpoint(workspace, 'update-many', id, 2)));
  assert.deepEqual(children.map(child => child.items.map(item => item.id)), [[first], [last]]);
  const rollback = pm(root, workspace, ['update-many', '--rollback', receipt.checkpoint.id, '--json']);
  assert.equal(rollback.status, EXIT_CODE.SUCCESS, rollback.stdout + rollback.stderr);
  const restored = JSON.parse(rollback.stdout);
  assert.equal(restored.restored_count, 2);
  assert.deepEqual(restored.ids, [first, last]);
  assert.equal(restored.checkpoint_errors, undefined);
  await assertBulkRestored(client, restored.ids, original, old);
  await assert.rejects(client.get(later, { full: true }), /was deleted/u);
});

test('combined rollback keeps restored rows when child checkpoints cannot be loaded', async t => {
  const trackerState = await tracker(t);
  const { client, root, workspace } = trackerState;
  const { ids, original, old } = await seedVerifiedBulk(trackerState, ['first', 'second', 'third', 'last']);
  const revised = 'Updated guidance.';
  const { flags, orderedIds: [first, second, third, last] } = previewBulkBodyUpdate(root, workspace, ids, revised);
  const applied = pm(root, workspace, flags);
  assert.equal(applied.status, EXIT_CODE.SUCCESS, applied.stdout + applied.stderr);
  const { checkpoint } = JSON.parse(applied.stdout);
  const { record } = await loadMutationCheckpoint(workspace, 'update-many', checkpoint.id, 2);
  const [, missing, invalid] = record.memory_checkpoints as string[];
  const child = (id: string) => loadMutationCheckpoint(workspace, 'update-many', id, 2);
  await unlink((await child(missing)).path);
  await writeFile((await child(invalid)).path, '{');

  const rollback = pm(root, workspace, ['update-many', '--rollback', checkpoint.id, '--json']);
  assert.equal(rollback.status, EXIT_CODE.PARTIAL_EFFECT, rollback.stdout + rollback.stderr);
  const result = JSON.parse(rollback.stdout);
  assert.equal(result.outcome, 'partial_effect');
  assert.deepEqual([result.matched_count, result.restored_count, result.failed_count, result.skipped_count], [4, 2, 2, 0]);
  assert.deepEqual(result.ids, [first, last]);
  assert.deepEqual(result.rows.map(({ id, status }: { id: string; status: string }) => [id, status]),
    [[first, 'restored'], [last, 'restored']]);
  assert.deepEqual(result.checkpoint_errors.map(({ checkpoint_id }: { checkpoint_id: string }) => checkpoint_id), [missing, invalid]);
  assert.ok(result.checkpoint_errors.every(({ error }: { error: string }) => error.length > 0));
  await assertBulkRestored(client, result.ids, original, old);
  for (const id of [second, third]) assert.equal((await client.get(id, { full: true })).item.body, revised);
});

test('native bulk receipts keep committed rows when combined checkpoint publication fails', async t => {
  const { client, options, root, workspace } = await tracker(t);
  const original = 'Previous guidance.';
  const revised = 'Updated guidance.';
  const ids = [];
  for (const slug of ['first', 'second']) {
    const { id } = await remember(original, { ...options, kind: 'reference', slug, forceNew: true });
    ids.push(id);
  }
  await installExtension(workspace);
  const { flags, orderedIds } = previewBulkBodyUpdate(root, workspace, ids, revised);
  const checkpointDir = join(workspace, 'checkpoints', 'update-many');
  const savedDir = join(workspace, 'checkpoints', 'saved-children');
  await installPeerHook(workspace, ['hooks'], `
    api.hooks.onWrite(async ({ item_id, op }) => {
      if (item_id === ${JSON.stringify(orderedIds.at(-1))} && op === 'update') {
        const { rename, writeFile } = await import('node:fs/promises');
        await rename(${JSON.stringify(checkpointDir)}, ${JSON.stringify(savedDir)});
        await writeFile(${JSON.stringify(checkpointDir)}, 'Block combined checkpoint publication', { flag: 'wx' });
      }
    });
  `);

  const failed = pm(root, workspace, flags);
  for (const id of ids) assert.equal((await client.get(id, { full: true })).item.body, revised);
  assert.equal(failed.status, EXIT_CODE.DEPENDENCY_FAILED, failed.stdout + failed.stderr);
  const receipt = JSON.parse(failed.stdout);
  assert.equal(receipt.outcome, 'dependency_failed');
  assert.equal(receipt.exit_code, EXIT_CODE.DEPENDENCY_FAILED);
  assert.deepEqual([receipt.matched_count, receipt.updated_count, receipt.failed_count, receipt.skipped_count], [2, 2, 0, 0]);
  assert.deepEqual(receipt.ids, orderedIds);
  assert.deepEqual(receipt.rows.map(({ id, status }: { id: string; status: string }) => [id, status]),
    orderedIds.map(id => [id, 'updated']));
  assert.equal(receipt.checkpoint, undefined);
  assert.equal(receipt.checkpoint_error.code, 'combined_checkpoint_write_failed');
  assert.match(receipt.checkpoint_error.detail, /EEXIST|ENOTDIR/u);
  await unlink(checkpointDir);
  await rename(savedDir, checkpointDir);
  for (const id of orderedIds) {
    const { item } = await client.get(id, { full: true });
    const history = await readHistoryEntries(getHistoryPath(workspace, id), id);
    const childId = history.at(-1)?.context?.bulk_checkpoint;
    assert.ok(typeof childId === 'string');
    const child = await loadMutationCheckpoint(workspace, 'update-many', childId, 2);
    assert.deepEqual(child.items.map(row => row.id), [id]);
    const rollback = pm(root, workspace, ['update-many', '--rollback', child.id, '--json']);
    assert.notEqual(rollback.status, EXIT_CODE.SUCCESS, rollback.stdout + rollback.stderr);
    const refused = JSON.parse(rollback.stdout);
    assert.equal(refused.restored_count, 0);
    assert.equal(refused.failed_count, 1);
    assert.match(refused.rows[0].error, /Memory guidance edits must invalidate verification/u);
    assert.deepEqual((await client.get(id, { full: true })).item, item);
    assert.deepEqual(await readHistoryEntries(getHistoryPath(workspace, id), id), history);
  }
  assert.equal(receipt.child_checkpoint_ids, undefined);
  assert.match(receipt.checkpoint_error.detail, /Memory rollback requires the combined checkpoint/u);
});


test('native tag replacement preserves verification for equivalent tags', async t => {
  const { client, options, root, store, workspace } = await tracker(t);
  const memory = await remember('Use the approved packaging guidance.', { ...options, kind: 'reference', tags: ['approved', 'packaging'] });
  const old = '2020-01-01T00:00:00.000Z';
  await store.fields(memory.id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Approved packaging guidance' });
  await installExtension(workspace);
  const path = getHistoryPath(workspace, memory.id);
  const before = await readHistoryEntries(path, memory.id);
  const stored = (await client.get(memory.id, { full: true })).item;
  const replacement = { tags: ['packaging', 'approved'] };
  nativeContentRevision(replacement, stored);
  assert.deepEqual(replacement, { tags: ['packaging', 'approved'] });

  for (const tags of ['["approved","packaging"]', ' Packaging,approved,APPROVED ']) {
    update(root, workspace, memory.id, ['--tags', tags]);
    const { item } = await client.get(memory.id, { full: true });
    assert.deepEqual(item.tags, ['approved', 'packaging']);
    assert.deepEqual([item.memory_changed_at, item.memory_verdict, item.memory_verified_at, item.memory_reason],
      [old, 'verified', old, 'Approved packaging guidance']);
    assert.deepEqual(await readHistoryEntries(path, memory.id), before);
  }

  update(root, workspace, memory.id, ['--tags', 'approved,shipping']);
  const { item } = await client.get(memory.id, { full: true });
  assert.deepEqual(item.tags, ['approved', 'shipping']);
  assert.ok(Date.parse(String(item.memory_changed_at)) > Date.parse(old));
  assert.equal(item.memory_verdict, 'unknown');
  assert.equal(item.memory_verified_at, undefined);
  assert.equal(item.memory_reason, undefined);
  const after = await readHistoryEntries(path, memory.id);
  assert.equal(after.length, before.length + 1);
  const changed = after.at(-1)!.patch.map(patch => patch.path.split('/')[2]);
  for (const field of ['tags', 'memory_changed_at', 'memory_verdict', 'memory_verified_at', 'memory_reason']) {
    assert.ok(changed.includes(field), `Missing native history patch for ${field}`);
  }
});

test('task recall requires history evidence for guidance changed outside extension hooks', async t => {
  const { client, options, store, workspace } = await tracker(t);
  const task = (await client.create({ title: 'Review historical packaging', type: 'Task' })).item.id;
  const memory = await remember('Review the historic instructions.', { ...options, kind: 'reference', slug: 'history', links: [task] });
  const old = '2020-01-01T00:00:00.000Z';
  const state = async () => (await recallTask(task, { ...options, intent: 'resume-evidence' })).memories[0].freshness;
  await store.fields(memory.id, { changed_at: old, verdict: 'verified', verified_at: old });
  assert.equal(await state(), 'fresh');

  await client.update(memory.id, { title: 'A native title changed with extensions disabled' });
  assert.equal((await client.get(memory.id, { full: true })).item.memory_verified_at, old);
  assert.equal(await state(), 'unverified');

  await store.fields(memory.id, { verified_at: new Date().toISOString() });
  assert.equal(await state(), 'fresh');
  const path = getHistoryPath(workspace, memory.id);
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  await writeFile(path, lines.slice(0, -1).join('\n') + '\n');
  assert.equal(await state(), 'unverified');
  await writeFile(path, 'incomplete history');
  assert.equal(await state(), 'unverified');

  const initial = parseMutationReceipt(await client.run('create', { options: {
    title: 'Imported verification', body: 'Review the signed checklist.', type: 'Knowledge',
    memorySlug: 'imported', memoryKind: 'reference', memoryChangedAt: old, memoryVerdict: 'verified', memoryVerifiedAt: old,
  } }));
  await store.link(initial.id, task);
  const packet = await recallTask(task, { ...options, intent: 'resume-evidence', tokenBudget: 1800 });
  assert.equal(packet.memories.find(row => row.slug === 'imported')?.freshness, 'fresh');

  await client.update(initial.id, { title: 'Revised imported guidance' });
  const imported = (await client.get(initial.id, { full: true })).item;
  assert.equal(imported.title, 'Revised imported guidance');
  assert.deepEqual([imported.memory_changed_at, imported.memory_verified_at, imported.memory_verdict], [old, old, 'verified']);
  const revised = await recallTask(task, { ...options, intent: 'resume-evidence', tokenBudget: 1800 });
  assert.equal(revised.memories.find(row => row.slug === 'imported')?.freshness, 'unverified');
});
