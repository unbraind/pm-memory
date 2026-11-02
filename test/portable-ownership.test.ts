import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { exportDir, importDir, remember, renew, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { tracker, snapshot, crashAtStep, assertSkippedUnchanged, exportedPolicy, editIntent, crashAfterCompensation, assertOriginRefused, importText } from './helpers.ts';
import { WorkspaceTransactionInterruptedError, commitItemMutations, commitWorkspaceTransaction, sealHistoryRecord, appendHistoryEntry, type WorkspaceTransactionJsonValue, getHistoryPath, readHistoryEntries, getItemPath, canonicalDocument, serializeItemDocument, resolveItemTypeRegistry, readSettings } from '@unbrained/pm-cli/sdk';
import type { ImportPlan } from '../src/portable-plan.ts';
import { creationMetadata, recordedCreation } from '../src/portable-ownership.ts';

/** Prepare one real bounded export for wire-validation and compatibility regressions. */
async function policyScenario(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t); const target = await tracker(t);
  await remember('Baseline policy A', { ...source.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...source.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Ownership baseline' });
  const { path, manifest } = await exportedPolicy(source);
  return { source, target, path, manifest };
}

test('ownership identity: bounded guidance linked to a native Task is unchanged after a source round trip', async t => {
  const target = await tracker(t);
  const policy = await remember('Bounded ownership guidance', { ...target.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...target.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Ownership review' });
  const task = await target.client.create({ title: 'Native task outside the harness' });
  await target.store.link(policy.id, task.item.id);
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  const path = join(target.root, 'portable');
  const exported = await exportDir(path, { ...target.options, to: 'agents-md' });
  assert.ok(exported.omitted_links?.some(row => row.target === task.item.id));
  const imported = await importDir(path, { ...target.options, from: 'agents-md' });
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  assert.equal(imported.updated, 0);
});

test('legacy harness adapters preserve native metadata and natively removed wiki links', async t => {
  for (const from of ['claude-code', 'agents-md', 'cursor'] as const) {
    const target = await tracker(t); const source = join(target.root, 'legacy'); await mkdir(source);
    const alphaFile = join(source, 'alpha.md'); const text = '# Alpha\nInstructions [[beta]]';
    await writeFile(alphaFile, text); await writeFile(join(source, 'beta.md'), '# Beta\nOther instructions');
    await importDir(source, { ...target.options, from });
    const items = (await target.client.listAllComplete({ includeBody: true })).items;
    const alpha = items.find(item => item.memory_slug === 'alpha')!; const beta = items.find(item => item.memory_slug === 'beta')!;
    const task = await target.client.create({ title: 'Native Task' });
    await target.client.run('update', { id: alpha.id, options: { memoryPinned: true, memoryRecalls: 7, memoryVerdict: 'stale', memoryKind: 'feedback', memoryWhy: 'Native rationale', memoryHow: 'Native application', description: 'Native description', priority: 1, dep: [`id=${task.item.id},kind=supersedes,author=peer`, `id=${beta.id},kind=supersedes,author=peer`], depRemove: [`id=${beta.id},kind=related`] } });
    const before = (await target.client.get(alpha.id, { full: true })).item;
    assert.equal((await importDir(source, { ...target.options, from })).unchanged, 2);
    assert.deepEqual((await target.client.get(alpha.id, { full: true })).item, before);
    await writeFile(alphaFile, `${text}\nHarness revision`);
    assert.equal((await importDir(source, { ...target.options, from })).updated, 1);
    const actual = (await target.client.get(alpha.id, { full: true })).item;
    const { body: _body, updated_at: _time, ...untouched } = actual;
    const { body: _oldBody, updated_at: _oldTime, ...expected } = before;
    const document = JSON.stringify({ format: 'legacy', harness: from, original: Buffer.from(`${text}\nHarness revision`).toString('base64'), path: 'alpha.md', version: 1 });
    const { memory_verified_at: _verification, memory_reason: _reason, ...retained } = expected;
    assert.deepEqual(untouched, { ...retained, memory_document: document, memory_changed_at: actual.memory_changed_at, memory_verdict: 'unknown' });
    assert.equal(actual.memory_verified_at, undefined); assert.equal(actual.memory_reason, undefined); assert.ok(Date.parse(String(actual.memory_changed_at)) >= Date.parse(String(before.memory_changed_at))); assert.equal(actual.body, `${text}\nHarness revision`);
    assert.equal((await importDir(source, { ...target.options, from })).unchanged, 2);
  }
});

test('legacy creation and updates use the same crash recovery and revision guards', async t => {
  const target = await tracker(t); const source = join(target.root, 'legacy'); await mkdir(source);
  const file = join(source, 'alpha.md'); await writeFile(file, 'Alpha A');
  await assert.rejects(importDir(source, { ...target.options, from: 'agents-md', onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
  assert.equal((await importDir(source, { ...target.options, from: 'agents-md' })).imported, 1);
  assert.equal((await importDir(source, { ...target.options, from: 'agents-md' })).unchanged, 1);
  await writeFile(file, 'Alpha B');
  const alpha = (await target.client.listAllComplete()).items[0];
  const moved = await importDir(source, { ...target.options, from: 'agents-md', onStep: async step => { if (step === 'read') await target.client.update(alpha.id, { body: 'Native C' }); } }); assert.ok('skipped' in moved); assert.equal(moved.skipped[0].conflict?.code, 'import_conflict');
  assert.equal((await target.client.get(alpha.id, { full: true })).item.body, 'Native C');
  const compensated = await tracker(t);
  await assert.rejects(importDir(file, { ...compensated.options, from: 'agents-md', onTransition: crashAfterCompensation }), WorkspaceTransactionInterruptedError);
  assert.equal((await importDir(file, { ...compensated.options, from: 'agents-md' })).unchanged, 1);
  const recovered = (await compensated.client.listAllComplete({ includeBody: true })).items;
  assert.equal(recovered.length, 1); assert.equal(recovered[0].body, 'Alpha B');
});

test('native identity and source bookkeeping edits survive portable field revisions in source and destination trackers', async t => {
  const { source, target, path, manifest } = await policyScenario(t); const row = manifest.guidance[0];
  await importDir(path, { ...target.options, from: 'agents-md' });
  for (const current of [source, target]) {
    const id = (await current.client.listAllComplete()).items[0].id;
    await current.client.run('update', { id, options: { memorySlug: 'native-renamed', memoryOriginal: 'native-only-original', memoryPath: 'native-path.md', memoryEdited: true, memoryRecalls: 9 } });
    const before = (await current.client.get(id, { full: true })).item;
    await writeFile(join(path, row.path), policyBody(row, 'Portable body B'));
    const result = await importDir(path, { ...current.options, from: 'agents-md' });
    assert.equal(result.updated, 1); assert.equal((await current.client.listAllComplete()).items.length, 1);
    const actual = (await current.client.get(id, { full: true })).item;
    const { body: _body, updated_at: _time, memory_changed_at: _changed, memory_verdict: _verdict, memory_verified_at: _verified, memory_reason: _reason, ...kept } = actual;
    const { body: _old, updated_at: _oldTime, memory_changed_at: _oldChanged, memory_verdict: _oldVerdict, memory_verified_at: _oldVerified, memory_reason: _oldReason, ...expected } = before;
    assert.deepEqual(kept, expected); assert.equal(actual.body, 'Portable body B');
    assert.ok(Date.parse(String(actual.memory_changed_at)) >= Date.parse(String(before.memory_changed_at)));
    assert.deepEqual({ verdict: actual.memory_verdict, verified: actual.memory_verified_at, reason: actual.memory_reason }, { verdict: 'unknown', verified: undefined, reason: undefined });
    assert.equal((await importDir(path, { ...current.options, from: 'agents-md' })).unchanged, 1);
    await current.store.fields(id, { source: 'foreign:owner' });
    await assertSkippedUnchanged(() => importDir(path, { ...current.options, from: 'agents-md' }), current.workspace, 2);
  }
});

test('malformed ownership baselines refuse before every tracker write', async t => {
  const { target, path, manifest } = await policyScenario(t);
  const original = structuredClone(manifest.guidance[0].baseline!);
  const invalid = [null, {}, { ...original, extra: true }, { ...original, id: 3 }, { ...original, id: '' }, { ...original, id: '../foreign' }, { ...original, fields: null }, { ...original, fields: [] }, { ...original, fields: {} }, { ...original, fields: { ...original.fields, body: 3 } }, { ...original, fields: { ...original.fields, body: 'bad' } }, { ...original, relationships: null }, { ...original, relationships: [null] }];
  const before = await snapshot(target.workspace);
  for (const baseline of invalid) {
    const changed = structuredClone(manifest); changed.guidance[0].baseline = baseline as typeof original;
    await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(changed));
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && ['validity', 'relationship'].includes(error.code));
    assert.deepEqual(await snapshot(target.workspace), before);
  }
});

test('older frozen clearing plans are discarded without executing clearDeps', async t => {
  const { target, path, manifest } = await policyScenario(t); await importDir(path, { ...target.options, from: 'agents-md' });
  const policy = (await target.client.listAllComplete()).items[0]; const task = await target.client.create({ title: 'Retained native Task' }); await target.store.link(policy.id, task.item.id);
  const original = (await target.client.get(policy.id, { full: true })).item;
  await writeFile(join(path, manifest.guidance[0].path), policyBody(manifest.guidance[0], 'Harness B'));
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
  await editIntent(join(target.workspace, 'runtime', 'memory-policy-import.json'), plan => { delete plan.forwardOnly; delete plan.ownership; plan.mutations = plan.mutations.map(row => ({ ...row, options: { ...row.options, clearDeps: true } })); return plan; });
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 1);
  const actual = (await target.client.get(policy.id, { full: true })).item; assert.equal(actual.body, 'Harness B'); assert.deepEqual(actual.dependencies, original.dependencies);
});

test('older staged nodes retain their immutable identities during current-state replanning', async t => {
  const { target, path } = await policyScenario(t);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: crashAtStep('nodes') }), WorkspaceTransactionInterruptedError);
  const oldId = (await target.client.listAllComplete()).items[0].id;
  await editIntent(join(target.workspace, 'runtime', 'memory-policy-import.json'), plan => { delete plan.forwardOnly; delete plan.ownership; return plan; });
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 1);
  const items = (await target.client.listAllComplete()).items; assert.equal(items.length, 1); assert.equal(items[0].id, oldId);
});

