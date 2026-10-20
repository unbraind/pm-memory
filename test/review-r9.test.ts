import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { consolidate, remember, verify } from '../index.ts';
import { proposals } from '../src/consolidate.ts';
import { packetTokens } from '../src/core.ts';
import { recallPacket } from '../src/memory.ts';
import { checkClaim } from '../src/verify.ts';
import { snapshot, tracker } from './helpers.ts';

test('stale supersession sources stay active while unrelated archives still apply', async t => {
  const { options, store } = await tracker(t);
  const old = await remember('Audit policy\nEnable audit logging', { ...options, kind: 'project', slug: 'old' });
  const newer = await remember('Audit policy\nDisable audit logging', { ...options, kind: 'project', slug: 'newer', forceNew: true });
  const stale = await remember('Unrelated obsolete deployment note', { ...options, kind: 'reference', slug: 'stale' });
  for (const id of [old.id, stale.id]) await store.fields(id, { verdict: 'stale', reason: 'symbol absent in 1 files searched' });
  const before = await snapshot(options.workspace);
  const dry = await consolidate({ ...options, minAgeDays: 0 });
  assert.deepEqual(dry.proposals.map(row => [row.action, row.slug, row.target]), [['supersedes', 'old', 'newer'], ['archive', 'stale', undefined]]);
  assert.deepEqual(await snapshot(options.workspace), before);
  const applied = await consolidate({ ...options, minAgeDays: 0, apply: true });
  assert.deepEqual(applied.proposals, dry.proposals);
  const rows = await store.read();
  assert.equal(rows.find(row => row.id === old.id)!.status, 'open');
  assert.equal(rows.find(row => row.id === newer.id)!.status, 'open');
  assert.deepEqual(rows.find(row => row.id === newer.id)!.supersedes, [old.id]);
  assert.equal(rows.find(row => row.id === stale.id)!.status, 'canceled');
});

test('randomized consolidation invariant assigns every memory at most one action role', async t => {
  const { options, store } = await tracker(t);
  await remember('Synthetic randomized plan seed', { ...options, kind: 'project', slug: 'seed' });
  const base = (await store.read())[0];
  let state = 0x51a9;
  /** Generate reproducible bounded integers without timing-dependent randomness. */
  const random = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
  const actions = new Set<string>();
  let total = 0;
  for (let sample = 0; sample < 500; sample++) {
    const memories = Array.from({ length: 6 + random(19) }, (_, index) => {
      const group = random(4); const verb = random(3);
      return { ...base, id: `synthetic-${index}`, slug: `policy-${group}-${index}`, title: `Policy ${group}`, body: `${['Enable', 'Disable', 'Enable'][verb]} audit logging for policy ${group}`, updated: `2020-01-${String(index + 1).padStart(2, '0')}`, verdict: random(3) === 0 ? 'stale' as const : 'unknown' as const, reason: 'symbol absent in 1 files searched', recalls: random(4) === 0 ? 1 : 0, pinned: random(5) === 0, status: random(8) === 0 ? 'canceled' : 'open', artifact: random(10) === 0, supersedes: random(4) === 0 ? [`synthetic-${random(index + 1)}`] : [] };
    });
    const plan = proposals(memories, 0);
    assert.deepEqual(proposals([...memories].reverse(), 0), plan, `sample ${sample} must ignore input order`);
    const roles = new Map<string, string>();
    for (const proposal of plan) {
      actions.add(proposal.action); total++;
      for (const endpoint of [proposal.slug, ...(proposal.target === undefined ? [] : [proposal.target])]) {
        assert.ok(!roles.has(endpoint), `sample ${sample}: ${endpoint} in ${roles.get(endpoint)} and ${proposal.action}`);
        roles.set(endpoint, proposal.action);
      }
    }
  }
  assert.deepEqual([...actions].sort(), ['archive', 'merge', 'supersedes']);
  assert.ok(total > 100, `exercised ${total} actions`);
  t.diagnostic(`500 deterministic randomized memory sets; ${total} actions; no repeated endpoint`);
});

