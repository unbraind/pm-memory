import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, recall, consolidate, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { tracker, exportedPolicy, snapshot, runModelWorkerPool } from './helpers.ts';

import { sourceFixture as fixture } from './import-state-helpers.ts';

/** Apply an edited source and read the actual target back through the SDK. */
async function applySource(target: Awaited<ReturnType<typeof fixture>>, text: string) {
  await writeFile(target.file, target.marker + text);
  const receipt = await importDir(target.path, { ...target.options, from: target.from });
  return { receipt, item: (await target.client.get(target.id, { full: true })).item };
}
/** Introduce a native field edit without passing through the importer. */
async function nativeFields(target: Awaited<ReturnType<typeof fixture>>, fields: Record<string, unknown>) {
  await target.client.run('update', { id: target.id, options: fields });
  return (await target.client.get(target.id, { full: true })).item;
}

for (const mode of ['raw', 'companion', 'policy'] as const) test(`owned source removals reach native storage and recall: ${mode}`, async t => {
  const target = await fixture(t, mode);
  const input = '---\ncustom: revised\n---\n# Alpha\nCorrect instructions\n';
  await writeFile(target.file, target.marker + input);
  assert.equal((await importDir(target.path, { ...target.options, from: target.from })).updated, 1);
  const row = (await target.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === 'alpha')!;
  assert.equal(row.memory_how, undefined); assert.equal(row.memory_why, undefined); assert.equal(row.memory_kind, undefined); assert.equal(row.description, '');
  const packet = await recall('Alpha', { ...target.options, semantic: 'off', budget: 2000 });
  assert.ok(packet.memories?.some(row => row.slug === 'alpha')); assert.doesNotMatch(JSON.stringify(packet), /Obsolete instructions|Original evidence|Original hook/);
  const exported = join(target.root, 'next'); await exportDir(exported, { ...target.options, to: target.from });
  assert.equal((await importDir(exported, { ...target.options, from: target.from })).updated, 0);
});

for (const mode of ['raw', 'companion', 'policy'] as const) test(`content freshness and evidence belong to the current revision: ${mode}`, async t => {
  const target = await fixture(t, mode); const row = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!;
  for (const age of [0, 29, 30, 31, 400]) {
    const old = new Date(Date.now() - age * 86400000).toISOString();
    await target.client.run('update', { id: row.id, options: { memoryChangedAt: old, memoryVerdict: 'stale', memoryVerifiedAt: old, memoryReason: 'missing path src/retired.ts under roots' } });
    const before = Date.now();
    const { receipt, item: actual } = await applySource(target, `# Alpha\nCorrect revision aged ${age}\n`);
    assert.equal(receipt.updated, 1);
    assert.ok(Date.parse(String(actual.memory_changed_at)) >= before); assert.equal(actual.memory_verdict, 'unknown');
    assert.equal(actual.memory_verified_at, undefined); assert.equal(actual.memory_reason, undefined);
    const history = await readHistoryEntries(getHistoryPath(target.workspace, row.id), row.id);
    const paths = history.at(-1)!.patch.map(patch => patch.path);
    assert.ok(paths.includes('/body')); assert.ok(paths.includes('/metadata/memory_changed_at')); assert.ok(paths.includes('/metadata/memory_verdict'));
    assert.ok(!(await consolidate(target.options)).proposals.some(proposal => proposal.action === 'archive' && proposal.slug === 'alpha'));
  }
});

test('canonical fields and relationships remove only represented values', async t => {
  const target = await tracker(t); const alpha = await remember('Alpha', { ...target.options, slug: 'alpha', kind: 'project', why: 'Old evidence', how: 'Old instructions', tags: ['old'] });
  const beta = await remember('Beta', { ...target.options, slug: 'beta', kind: 'reference', forceNew: true });
  await target.client.update(alpha.id, { dep: [`id=${beta.id},kind=related`] });
  const { path, manifest } = await exportedPolicy(target); const row = manifest.guidance.find(row => row.slug === 'alpha')!;
  Object.assign(row, { why: '', how: '', tags: [], relationships: [] });
  // Field edits change the inventory, while the immutable marker includes only its policy/baseline.
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
  const receipt = await importDir(path, { ...target.options, from: 'agents-md' });
  assert.deepEqual({ imported: receipt.imported, updated: receipt.updated }, { imported: 0, updated: 1 });
  const actual = (await target.client.get(alpha.id, { full: true })).item;
  assert.equal(actual.memory_how ?? '', ''); assert.equal(actual.memory_why ?? '', ''); assert.deepEqual(actual.tags, []); assert.deepEqual(actual.dependencies ?? [], []);
});