test('legacy imports skip malformed foreign records and every dependent source', async t => {
  const target = await tracker(t); await target.store.register();
  await target.client.run('create', { options: { title: 'Foreign knowledge', type: 'Knowledge', memorySlug: 'alpha', memorySource: 'foreign:tool', memoryKind: 'unsupported', memoryValidity: 'invalid' } });
  const path = join(target.root, 'legacy'); await mkdir(path);
  await writeFile(join(path, 'alpha.md'), 'Alpha source'); await writeFile(join(path, 'beta.md'), 'Beta references [[alpha]]');
  const before = await snapshot(target.workspace);
  const result = await importDir(path, { ...target.options, from: 'claude-code' });
  assert.ok('skipped' in result); assert.deepEqual(result.skipped.map(row => row.slug).sort(), ['alpha', 'beta']);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('foreign ownership receipts never authorize a later native edit to be overwritten', async t => {
  const { target, path, manifest } = await policyScenario(t); const row = manifest.guidance[0];
  await importDir(path, { ...target.options, from: 'agents-md' });
  await writeFile(join(path, row.path), policyBody(row, 'Harness B'));
  let journalPath = '';
  await importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
    if (step === 'published') {
      const intent = JSON.parse(JSON.parse(await readFile(join(target.workspace, 'runtime', 'memory-policy-import.json'), 'utf8')).payload) as ImportPlan;
      const policy = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'policy')!;
      const message = (await readHistoryEntries(getHistoryPath(target.workspace, policy.id), policy.id)).at(-1)!.message!;
      journalPath = join(target.workspace, 'transactions', 'sdk', `${/^bulk-item-transaction (\S+) /.exec(message)![1].replace(/-nodes$/, '')}-snapshot.json`);
    }
  } });
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { status: string; results: Record<string, { owner: string; targets: NonNullable<ImportPlan['ownership']> }> };
  const policy = (await target.client.listAllComplete()).items[0]; await target.client.update(policy.id, { body: 'Native C' });
  await writeFile(join(path, row.path), policyBody(row, 'Harness D'));
  const owned = Object.values(journal.results)[0].targets[0];
  const targets: unknown[] = [null, 3, [], {}, { ...owned, fields: null }, { ...owned, fields: {} }, { ...owned, fields: { unknown: 'x' } }, { ...owned, fields: { body: 3 } }, { ...owned, fields: { body: 'bad' } }, { ...owned, relationships: 3 }, ...[3, [], {}, { id: 3, kind: 'related' }, { id: 'valid', kind: 'unknown' }].map(edge => ({ ...owned, relationships: [edge] })), { ...owned, id: 'foreign' }, { ...owned, fields: [] }, { ...owned, relationships: [null] }, { ...owned, graph: [] }, ...[null, 3, [], {}, { original: 3 }, { original: 'Retained foreign source bytes' }].map(source => ({ ...owned, source }))];
  const values: unknown[] = [null, 3, [], {}, { ...journal, status: 'prepared' }, ...[undefined, null, 3, [], { foreign: null }, { foreign: 3 }, { foreign: { owner: 'foreign' } }, { foreign: { owner: 'pm-memory-policy-ownership:1', targets: null } }, ...targets.map(target => ({ foreign: { owner: 'pm-memory-policy-ownership:1', targets: [target] } }))].map(results => ({ ...journal, results }))];
  const before = await snapshot(target.workspace);
  for (const value of ['{', ...values.map(value => JSON.stringify(value))]) {
    await writeFile(journalPath, value);
    await importDir(path, { ...target.options, from: 'agents-md' });
    assert.equal(await readFile(journalPath, 'utf8'), value);
    assert.deepEqual(await snapshot(target.workspace), before);
  }
});