test('recall accounts complete candidates with bounded serialization work', async t => {
  const { options, store } = await tracker(t);
  await remember('Synthetic packet accounting guidance', { ...options, kind: 'project', slug: 'seed' });
  const base = (await store.read())[0];
  for (const count of [12, 24, 48]) {
    const memories = Array.from({ length: count }, (_, index) => ({ ...base, slug: `row-${index}` }));
    const rows = memories.map(item => ({ slug: item.slug, description: 'Compact hook' }));
    let serializations = 0; const stringify = JSON.stringify;
    const hook = t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
      const value: unknown = args[0];
      if (typeof value === 'object' && value !== null && 'memories' in value) serializations++;
      return stringify(...args);
    });
    const packet = recallPacket(rows, memories, 'accounting', 100000);
    hook.mock.restore();
    assert.equal(packet.memories!.length, count);
    assert.equal(packet.omitted, 0);
    assert.equal(packet.estimated_tokens, packetTokens(packet));
    assert.ok(packet.memories!.every(row => row.text?.includes('accounting')));
    assert.ok(serializations < count * 15, `${count} rows needed ${serializations} packet serializations`);
    t.diagnostic(`${count} rows: ${serializations} packet serializations`);
  }
});

test('excluded context files cannot establish symbol absence', async t => {
  const { root, options } = await tracker(t);
  await mkdir(join(root, 'docs')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'entry.ts'), 'export const presentSymbol = true;\n');
  for (const [index, context] of ['docs/setup.md', 'docs/setup.mdx', 'docs/setup.mdc', '.agents/setup.ts', '.agents/pm/setup.ts'].entries()) {
    await writeFile(join(root, context), 'installHooks();\n');
    assert.equal((await checkClaim({ type: 'symbol', value: 'installHooks()', context }, root, false)).verdict, 'unknown');
    await remember(`See \`${context}\` installHooks()`, { ...options, kind: 'project', slug: `excluded-${index}`, forceNew: true });
  }
  await remember('See `src/entry.ts` absentSymbol()', { ...options, kind: 'project', slug: 'searched' });
  await remember('See `docs/missing.md` missingSymbol()', { ...options, kind: 'project', slug: 'missing' });
  const result = await verify({ ...options, root });
  for (const row of result.results.filter(row => row.slug.startsWith('excluded-'))) {
    assert.equal(row.verdict, 'unknown');
    for (const claim of row.claims.filter(claim => claim.type === 'file')) assert.equal(claim.verdict, 'verified');
    assert.equal(row.claims.find(claim => claim.type === 'symbol')!.verdict, 'unknown');
  }
  assert.equal(result.results.find(row => row.slug === 'searched')!.verdict, 'stale');
  assert.equal(result.results.find(row => row.slug === 'missing')!.claims.find(claim => claim.type === 'symbol')!.verdict, 'unknown');
});


test('pending merge endpoints refuse overlapping and self-referential receipts before writes', async t => {
  const { options, store, workspace, client } = await tracker(t);
  const source = await remember('Repeated recoverable context', { ...options, kind: 'project', slug: 'source' });
  const target = await remember('Repeated recoverable context', { ...options, kind: 'project', slug: 'target', forceNew: true });
  await consolidate({ ...options, apply: true });
  let recorded = '';
  for (const event of await readHistoryEntries(join(workspace, 'history', `${source.id}.jsonl`), source.id)) {
    for (const operation of event.patch) {
      if (operation.path.endsWith('/memory_merge') && 'value' in operation && typeof operation.value === 'string' && operation.value.length > 0) recorded = operation.value;
    }
  }
  assert.notEqual(recorded, '', 'the real merge must record durable recovery evidence');
  const receipt = JSON.parse(recorded) as Record<string, unknown>;
  await client.update(source.id, { status: 'open' });
  for (const overlap of [false, true]) {
    await store.fields(source.id, { merge: overlap ? recorded : JSON.stringify({ ...receipt, target: source.slug, target_before: receipt.source_revision, target_after: receipt.source_revision }) });
    await store.fields(target.id, { merge: overlap ? JSON.stringify({ ...receipt, target: source.slug, source_revision: receipt.target_after, target_before: receipt.source_revision, target_after: receipt.source_revision }) : '' });
    const before = await snapshot(workspace);
    for (const apply of [false, true]) {
      await assert.rejects(consolidate({ ...options, apply }), /Pending memory merges reuse an action endpoint/);
      assert.deepEqual(await snapshot(workspace), before);
    }
  }
});
