import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, readHistoryEntries, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { importDir, exportDir, remember, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { Harness, PortablePolicyManifest } from '../index.ts';
import { expectedTargets, observeTargets } from '../src/portable-plan.ts';
import { nativeState } from '../src/portable-write.ts';
import { tracker, importHarness, clonedTracker } from './helpers.ts';

/** Seed each public adapter using real native history, with an editable harness revision. */
async function collisionFixture(t: Parameters<typeof tracker>[0], mode: 'raw' | 'companion' | 'policy', from: Harness) {
  const target = await tracker(t);
  let path: string;
  let file: string;
  if (mode === 'policy') {
    assert.notEqual(from, 'cursor');
    await remember('Original A', { ...target.options, slug: 'alpha', kind: 'reference' });
    path = join(target.root, 'policy');
    await exportDir(path, { ...target.options, to: from as 'agents-md' | 'claude-code' });
    const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    file = join(path, manifest.guidance[0].path);
  } else if (from === 'cursor') {
    file = join(target.root, 'alpha.md'); path = file;
    await writeFile(file, '# Alpha\nOriginal A\n');
    await importDir(path, { ...target.options, from });
  } else {
    const input = await importHarness(target, from, '---\nname: alpha\n---\n# Alpha\nOriginal A\n');
    path = mode === 'raw' ? input.directory : join(target.root, 'companion');
    if (mode === 'companion') await exportDir(path, { ...target.options, to: from });
    file = join(path, input.name);
    assert.equal((await readFile(join(path, POLICY_MANIFEST)).then(() => true).catch(() => false)), false, 'exercise the legacy companion rather than silently falling back to policy');
  }
  const id = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!.id;
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('Original A', 'Harness B'));
  return { target, path, id, from };
}

const adapters = [
  ['raw', 'agents-md'], ['raw', 'claude-code'], ['raw', 'cursor'],
  ['companion', 'agents-md'], ['companion', 'claude-code'],
  ['policy', 'agents-md'], ['policy', 'claude-code'],
] as const;

for (const [mode, from] of adapters) test(`collision property: ${mode}/${from} planning, recovery, retry and export retain native revisions`, { timeout: 600000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  const base = await collisionFixture(t, mode, from);
  let seed = 0x15c0111;
  for (const phase of ['read', 'previewed', 'intent', 'item-read', 'recovery', 'retry', 'aba'] as const) {
    if (process.env.PM_MEMORY_COLLISION_PROGRESS === '1') process.stderr.write(`COLLISION ${mode}/${from} phase=${phase}\n`);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const target = await clonedTracker(t, base.target);
    const before = (await target.client.get(base.id, { full: true })).item;
    const peer = `Native C ${seed}`;
    let injected = false;
    /** Commit a real native peer write while deliberately retaining the observed timestamp. */
    const edit = async () => {
      await target.client.update(base.id, { body: peer });
      if (phase === 'aba') await target.client.update(base.id, { body: String(before.body) });
      const actual = (await target.client.get(base.id, { full: true })).item;
      assert.equal(actual.updated_at, before.updated_at, 'the regression must actually collide');
      injected = true;
    };
    if (phase === 'recovery') await assert.rejects(importDir(base.path, { ...target.options, from, onStep: step => { if (step === 'intent') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    if (phase === 'retry') await edit();
    const result = await importDir(base.path, { ...target.options, from, onStep: async step => {
      if (!injected && step === (phase === 'recovery' ? 'read' : phase === 'aba' ? 'read' : phase)) await edit();
    } });
    const label = `seed=${seed} ${mode}/${from} phase=${phase}`;
    assert.ok(injected, label);
    const expected = phase === 'aba' ? before.body : peer;
    assert.equal((await target.client.get(base.id, { full: true })).item.body, expected, label);
    assert.ok('skipped' in result && result.skipped.some(row => row.conflict?.item === base.id), `${label}: typed conflict`);
    const entries = await readHistoryEntries(getHistoryPath(target.workspace, base.id), base.id);
    assert.equal(entries.length, (await readHistoryEntries(getHistoryPath(base.target.workspace, base.id), base.id)).length + (phase === 'aba' ? 2 : 1), `${label}: import made no item writes`);
    const retry = await importDir(base.path, { ...target.options, from });
    // An independent retry may adopt the original value again, but never a differing native value.
    const retriedBody = phase === 'aba' ? String(before.body).replace('Original A', 'Harness B') : expected;
    if (phase === 'aba') assert.equal(retry.updated, 1, `${label}: fresh matching snapshot`);
    else assert.ok('skipped' in retry && retry.skipped.some(row => row.slug === 'alpha'), `${label}: retry conflict`);
    assert.equal((await target.client.get(base.id, { full: true })).item.body, retriedBody, label);
    // Export the current collision revision, then import that exact content into a separate tracker.
    const output = join(target.root, 'collision-export'); const to = from === 'cursor' ? 'agents-md' : from;
    await exportDir(output, { ...target.options, to });
    const destination = await tracker(t);
    await importDir(output, { ...destination.options, from: to });
    assert.equal((await destination.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === 'alpha')!.body, retriedBody, `${label}: export identity`);
  }
  t.diagnostic(`COLLISION_SEED=0x15c0111 adapter=${mode}/${from} paths=7 same_updated_at=true no_git=true`);
});

test('planning capture refuses stale content and freezes history even for same-time ABA', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  const target = await tracker(t); const memory = await remember('Original A', { ...target.options, slug: 'alpha', kind: 'reference' });
  const corpus = (await target.client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(observeTargets(target.store, [{ ...corpus[0], body: undefined }]), error => error instanceof MemoryError && error.code === 'conflict');
  const observed = await observeTargets(target.store, corpus);
  await target.client.update(memory.id, { body: 'Native C' });
  assert.equal((await target.client.get(memory.id, { full: true })).item.updated_at, corpus[0].updated_at);
  await assert.rejects(observeTargets(target.store, corpus), error => error instanceof MemoryError && error.code === 'conflict');
  await target.client.update(memory.id, { body: 'Original A' });
  const [base] = await expectedTargets(target.store, [{ id: memory.id, slug: 'alpha' }], observed);
  const actual = await nativeState(target.store, memory.id);
  assert.equal(base.document!.body, actual.document!.body);
  assert.notEqual(base.history, actual.proof.history);
  assert.equal(actual.proof.length, base.length + 2);
});

test('README source revision contract explicitly invalidates verification', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const contract = readme.slice(readme.indexOf('Source revisions preserve'), readme.indexOf('Independently revised items refuse'));
  assert.doesNotMatch(contract, /preserve[^.]*verification/);
  assert.match(contract, /Content changes clear prior verification evidence and reset the verdict to `unknown` in the same native mutation/);
});