test('legacy revised source bytes and unknown frontmatter survive outside native bookkeeping', async t => {
  const target = await tracker(t); const directory = join(target.root, 'source'); await mkdir(directory);
  const source = join(directory, 'source.md'); await writeFile(join(directory, 'MEMORY.md'), '- [Source](source.md)\n');
  const first = '---\nname: source\ncustom: retained\n---\nOriginal body\n';
  await writeFile(source, first); await importDir(directory, { ...target.options, from: 'claude-code' });
  const revised = first.replace('Original body', 'Revised body'); await writeFile(source, revised);
  await importDir(directory, { ...target.options, from: 'claude-code' });
  const native = (await target.client.listAllComplete({ includeBody: true })).items.find(item => item.memory_slug === 'source')!;
  assert.equal(native.memory_original, Buffer.from(first).toString('base64'));
  const output = join(target.root, 'output'); const receipt = await exportDir(output, { ...target.options, to: 'claude-code' });
  assert.equal(receipt.byte_preserved, 2); assert.equal(await readFile(join(output, 'source.md'), 'utf8'), revised);
});

test('older policy files without ownership metadata never overwrite later native edits', async t => {
  const { source, target, path, manifest } = await policyScenario(t);
  const row = manifest.guidance[0]; delete row.baseline;
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest)); await writeFile(join(path, row.path), policyBody(row, 'Older policy A'));
  await importDir(path, { ...target.options, from: 'agents-md' });
  await writeFile(join(path, row.path), policyBody(row, 'Harness B')); await importDir(path, { ...target.options, from: 'agents-md' });
  const policy = (await target.client.listAllComplete()).items[0]; await target.client.update(policy.id, { body: 'Native C' });
  await assertSkippedUnchanged(() => importDir(path, { ...target.options, from: 'agents-md' }), target.workspace);
  const original = await importDir(path, { ...source.options, from: 'agents-md' }); assert.equal(original.updated, 1);
  await source.client.update((await source.client.listAllComplete()).items[0].id, { body: 'Native source D' });
  assert.ok('skipped' in await importDir(path, { ...source.options, from: 'agents-md' }));
});