test('later source ownership survives add change and removal after a plain legacy birth', async t => {
  for (const from of ['agents-md', 'claude-code', 'cursor'] as const) {
    const target = await tracker(t); const file = join(target.root, 'alpha.md');
    await writeFile(file, 'Alpha'); await importDir(file, { ...target.options, from });
    for (const value of ['First application', 'Revised application', undefined]) {
      await writeFile(file, value === undefined ? 'Alpha' : `Alpha\n**How to apply:** ${value}`);
      assert.equal((await importDir(file, { ...target.options, from })).updated, 1);
      const actual = (await target.client.listAllComplete({ includeBody: true })).items[0];
      assert.equal(actual.memory_how, value);
    }
  }
});

test('source text cannot remove multiple native relationship namespaces', async t => {
  const target = await fixture(t, 'raw');
  await writeFile(join(target.path, 'beta.md'), '# Beta\nNative link target');
  await writeFile(target.file, '# Alpha\nOwn reference [[beta]]');
  await importDir(target.path, { ...target.options, from: target.from });
  const rows = (await target.client.listAllComplete()).items;
  const alpha = rows.find(row => row.memory_slug === 'alpha')!; const beta = rows.find(row => row.memory_slug === 'beta')!;
  await target.client.update(alpha.id, { dep: [`id=${beta.id},kind=related,source_kind=foreign`] });
  const { path, manifest } = await exportedPolicy(target); const row = manifest.guidance.find(row => row.slug === 'alpha')!;
  const file = join(path, row.path); const bytes = await readFile(file, 'utf8');
  await writeFile(file, bytes.replace(' [[beta]]', ''));
  const before = await snapshot(target.workspace);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict' && error.message.includes('namespace'));
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('raw handoffs never adopt unrelated canonical field ownership', async t => {
  const target = await fixture(t, 'raw', 'Alpha');
  const row = (await target.client.listAllComplete()).items.find(item => item.memory_slug === 'alpha')!;
  await target.client.run('update', { id: row.id, options: { memoryKind: 'feedback', memoryWhy: 'Native rationale', memoryHow: 'Native application', description: 'Native hook', tags: 'native', memoryPinned: true, priority: 1 } });
  const { path, manifest } = await exportedPolicy(target); const wire = manifest.guidance.find(item => item.slug === 'alpha')!;
  await writeFile(join(path, wire.path), policyBody(wire, 'Canonical handoff'));
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 1);
  const before = (await target.client.get(row.id, { full: true })).item;
  const { receipt, item: actual } = await applySource(target, 'Raw final guidance'); assert.equal(receipt.updated, 1);
  assert.equal(actual.body, 'Raw final guidance');
  for (const field of ['memory_kind', 'memory_why', 'memory_how', 'description', 'tags', 'memory_pinned', 'priority']) assert.deepEqual(actual[field], before[field], field);
});

for (const mode of ['raw', 'companion', 'policy'] as const) for (const field of ['why', 'how'] as const) test(`source absences unset explicit defaults and empty ${field}: ${mode}`, async t => {
  const original = `---\nname: alpha\ntype: reference\n---\nAlpha\n**${field === 'why' ? 'Why' : 'How to apply'}:**`;
  const target = await fixture(t, mode, original); const row = (await target.client.listAllComplete()).items.find(item => item.memory_slug === 'alpha')!;
  assert.equal(row[`memory_${field}`], ''); assert.equal(row.memory_kind, 'reference');
  const { receipt, item: actual } = await applySource(target, '---\nname: alpha\n---\nAlpha');
  assert.equal(receipt.updated, 1);
  assert.equal(actual[`memory_${field}`], undefined); assert.equal(actual.memory_kind, undefined);
  assert.equal((await importDir(target.path, { ...target.options, from: target.from })).updated, 0);
});

for (const mode of ['raw', 'companion', 'policy'] as const) for (const field of ['kind', 'description', 'why', 'how'] as const) test(`source default removal refuses a newer native ${field} as a whole: ${mode}`, async t => {
  const directive = field === 'why' ? '\n**Why:**' : field === 'how' ? '\n**How to apply:**' : '';
  const initial = `---\nname: alpha\ntype: reference\n${field === 'description' ? "description: ''\n" : ''}---\nAlpha${directive}`;
  const target = await fixture(t, mode, initial);
  const option = field === 'description' ? field : `memory${field[0].toUpperCase()}${field.slice(1)}`;
  const before = await nativeFields(target, { [option]: field === 'kind' ? 'feedback' : 'Peer application' });
  const { receipt, item } = await applySource(target, 'Alpha');
  assert.equal(receipt.updated, 0); assert.ok('skipped' in receipt && receipt.skipped.some(row => row.conflict?.fields.includes(field)));
  assert.deepEqual(item, before);
});

test('empty source edits update ownership against the exported native baseline', async t => {
  const target = await fixture(t, 'raw', '---\nname: alpha\n---\nAlpha\n**How to apply:**');
  await nativeFields(target, { memoryHow: 'Native exported application' });
  const { path, manifest } = await exportedPolicy(target); const wire = manifest.guidance.find(item => item.slug === 'alpha')!;
  const file = join(path, wire.path);
  for (const how of [undefined, 'Harness application']) {
    const text = `---\nname: alpha\n---\nAlpha${how === undefined ? '' : `\n**How to apply:** ${how}`}`;
    await writeFile(file, policyBody(wire, text)); assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 1);
    assert.equal((await target.client.get(target.id, { full: true })).item.memory_how, how);
  }
});

