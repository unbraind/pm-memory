import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LEGACY_ORIGINS, parseLegacyOrigins, importDir, exportDir, MemoryError } from '../index.ts';
import type { LegacyOriginManifest, LegacyOriginRecord } from '../index.ts';
import { digest } from '../src/core.ts';
import { tracker, snapshot } from './helpers.ts';

/** Export exact legacy bytes together with their immutable native semantics. */
async function companion(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t); const raw = join(source.root, 'raw'); await mkdir(raw);
  await writeFile(join(raw, 'MEMORY.md'), '- [Alpha](alpha.md)\n- [Beta](beta.md)\n');
  await writeFile(join(raw, 'alpha.md'), '# Alpha\nGuidance'); await writeFile(join(raw, 'beta.md'), '# Beta\nReference');
  await importDir(raw, { ...source.options, from: 'claude-code' });
  const output = join(source.root, 'out'); const receipt = await exportDir(output, { ...source.options, to: 'claude-code' });
  assert.equal(receipt.byte_preserved, 3); assert.equal(receipt.exported, 4);
  const file = join(output, LEGACY_ORIGINS); const envelope = JSON.parse(await readFile(file, 'utf8')) as LegacyOriginManifest;
  return { source, output, file, envelope, records: parseLegacyOrigins(envelope, 'claude-code') };
}
/** All malformed inputs refuse with a safe typed remedy. */
const typed = (error: unknown) => error instanceof MemoryError && error.remedy.length > 0;
/** Recompute a fixture-owned immutable envelope after an adversarial snapshot edit. */
function wrap(envelope: LegacyOriginManifest, records: unknown): LegacyOriginManifest {
  const payload = JSON.stringify(records); return { ...envelope, payload, checksum: digest(payload) };
}

test('origin companion validates every row before writes and refuses malformed or incomplete inventory', async t => {
  const { output, file, envelope, records } = await companion(t); const target = await tracker(t); const before = await snapshot(target.workspace);
  const malformed: unknown[] = [null, [], {}, { ...envelope, version: 2 }, { ...envelope, format: 'foreign' }, { ...envelope, harness: 'agents-md' }, { ...envelope, payload: 3 }, { ...envelope, checksum: 'wrong' }, { ...envelope, extra: true }, wrap(envelope, null), { ...envelope, payload: '{', checksum: digest('{') }, ...[null, 3, []].map(value => wrap(envelope, [value]))];
  const changes: ((rows: LegacyOriginRecord[]) => void)[] = [
    rows => { Object.assign(rows[0], { extra: true }); },
    rows => { rows[0].file = 3 as unknown as string; },
    rows => { rows[0].decoded = {} as LegacyOriginRecord['decoded']; },
    rows => { rows[0].links = null as unknown as string[]; },
    rows => { rows[0].links = [3] as unknown as string[]; },
    rows => { rows[0].artifact = 3 as unknown as boolean; },
    rows => { delete rows[0].guidance.baseline!.origin; delete rows[0].guidance.origin; },
    rows => { rows[1].file = rows[0].file; },
    rows => { rows[0].file = '../escape'; },
    rows => { const origin = rows[1].guidance.origin!; rows[0].guidance.origin = { id: origin.id, creation: origin.creation, tracker: origin.tracker }; rows[0].guidance.baseline!.origin = { ...origin }; },
    rows => {
      const window = { from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:00.000Z', evidence: 'Public fixture', contentHash: 'a'.repeat(64), revision: 1 };
      rows[0].guidance.validity = window; rows[0].guidance.renewals = [window];
    },
  ];
  for (const change of changes) { const values = structuredClone(records); change(values); malformed.push(wrap(envelope, values)); }
  for (const value of malformed) {
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(importDir(output, { ...target.options, from: 'claude-code' }), typed);
    assert.deepEqual(await snapshot(target.workspace), before);
  }
  await writeFile(file, '{'); await assert.rejects(importDir(output, { ...target.options, from: 'claude-code' }), typed);
  await writeFile(file, JSON.stringify(envelope)); await rm(join(output, 'beta.md'));
  await assert.rejects(importDir(output, { ...target.options, from: 'claude-code' }), typed);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('bound legacy edits use snapshot identities preserve native edits and skip uninventoried files', async t => {
  const { source, output } = await companion(t);
  const rows = (await source.client.listAllComplete()).items; const alpha = rows.find(row => row.memory_slug === 'alpha')!; const beta = rows.find(row => row.memory_slug === 'beta')!;
  await source.client.run('update', { id: alpha.id, options: { memorySlug: 'renamed-alpha', description: 'Native description' } });
  await source.client.run('update', { id: beta.id, options: { memorySlug: 'renamed-beta' } });
  await writeFile(join(output, 'alpha.md'), '---\nname: Alpha revised\ndescription: Portable description\n---\n# Alpha\nSee [[beta]], [[not-in-inventory]]');
  await writeFile(join(output, 'foreign.md'), 'Uninventoried file retained');
  const before = (await source.client.get(alpha.id, { full: true })).item;
  const result = await importDir(output, { ...source.options, from: 'claude-code' }); assert.ok('skipped' in result);
  assert.deepEqual((await source.client.get(alpha.id, { full: true })).item, before);
  assert.ok(result.skipped.some(row => row.conflict?.fields.includes('description')));
  // Reconcile the conflicting input before applying its other fields as one forward item write.
  await writeFile(join(output, 'alpha.md'), '---\nname: Alpha revised\n---\n# Alpha\nSee [[beta]], [[not-in-inventory]]');
  assert.equal((await importDir(output, { ...source.options, from: 'claude-code' })).updated, 1);
  assert.ok(result.skipped.some(row => row.slug === 'foreign.md')); assert.equal(result.unresolved_links, 1);
  const actual = (await source.client.get(alpha.id, { full: true })).item;
  assert.equal(actual.memory_slug, 'renamed-alpha'); assert.equal(actual.description, 'Native description'); assert.equal(actual.title, 'Alpha revised');
  assert.equal(actual.dependencies![0].id, beta.id);
  assert.match(String(actual.body), /not-in-inventory/);
  assert.ok(result.skipped.some(row => row.reason.includes('description')));
});

test('companion does not bypass raw-byte privacy or UTF-8 validation', async t => {
  const { output } = await companion(t); const target = await tracker(t); const before = await snapshot(target.workspace);
  await writeFile(join(output, 'alpha.md'), '---\nunknown: safe\npassword: synthetic-fixture-value\n---\n# Alpha\nGuidance');
  await assert.rejects(importDir(output, { ...target.options, from: 'claude-code' }), error => error instanceof MemoryError && error.code === 'privacy');
  assert.deepEqual(await snapshot(target.workspace), before);
  await writeFile(join(output, 'alpha.md'), Buffer.from([255]));
  await assert.rejects(importDir(output, { ...target.options, from: 'claude-code' }), typed);
  assert.deepEqual(await snapshot(target.workspace), before);
});