test('relationship ownership keeps source namespaces distinct and refuses ambiguous edited edges atomically', async t => {
  const target = await tracker(t);
  const beta = await remember('Namespace target', { ...target.options, kind: 'reference', slug: 'beta' });
  const alpha = await remember('Namespace guidance', { ...target.options, kind: 'project', slug: 'alpha' });
  await target.client.update(alpha.id, { dep: [`id=${beta.id},kind=related,source_kind=cli,author=first`, `id=${beta.id},kind=related,source_kind=mcp,author=second`] });
  const { path, manifest } = await exportedPolicy(target);
  const row = manifest.guidance.find(row => row.slug === 'alpha')!;
  assert.equal(row.relationships.length, 2);
  const preserved = structuredClone(row.relationships);
  row.relationships = preserved.map(({ source_kind: _namespace, ...edge }) => edge);
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
  const before = await snapshot(target.workspace);
  const ambiguous = () => importDir(path, { ...target.options, from: 'agents-md' });
  await assert.rejects(ambiguous, error => error instanceof MemoryError && error.code === 'conflict' && /namespace/.test(error.message));
  assert.deepEqual(await snapshot(target.workspace), before);
  row.relationships = preserved.filter(edge => edge.source_kind === 'cli');
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 1);
  const actual = (await target.client.get(alpha.id, { full: true })).item;
  assert.equal(actual.dependencies?.length, 1); assert.equal(actual.dependencies[0].source_kind, 'cli');
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 2);
  await target.client.update(alpha.id, { depRemove: [`id=${beta.id},kind=related,source_kind=cli`] });
  await target.client.update(alpha.id, { dep: [`id=${beta.id},kind=related,source_kind=cli,author=native-peer,created_at=2026-02-01T00:00:00.000Z`] });
  row.relationships = []; await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
  await assertSkippedUnchanged(() => importDir(path, { ...target.options, from: 'agents-md' }), target.workspace);
});

test('immutable origin lookup ignores malformed and unrelated creation provenance and refuses duplicate origins', async t => {
  const { target, path, manifest } = await policyScenario(t); const row = manifest.guidance[0];
  await target.store.register();
  const invalid: unknown[] = [null, 3, {}, [], [null], [3], [[]], [{ slug: 'other' }], [{ slug: row.slug }], [{ ...row, slug: 'unrelated-original', relationships: [{ slug: 'unlisted', kind: 'related' }] }, '']];
  for (const [index, value] of invalid.entries()) {
    await target.client.run('create', { options: { title: `Unrelated retained origin ${index}`, type: 'Knowledge', memorySlug: `origin-${index}`, memoryKind: 'reference', memorySource: 'portable:policy-v1', memoryOriginal: Buffer.from(JSON.stringify(value)).toString('base64') } });
  }
  await target.client.run('create', { options: { title: 'Unreadable retained origin', type: 'Knowledge', memorySlug: 'unreadable', memoryKind: 'reference', memorySource: 'portable:policy-v1', memoryOriginal: Buffer.from('{').toString('base64') } });
  await remember('Unrelated native origin', { ...target.options, slug: 'native', kind: 'reference', forceNew: true });
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).imported, 1);
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items.filter(item => before.some(row => row.id === item.id)), before);
  const original = Buffer.from(JSON.stringify([row, 'Baseline policy A'])).toString('base64');
  for (const slug of ['duplicate-one', 'duplicate-two']) await target.client.run('create', { options: { title: 'Duplicate origin', type: 'Knowledge', memorySlug: slug, memoryKind: 'reference', memorySource: 'portable:policy-v1', memoryOriginal: original, memoryOrigin: JSON.stringify(row.origin) } });
  const imported = (await target.client.listAllComplete()).items.find(item => item.memory_slug === row.slug)!;
  await target.store.fields(imported.id, { slug: 'also-renamed' });
  await assertOriginRefused(() => importDir(path, { ...target.options, from: 'agents-md' }), target.workspace);
  const retained = (await target.client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(exportedPolicy(target, 're-exported-origins'), error => error instanceof MemoryError && error.code === 'origin_missing');
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, retained);
});


test('creation history lookup treats absent, empty and foreign malformed streams as unknown', async t => {
  const target = await tracker(t); await target.store.register();
  const id = 'memory-test-foreign-history';
  assert.equal(await creationMetadata(target.store, id), undefined);
  const file = getHistoryPath(target.workspace, id);
  await writeFile(file, ''); assert.equal(await creationMetadata(target.store, id), undefined);
  await writeFile(file, 'foreign malformed history\n'); assert.equal(await creationMetadata(target.store, id), undefined);
  assert.equal(await readFile(file, 'utf8'), 'foreign malformed history\n');
});

