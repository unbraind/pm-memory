import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, readHistoryEntries, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { importDir, remember, renew, POLICY_MANIFEST, MemoryError } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { contentRevision } from '../src/content.ts';
import { clonedTracker, exportedPolicy, snapshot, tracker, withoutGit } from './helpers.ts';

for (const mode of ['native', 'agents-md', 'claude-code'] as const) test(`pin-only changes preserve content recency and invalidate old verification: ${mode}`, async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const memory = await remember('Alpha instructions', { ...target.options, slug: 'alpha', kind: 'reference' });
  for (let step = 0; step < 4; step++) {
    const age = step < 2 ? 31 : 400; const at = new Date(Date.now() - age * 86400000).toISOString();
    await target.store.fields(memory.id, { changed_at: at, verdict: 'stale', verified_at: at, reason: 'Previous revision evidence' });
    const pin = step % 2 === 0;
    if (mode === 'native') await remember('Alpha instructions', { ...target.options, update: 'alpha', kind: 'reference', pin });
    else {
      const { path, manifest } = await exportedPolicy(target, `pin-${step}`, mode);
      manifest.guidance[0].pinned = pin; await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
      await writeFile(join(path, manifest.guidance[0].path), policyBody(manifest.guidance[0], 'Alpha instructions'));
      assert.equal((await importDir(path, { ...target.options, from: mode })).updated, 1);
    }
    const actual = (await target.client.get(memory.id, { full: true })).item;
    assert.equal(actual.memory_pinned, pin); assert.equal(actual.memory_changed_at, at);
    assert.equal(actual.body, 'Alpha instructions'); assert.equal(actual.memory_verdict, 'unknown');
    assert.equal(actual.memory_verified_at, undefined); assert.equal(actual.memory_reason, undefined);
    const entry = (await readHistoryEntries(getHistoryPath(target.workspace, memory.id), memory.id)).at(-1)!;
    assert.ok(entry.patch.some(patch => patch.path === '/metadata/memory_pinned'));
    assert.ok(!entry.patch.some(patch => ['/body', '/metadata/memory_changed_at'].includes(patch.path)));
  }
  const peer = await remember('Independent linked reference', { ...target.options, slug: 'beta', kind: 'reference', forceNew: true });
  const old = '2020-01-01T00:00:00.000Z';
  await target.store.fields(memory.id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Current content evidence' });
  if (mode === 'native') await remember('Alpha instructions', { ...target.options, update: 'alpha', kind: 'reference', links: ['beta'] });
  else {
    const { path, manifest } = await exportedPolicy(target, 'links', mode);
    const alpha = manifest.guidance.find(row => row.slug === 'alpha')!; alpha.relationships.push({ slug: 'beta', kind: 'related' });
    await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
    await writeFile(join(path, alpha.path), policyBody(alpha, 'Alpha instructions'));
    assert.equal((await importDir(path, { ...target.options, from: mode })).updated, 1);
  }
  const linked = (await target.client.get(memory.id, { full: true })).item;
  assert.deepEqual([linked.memory_changed_at, linked.memory_verdict, linked.memory_verified_at, linked.memory_reason], [old, 'verified', old, 'Current content evidence']);
  assert.ok(linked.dependencies?.some(edge => edge.id === peer.id && edge.kind === 'related'));
  const before = Date.now();
  if (mode === 'native') await remember('Revised Alpha instructions', { ...target.options, update: 'alpha', kind: 'reference' });
  else {
    const { path, manifest } = await exportedPolicy(target, 'content', mode);
    const alpha = manifest.guidance.find(row => row.slug === 'alpha')!;
    await writeFile(join(path, alpha.path), policyBody(alpha, 'Revised Alpha instructions'));
    assert.equal((await importDir(path, { ...target.options, from: mode })).updated, 1);
  }
  const current = (await target.client.get(memory.id, { full: true })).item;
  assert.equal(current.body, 'Revised Alpha instructions'); assert.ok(Date.parse(String(current.memory_changed_at)) >= before);
});

for (const to of ['agents-md', 'claude-code'] as const) test(`renewals retain content age and foreign policy changes refuse without writes: ${to}`, async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const memory = await remember('Bounded age control', { ...target.options, slug: 'bounded', kind: 'project', pin: true });
  const old = '2020-01-01T00:00:00.000Z';
  await target.store.fields(memory.id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Existing verification' });
  const source = await clonedTracker(t, target);
  await renew('bounded', { ...source.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Independent policy renewal' });
  const actual = (await source.client.get(memory.id, { full: true })).item;
  assert.deepEqual([actual.memory_changed_at, actual.memory_verdict, actual.memory_verified_at, actual.memory_reason], [old, 'verified', old, 'Existing verification']);
  assert.equal(JSON.parse(String(actual.memory_validity)).evidence, 'Independent policy renewal');
  const { path } = await exportedPolicy(source, 'renewal', to); const before = await snapshot(target.workspace);
  await assert.rejects(importDir(path, { ...target.options, from: to }), error => error instanceof MemoryError && error.code === 'validity');
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('raw interrupted edge completion retains aged content and native verification', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const path = join(target.root, 'raw'); await mkdir(path);
  await writeFile(join(path, 'alpha.md'), 'Alpha [[beta]]'); await writeFile(join(path, 'beta.md'), 'Independent reference');
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'nodes') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const items = (await target.client.listAllComplete()).items;
  const alpha = items.find(row => row.memory_slug === 'alpha')!; const beta = items.find(row => row.memory_slug === 'beta')!;
  const old = '2020-01-01T00:00:00.000Z';
  await target.store.fields(alpha.id, { changed_at: old, verdict: 'verified', verified_at: old, reason: 'Retained content evidence' });
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 1);
  const repaired = (await target.client.get(alpha.id, { full: true })).item;
  assert.deepEqual([repaired.memory_changed_at, repaired.memory_verdict, repaired.memory_verified_at, repaired.memory_reason], [old, 'verified', old, 'Retained content evidence']);
  assert.ok(repaired.dependencies?.some(edge => edge.id === beta.id && edge.kind === 'related'));
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 0);
  assert.deepEqual((await target.client.get(alpha.id, { full: true })).item, repaired);
});

test('operational unsets preserve age and evidence while pin and content edits invalidate verification', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const memory = await remember('Content unset control', { ...target.options, slug: 'unset', kind: 'reference', why: 'Prior rationale' });
  const old = '2020-01-01T00:00:00.000Z'; const now = new Date().toISOString();
  for (const field of ['memory_merge', 'memory_pinned', 'memory_why']) {
    await target.store.fields(memory.id, { changed_at: old, merge: 'Operational control', pinned: true, why: 'Prior rationale', verdict: 'stale', verified_at: old, reason: 'Prior evidence' });
    const options: Record<string, unknown> = { unset: [field] }; contentRevision(options, now, old);
    await target.client.run('update', { id: memory.id, options });
    const inventory = await target.client.listAllComplete({ includeBody: true }); assert.equal(inventory.items.length, 1);
    const actual = inventory.items[0];
    assert.equal(actual.memory_changed_at, field === 'memory_why' ? now : old);
    assert.equal(actual[field], undefined);
    assert.equal(actual.memory_reason, field === 'memory_merge' ? 'Prior evidence' : undefined);
    assert.equal(actual.memory_verified_at, field === 'memory_merge' ? old : undefined);
    assert.equal(actual.memory_verdict, field === 'memory_merge' ? 'stale' : 'unknown');
  }
});