// Fresh workers bound Node 22 coverage bookkeeping without changing any seed or assertion.
test('property: 500 seeded owned-field add/change/remove sequences equal SDK read-back and recall', { timeout: 14400000 }, async t => {
  // Fresh worker processes bound Node 22 coverage bookkeeping; their independent
  // batches run concurrently through one bounded pool.
  const configurations: Record<string, string>[] = []; const receipts: string[] = [];
  for (let start = 0; start < 500; start += 5) { configurations.push({ PM_MEMORY_OWNED_START: String(start), PM_MEMORY_OWNED_COUNT: '5' }); receipts.push(`OWNED_STATE_BATCH start=${start} count=5 STEPS=15 MASTER_SEED=0x1363f014`); }
  await runModelWorkerPool(t, new URL('./import-state.worker.ts', import.meta.url), configurations, receipts);
  assert.equal(configurations.length * 5, 500);
  t.diagnostic('OWNED_STATE_SEQUENCES=500 STEPS=1500 MASTER_SEED=0x1363f014 batches=100 wall=concurrent');
});

for (const mode of ['companion', 'policy'] as const) test(`actual exported source bounds removal ownership: ${mode}`, async t => {
  const target = await fixture(t, 'raw', '# Alpha\n**How to apply:** Retained native guidance\n[[beta]]\n');
  await writeFile(join(target.path, 'beta.md'), '# Beta\n');
  await writeFile(join(target.path, 'MEMORY.md'), '- [Alpha](alpha.md)\n- [Beta](beta.md)\n');
  await importDir(target.path, { ...target.options, from: 'claude-code' });
  assert.ok((await target.client.listAllComplete()).items.some(item => item.memory_slug === 'beta'));
  await nativeFields(target, { body: '# Alpha\nNative body without directive or wiki\n' });
  const path = join(target.root, 'actual-export'); const from = mode === 'policy' ? 'agents-md' : 'claude-code';
  await exportDir(path, { ...target.options, to: from });
  const before = (await target.client.get(target.id, { full: true })).item;
  const receipt = await importDir(path, { ...target.options, from });
  assert.equal(receipt.updated, 0);
  assert.deepEqual((await target.client.get(target.id, { full: true })).item, before);
  const file = join(path, 'memories/alpha.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('Native body without directive or wiki', 'Edited body only'));
  assert.equal((await importDir(path, { ...target.options, from })).updated, 1);
  const after = (await target.client.get(target.id, { full: true })).item;
  assert.equal(after.memory_how, before.memory_how); assert.deepEqual(after.dependencies, before.dependencies);
});

for (const mode of ['raw', 'companion', 'policy'] as const) test(`retained native values remain unchanged until a new peer edit: ${mode}`, async t => {
  for (const [field, option] of [['title', 'title'], ['description', 'description'], ['kind', 'memoryKind'], ['why', 'memoryWhy'], ['how', 'memoryHow']] as const) {
    const target = await fixture(t, mode);
    const first = field === 'kind' ? 'project' : `Native ${field} C`;
    await nativeFields(target, { [option]: first });
    const bytes = await readFile(target.file, 'utf8');
    await writeFile(target.file, bytes.replace('Original content', `Revised body ${field}`));
    const applied = await importDir(target.path, { ...target.options, from: target.from });
    assert.equal(applied.updated, 1, `${mode}/${field} ${JSON.stringify(applied)}`);
    const preserved = (await target.client.get(target.id, { full: true })).item;
    assert.equal(preserved[field === 'title' || field === 'description' ? field : `memory_${field}`], first);
    assert.equal((await importDir(target.path, { ...target.options, from: target.from })).unchanged, mode === 'companion' ? 2 : mode === 'policy' ? 1 : 2);
    assert.deepEqual((await target.client.get(target.id, { full: true })).item, preserved);
    await nativeFields(target, { [option]: field === 'kind' ? 'user' : `Peer ${field} D` });
    const peer = (await target.client.get(target.id, { full: true })).item;
    const refused = await importDir(target.path, { ...target.options, from: target.from });
    assert.equal(refused.updated, 0);
    assert.ok('skipped' in refused && refused.skipped.some(row => row.conflict?.code === 'import_conflict' && row.conflict.fields.includes(field)));
    assert.deepEqual((await target.client.get(target.id, { full: true })).item, peer);
  }
});