test('baseline-less identities stay backward compatible and exported identity renames refuse before writes', async t => {
  const { source, target, path, manifest } = await policyScenario(t); const row = manifest.guidance[0];
  row.baseline!.slug = 'renamed';
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
  const before = await snapshot(target.workspace);
  const renamed = () => importDir(path, { ...target.options, from: 'agents-md' });
  await assert.rejects(renamed, error => error instanceof MemoryError && error.code === 'format');
  assert.deepEqual(await snapshot(target.workspace), before);
  delete row.baseline!.slug; delete row.baseline!.id;
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest)); await writeFile(join(path, row.path), policyBody(row, 'Baseline policy A'));
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).imported, 1);
  assert.equal((await importDir(path, { ...source.options, from: 'agents-md' })).unchanged, 1);
});


test('repeated foreign SDK transaction markers grant no portable field ownership', async t => {
  const { source, path, manifest } = await policyScenario(t); const row = manifest.guidance[0];
  const id = (await source.client.listAllComplete()).items[0].id;
  await commitItemMutations({ pmRoot: source.workspace, author: 'foreign-writer', transactionId: 'memory-policy-0123456789012345678901234567890123456789', mutations: [
    { op: 'update', id, options: { description: 'Native first edit' } },
    { op: 'update', id, options: { description: 'Native second edit' } },
  ] });
  row.description = 'Harness description';
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest)); await writeFile(join(path, row.path), policyBody(row, 'Portable body B'));
  const refused = await importDir(path, { ...source.options, from: 'agents-md' }); assert.equal(refused.updated, 0); assert.ok('skipped' in refused); assert.equal(refused.skipped[0].conflict?.code, 'import_conflict');
  const current = (await source.client.get(id, { full: true })).item;
  assert.equal(current.description, 'Native second edit'); assert.equal(current.body, 'Baseline policy A');
});

test('legacy field locality preserves native edits, source bookkeeping and unrelated metadata', async t => {
  const target = await tracker(t); const file = join(target.root, 'alpha.md');
  const first = '---\nname: alpha\ndescription: Original hook\n---\nOriginal body';
  await writeFile(file, first); await importDir(file, { ...target.options, from: 'claude-code' });
  const id = (await target.client.listAllComplete()).items[0].id;
  await target.client.run('update', { id, options: { description: 'Native hook C', memorySlug: 'native-renamed', memoryEdited: true, memoryPath: 'native-path.md', memoryOriginal: 'native-only-original', memoryImportSnapshot: 'native-only-snapshot' } });
  const before = (await target.client.get(id, { full: true })).item;
  await writeFile(file, first.replace('Original body', 'Harness body B'));
  const result = await importDir(file, { ...target.options, from: 'claude-code' });
  assert.equal(result.updated, 1); assert.ok(!('skipped' in result) || result.skipped.length === 0);
  const actual = (await target.client.get(id, { full: true })).item;
  assert.equal(actual.body, 'Harness body B');
  assert.deepEqual(JSON.parse(String(actual.memory_document)), { version: 1, format: 'legacy', harness: 'claude-code', path: 'alpha.md', original: Buffer.from(first.replace('Original body', 'Harness body B')).toString('base64') });
  const { memory_verified_at: _verification, memory_reason: _reason, ...preserved } = before;
  assert.equal(actual.memory_verified_at, undefined); assert.equal(actual.memory_reason, undefined);
  const bodyOnly = { ...preserved, body: actual.body, memory_document: actual.memory_document, memory_changed_at: actual.memory_changed_at, memory_verdict: 'unknown', updated_at: actual.updated_at };
  assert.deepEqual(actual, bodyOnly);
  assert.ok(Date.parse(String(actual.memory_changed_at)) >= Date.parse(String(before.memory_changed_at)));
  assert.equal(actual.memory_verdict, 'unknown');
  const saved = await snapshot(target.workspace);
  assert.equal((await importDir(file, { ...target.options, from: 'claude-code' })).unchanged, 1);
  assert.deepEqual(await snapshot(target.workspace), saved);
  await target.store.fields(id, { source: 'foreign:tool' });
  await assertSkippedUnchanged(() => importDir(file, { ...target.options, from: 'claude-code' }), target.workspace, 2);
});

test('artifact-only legacy projections preserve native bookkeeping and emit an empty policy inventory', async t => {
  const target = await tracker(t); const file = join(target.root, 'MEMORY.md'); await writeFile(file, '# Native artifact');
  await importDir(file, { ...target.options, from: 'claude-code' });
  const id = (await target.client.listAllComplete()).items[0].id;
  await target.store.fields(id, { edited: true, import_snapshot: 'legacy-native-snapshot' });
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  const { path, manifest } = await exportedPolicy(target);
  assert.deepEqual(manifest.guidance, []);
  await importDir(path, { ...target.options, from: 'agents-md' });
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
});

test('malformed immutable creation provenance is skipped without adopting a package source tag', async t => {
  const { path } = await policyScenario(t);
  for (const original of ['{', 'null', '[]', '[{},3]', '[{},"body"]']) {
    const target = await tracker(t); await target.store.register();
    await target.client.run('create', { options: { title: 'Retained unrelated record', type: 'Knowledge', memorySlug: 'policy', memoryKind: 'project', memorySource: 'portable:policy-v1', memoryOriginal: Buffer.from(original).toString('base64') } });
    await assertOriginRefused(() => importDir(path, { ...target.options, from: 'agents-md' }), target.workspace);
  }
});

test('interrupted mixed imports retain node identities and native external links', async t => {
  for (const linked of [false, true]) {
    const source = await tracker(t); const target = await tracker(t);
    const alpha = await remember('Alpha original', { ...source.options, slug: 'alpha', kind: 'project' });
    const first = await exportedPolicy(source, 'first'); await importDir(first.path, { ...target.options, from: 'agents-md' });
    const id = (await target.client.listAllComplete()).items[0].id;
    const task = linked ? (await target.client.create({ title: 'Native retained Task' })).item : undefined;
    if (task !== undefined) await target.store.link(id, task.id);
    await remember('Alpha replacement', { ...source.options, update: 'alpha', kind: 'project' });
    const beta = await remember('New beta reference', { ...source.options, slug: 'beta', kind: 'reference', forceNew: true });
    if (linked) await source.store.link(alpha.id, beta.id);
    const next = await exportedPolicy(source, 'next');
    await assert.rejects(importDir(next.path, { ...target.options, from: 'agents-md', onTransition: crashAfterCompensation }), WorkspaceTransactionInterruptedError);
    assert.equal((await importDir(next.path, { ...target.options, from: 'agents-md' })).updated, 1);
    const rows = (await target.client.listAllComplete({ includeBody: true })).items;
    const actual = rows.find(row => row.id === id)!; const importedBeta = rows.find(row => row.memory_slug === 'beta')!;
    assert.equal(actual.body, 'Alpha replacement');
    assert.deepEqual(new Set((actual.dependencies ?? []).map(edge => edge.id)), new Set(linked ? [task!.id, importedBeta.id] : []));
    if (!linked) assert.equal(actual.dependencies, undefined, 'unrepresented dependency metadata stays absent');
  }
});

test('single-file legacy imports guard represented targets outside the input and drain older incomplete read sets', async t => {
  const target = await tracker(t); await importText(target, 'beta.md', 'Native beta reference');
  const beta = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'beta')!;
  const file = join(target.root, 'alpha.md'); await writeFile(file, 'Alpha references [[beta]]');
  await assert.rejects(importDir(file, { ...target.options, from: 'agents-md', onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
  const intent = join(target.workspace, 'runtime', 'memory-policy-import.json');
  await editIntent(intent, older => ({ ...older, expected: older.expected.filter(row => row.id !== beta.id) }));
  assert.equal((await importDir(file, { ...target.options, from: 'agents-md' })).imported, 1);
  const alpha = (await target.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === 'alpha')!;
  assert.deepEqual(alpha.dependencies!.map(edge => edge.id), [beta.id]);
  await writeFile(file, 'Alpha updated [[beta]]');
  let changed = false;
  await importDir(file, { ...target.options, from: 'agents-md', onTransition: async event => { if (!changed && event.transition === 'step_applied') { changed = true; await target.client.update(beta.id, { body: 'Native beta C' }); } } });
  assert.equal((await target.client.get(alpha.id, { full: true })).item.body, 'Alpha updated [[beta]]');
  assert.equal((await target.client.get(beta.id, { full: true })).item.body, 'Native beta C');
});

test('ambiguous legacy origins refuse without selecting or overwriting a native record', async t => {
  const target = await tracker(t); await target.store.register();
  const file = join(target.root, 'alpha.md'); await writeFile(file, 'Alpha body');
  for (const suffix of ['one', 'two']) {
    const id = `memory-test-origin${suffix}`;
    await target.client.run('create', { options: { id, title: `Legacy origin ${suffix}`, type: 'Knowledge', memoryKind: 'reference', memorySlug: 'alpha', memorySource: 'claude-code:relative-file', memoryPath: 'alpha.md', memoryOriginal: Buffer.from('Alpha body').toString('base64'), allowDuplicate: true } });
    await target.client.run('update', { id, options: { memorySlug: `renamed-${suffix}` } });
  }
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(importDir(file, { ...target.options, from: 'claude-code' }), error => error instanceof MemoryError && /Ambiguous/.test(error.message));
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
});


test('legacy source tags without immutable provenance remain foreign and close dependent skips', async t => {
  for (const raw of [false, true]) {
    const target = await tracker(t); await target.store.register();
    const id = 'memory-test-unproven';
    if (raw) {
      const base = (await target.client.create({ title: 'Native serialization template', type: 'Knowledge' })).item;
      const document = canonicalDocument({ metadata: { ...base, id, memory_slug: 'alpha', memory_kind: 'reference', memory_source: 'claude-code:relative-file', memory_path: 'alpha.md' }, body: 'Foreign source' });
      await writeFile(getItemPath(target.workspace, 'Knowledge', id, 'toon', resolveItemTypeRegistry(await readSettings(target.workspace)).type_to_folder), serializeItemDocument(document, { format: 'toon' }));
    } else await target.client.run('create', { options: { id, title: 'Foreign source tag', type: 'Knowledge', memorySlug: 'alpha', memoryKind: 'reference', memorySource: 'claude-code:relative-file', memoryPath: 'alpha.md' } });
    const directory = join(target.root, 'sources'); await mkdir(directory);
    await writeFile(join(directory, 'alpha.md'), 'Alpha incoming'); await writeFile(join(directory, 'beta.md'), 'Beta mentions [[alpha]]');
    const before = (await target.client.listAllComplete({ includeBody: true })).items;
    await assertSkippedUnchanged(() => importDir(directory, { ...target.options, from: 'claude-code' }), target.workspace, 2);
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  }
});


test('lossless legacy path aliases stay byte-identical and native key changes use policy projection', async t => {
  for (const renamed of [false, true]) {
    const target = await tracker(t); const source = join(target.root, 'sources'); await mkdir(source);
    const files = {
      'MEMORY.md': '- [Source](source.md)\n- [Target](target-file.md)\n',
      'source.md': `Source [[${renamed ? 'new-target' : 'target-file'}]]\n`,
      'target-file.md': '---\nname: canonical-target\n---\nTarget body\n',
    };
    for (const [name, text] of Object.entries(files)) await writeFile(join(source, name), text);
    await importDir(source, { ...target.options, from: 'claude-code' });
    const id = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'canonical-target')!.id;
    if (renamed) await target.store.fields(id, { slug: 'new-target' });
    const before = (await target.client.listAllComplete({ includeBody: true })).items;
    const output = join(target.root, 'output'); const result = await exportDir(output, { ...target.options, to: 'claude-code' });
    if (renamed) {
      assert.equal(result.byte_preserved, 0);
      const manifest = JSON.parse(await readFile(join(output, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
      assert.ok(manifest.guidance.some(row => row.slug === 'new-target'));
      assert.match(await readFile(join(output, 'memories/source.md'), 'utf8'), /\[\[new-target\]\]/);
    } else {
      assert.equal(result.byte_preserved, 3);
      for (const [name, text] of Object.entries(files)) assert.equal(await readFile(join(output, name), 'utf8'), text);
    }
    await importDir(output, { ...target.options, from: 'claude-code' });
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  }
});

test('ambiguous legacy export keys refuse before publishing or changing native data', async t => {
  const target = await tracker(t); const index = join(target.root, 'MEMORY.md');
  await writeFile(index, '- [First](first.md)\n- [Second](second.md)\n');
  await importDir(index, { ...target.options, from: 'claude-code' });
  for (const name of ['first', 'second']) await target.client.run('create', { options: {
    title: 'shared', body: `${name} body`, type: 'Knowledge', memorySlug: name, memoryKind: 'reference', memorySource: 'claude-code:relative-file', memoryPath: `${name}.md`, memoryOriginal: Buffer.from(`---\nname: shared\n---\n${name} body`).toString('base64'), allowDuplicate: true,
  } });
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  const output = join(target.root, 'ambiguous');
  await assert.rejects(exportDir(output, { ...target.options, to: 'claude-code' }), error => error instanceof MemoryError && /duplicate slugs/.test(error.message));
  await assert.rejects(readFile(join(output, 'MEMORY.md')), { code: 'ENOENT' });
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
});

test('unavailable legacy references select policy without rewriting native guidance', async t => {
  for (const reference of ['memory', 'alias', 'absent']) {
    const target = await tracker(t); const source = join(target.root, 'references'); await mkdir(source);
    const aliases = reference === 'alias';
    const paths = ['source.md', ...(aliases ? ['!alias!.md', 'alias.md'] : [])];
    await writeFile(join(source, 'MEMORY.md'), paths.map(path => `- [Fact](${path})`).join('\n') + '\n');
    await writeFile(join(source, 'source.md'), `Source [[${reference}]]`);
    if (aliases) for (const [path, name] of [['!alias!.md', 'first'], ['alias.md', 'second']]) await writeFile(join(source, path), `---\nname: ${name}\n---\n${name} fact`);
    await importDir(source, { ...target.options, from: 'claude-code' });
    const before = (await target.client.listAllComplete({ includeBody: true })).items;
    const output = join(target.root, 'policy');
    assert.equal((await exportDir(output, { ...target.options, to: 'claude-code' })).byte_preserved, 0);
    assert.match(await readFile(join(output, 'memories/source.md'), 'utf8'), new RegExp(`\\[\\[${reference}\\]\\]`));
    await importDir(output, { ...target.options, from: 'claude-code' });
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  }
});

test('legacy imports retain foreign pending intents and return their skip receipt without writes', async t => {
  const target = await tracker(t); const file = join(target.root, 'alpha.md'); await writeFile(file, 'Harness alpha');
  const runtime = join(target.workspace, 'runtime'); await mkdir(runtime, { recursive: true });
  const intent = join(runtime, 'memory-policy-import.json'); const foreign = JSON.stringify({ owner: 'foreign-tool', operation: 'retained' });
  await writeFile(intent, foreign);
  await assertSkippedUnchanged(() => importDir(file, { ...target.options, from: 'claude-code' }), target.workspace);
  assert.equal(await readFile(intent, 'utf8'), foreign);
  assert.equal((await target.client.listAllComplete()).items.length, 0);
});

test('legacy input cannot adopt an independently authored native memory with the same key', async t => {
  const target = await tracker(t);
  const native = await remember('Independent native alpha', { ...target.options, slug: 'alpha', kind: 'reference' });
  const file = join(target.root, 'alpha.md'); await writeFile(file, 'Harness replacement');
  const before = (await target.client.get(native.id, { full: true })).item;
  await assert.rejects(importDir(file, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict' && error.remedy.length > 0);
  assert.deepEqual((await target.client.get(native.id, { full: true })).item, before);
  assert.equal((await target.client.listAllComplete()).items.length, 1);
});


test('modern creation admission retains native edits until durable publication is proven', async t => {
  const target = await tracker(t);
  // Absence of a modern marker delegates to the existing legacy birth checks.
  assert.equal(await recordedCreation(target.store, 'memory-test-absent'), true);
  const producer = await tracker(t); const file = join(producer.root, 'alpha.md'); await writeFile(file, 'Alpha A');
  await assert.rejects(importDir(file, { ...producer.options, from: 'agents-md', onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
  const plan = JSON.parse(JSON.parse(await readFile(join(producer.workspace, 'runtime', 'memory-policy-import.json'), 'utf8')).payload) as ImportPlan;
  const node = structuredClone(plan.nodes![0]); delete node.options!.memoryBirth; node.options!.message = String(node.options!.message).replace(/ memory-birth-v1:[a-f0-9]{64}$/, '');
  await target.store.register();
  await commitItemMutations({ pmRoot: target.workspace, author: plan.author, transactionId: `${plan.transactionId}-nodes`, mutations: [node] });
  await commitWorkspaceTransaction({ pmRoot: target.workspace, author: plan.author, transactionId: `${plan.transactionId}-snapshot`, steps: [{ id: 'publication', inspect: async () => ({ state: 'pending' }), apply: async () => JSON.parse(JSON.stringify({ owner: 'pm-memory-policy-ownership:1', targets: plan.ownership })) as WorkspaceTransactionJsonValue, compensate: async () => {} }] });
  const input = join(target.root, 'alpha.md'); await writeFile(input, 'Alpha A');
  const item = (await target.client.listAllComplete()).items[0];
  const entries = await readHistoryEntries(getHistoryPath(target.workspace, item.id), item.id);
  const transactionId = /^bulk-item-transaction (\S+)-nodes /.exec(entries[0].message!)![1];
  const journal = join(target.workspace, 'transactions', 'sdk', `${transactionId}-snapshot.json`);
  const original = await readFile(journal);
  assert.equal(await recordedCreation(target.store, item.id), true);
  await rm(journal); // Only this disposable fixture's own publication receipt.
  await target.client.update(item.id, { body: 'Peer native C' });
  await target.client.update(item.id, { description: 'Peer metadata', message: `bulk-item-transaction ${transactionId} copied-marker update` });
  await target.client.update(item.id, { priority: 1, message: `bulk-item-transaction memory-policy-${'e'.repeat(40)} foreign update` });
  assert.equal(await recordedCreation(target.store, item.id), false);
  const before = (await target.client.get(item.id, { full: true })).item;
  await writeFile(input, 'Harness D'); const result = await importDir(input, { ...target.options, from: 'agents-md' });
  assert.ok('skipped' in result); assert.match(result.skipped[0].reason, /Foreign/);
  assert.deepEqual((await target.client.get(item.id, { full: true })).item, before);
  await writeFile(journal, original); assert.equal(await recordedCreation(target.store, item.id), true);
  for (const options of [{ memoryBirth: 'unknown-version', message: 'Peer marker' }, { memoryBirth: 'portable-v1', message: 'Peer marker' }, { memoryBirth: 'portable-v1', message: String(node.options!.message) }]) {
    const foreign = await target.client.create({ ...node.options, ...options });
    assert.equal(await recordedCreation(target.store, foreign.item.id), false);
  }
  const current = await readHistoryEntries(getHistoryPath(target.workspace, item.id), item.id);
  const unmarked = sealHistoryRecord({ ...current[0], message: undefined });
  await rm(getHistoryPath(target.workspace, item.id));
  for (const row of [unmarked, ...current.slice(1)]) await appendHistoryEntry(getHistoryPath(target.workspace, item.id), row);
  assert.equal(await recordedCreation(target.store, item.id), true, 'Older histories without creation messages keep their legacy checks');
  await writeFile(getHistoryPath(target.workspace, item.id), [{ ...entries[0], patch: [] }, ...entries.slice(1)].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  assert.equal(await recordedCreation(target.store, item.id), false, 'Malformed foreign history cannot grant birth authority');

});


test('birth evidence survives tracker clones without disposable transaction journals', async t => {
  for (const from of ['agents-md', 'claude-code'] as const) {
    const source = await tracker(t); const input = join(source.root, 'input'); await mkdir(input);
    await writeFile(join(input, 'alpha.md'), 'Alpha A [[beta]]'); await writeFile(join(input, 'beta.md'), 'Beta A');
    await importDir(input, { ...source.options, from });
    const clone = await tracker(t); await rm(clone.workspace, { recursive: true });
    await cp(source.workspace, clone.workspace, { recursive: true, filter: path => !['transactions', 'runtime', 'locks', 'search', 'checkpoints'].some(name => path === join(source.workspace, name)) });
    const before = (await clone.client.listAllComplete({ includeBody: true })).items;
    const output = join(clone.root, 'export'); const result = await exportDir(output, { ...clone.options, to: from });
    assert.equal(before.length, 2); assert.equal(result.exported, 4); assert.equal(result.skipped?.length ?? 0, 0);
    assert.equal((await importDir(output, { ...clone.options, from })).unchanged, 2);
    assert.deepEqual((await clone.client.listAllComplete({ includeBody: true })).items, before);
    assert.ok(before[0].dependencies?.length || before[1].dependencies?.length, 'SDK clone retained the represented relationship');
  }
});
