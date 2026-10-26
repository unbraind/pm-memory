import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { remember, consolidate, importDir, exportDir, verify } from '../index.ts';
import { checkClaim } from '../src/verify.ts';
import { tracker } from './helpers.ts';

test('competing merge and supersession keep the linked source active', async t => {
  const { options, store, client } = await tracker(t);
  const source = await remember('Enable audit logging and retain access records daily', { ...options, kind: 'project', slug: 'old' });
  const duplicate = await remember('Enable audit logging and retain access records daily', { ...options, kind: 'project', slug: 'duplicate', forceNew: true });
  const opposite = await remember('Disable audit logging and retain access records daily', { ...options, kind: 'project', slug: 'new', forceNew: true });
  await client.update(source.id, { title: 'Policy alpha' });
  await client.update(duplicate.id, { title: 'alpha' });
  await client.update(opposite.id, { title: 'Policy alpha enforcement' });
  const plan = await consolidate(options);
  assert.ok(plan.proposals.some(row => row.action === 'supersedes' && row.slug === 'old' && row.target === 'new'));
  assert.ok(!plan.proposals.some(row => row.action === 'merge' && row.slug === 'old'));
  await consolidate({ ...options, apply: true });
  const rows = await store.read();
  assert.equal(rows.find(row => row.id === source.id)!.status, 'open');
  assert.ok(rows.find(row => row.id === opposite.id)!.supersedes!.includes(source.id));
  assert.ok(rows.filter(row => row.status !== 'canceled').every(row => row.supersedes!.every(id => rows.some(target => target.id === id && target.status !== 'canceled'))));
});

test('unchanged remember preserves stale verification, import bytes and reimport eligibility', async t => {
  const { root, options, store, client } = await tracker(t);
  const source = join(root, 'source'); await mkdir(source);
  const bytes = '---\r\nname: guide\r\nmetadata:\r\n  type: project\r\n---\r\nguide\r\nUse source evidence\r\n';
  await writeFile(join(source, 'guide.md'), bytes);
  await importDir(source, { ...options, from: 'claude-code' });
  const imported = (await store.read())[0];
  const verified = '2025-01-01T00:00:00.000Z';
  await store.fields(imported.id, { verdict: 'stale', verified_at: verified });
  const target = await remember('Distinct linked reference', { ...options, kind: 'reference', slug: 'target' });
  await remember(`${imported.body}\n`, { ...options, kind: 'project', update: imported.slug, links: [target.slug] });
  const unchanged = (await store.read()).find(row => row.id === imported.id)!;
  assert.equal(unchanged.updated, imported.updated);
  assert.equal(unchanged.verdict, 'stale'); assert.equal(unchanged.edited, false);
  assert.equal((await client.get(imported.id, { full: true })).item.memory_verified_at, verified);
  const out = join(root, 'out'); await exportDir(out, { ...options, to: 'claude-code' });
  assert.equal((await client.get(imported.id, { full: true })).item.memory_original, Buffer.from(bytes).toString('base64'));
  const exported = await readFile(join(out, 'memories/guide.md'), 'utf8');
  assert.equal(exported.slice(exported.indexOf('\n') + 1), imported.body);
  assert.equal((await importDir(source, { ...options, from: 'claude-code' })).unchanged, 1);
  await remember(imported.body, { ...options, kind: 'project', update: imported.slug, pin: true });
  const changed = (await store.read()).find(row => row.id === imported.id)!;
  assert.equal(changed.verdict, 'unknown'); assert.equal(changed.edited, true);
  assert.equal((await client.get(imported.id, { full: true })).item.memory_verified_at, '');
});

test('export rejects reserved and nested case-folded names before publication', async t => {
  const native = await tracker(t);
  await remember('Portable index collision', { ...native.options, kind: 'reference', slug: 'memory' });
  const output = join(native.root, 'out'); await exportDir(output, { ...native.options, to: 'claude-code' });
  assert.match(await readFile(join(output, 'memories/memory.md'), 'utf8'), /Portable index collision/);
  for (const to of ['claude-code', 'agents-md'] as const) {
    const { root, options } = await tracker(t);
    const source = join(root, 'source'); await mkdir(source);
    await mkdir(join(source, 'Notes')); await mkdir(join(source, 'notes'));
    await writeFile(join(source, 'Notes', 'one.md'), '---\nname: first\n---\nFirst guidance\n');
    await writeFile(join(source, 'notes', 'ONE.md'), '---\nname: second\n---\nSecond guidance\n');
    await importDir(source, { ...options, from: to });
    await assert.rejects(exportDir(join(root, 'out'), { ...options, to }), /Export names collide/);
  }
  const lower = await tracker(t);
  const file = join(lower.root, 'agents.md'); await writeFile(file, 'Lowercase source index');
  await importDir(file, { ...lower.options, from: 'agents-md' });
  await assert.rejects(exportDir(join(lower.root, 'out'), { ...lower.options, to: 'agents-md' }), /Export names collide/);
});

test('network verification releases writers and skips changed, archived and native-edited snapshots', async t => {
  const { root, options, store, client } = await tracker(t);
  let requested!: () => void; const arrived = new Promise<void>(resolve => { requested = resolve; });
  let finish!: () => void; const responseReady = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(async (_request, response) => { requested(); await responseReady; response.statusCode = 404; response.end(); });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const endpoint = server.address();
  assert.ok(endpoint && typeof endpoint === 'object');
  const body = `Check http://127.0.0.1:${endpoint.port}/missing`;
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  const changed = await remember(body, { ...options, kind: 'project', slug: 'changed' });
  const archived = await remember(body, { ...options, kind: 'project', slug: 'archived', forceNew: true });
  const native = await remember(body, { ...options, kind: 'project', slug: 'native', forceNew: true });
  const stable = await remember(body, { ...options, kind: 'project', slug: 'stable', forceNew: true });
  // Keep the real response pending under host load; finally releases it before the writer wait expires.
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  const checking = verify({ ...options, root, network: true });
  await arrived;
  const writing = remember('Acknowledged newer guidance', { ...options, kind: 'project', update: changed.slug });
  let writable: boolean;
  try {
    writable = await Promise.race([writing.then(() => true), delay(15000, false, { ref: false })]);
    if (writable) {
      await client.update(archived.id, { status: 'canceled', closeReason: 'Synthetic concurrent archive' });
      await client.update(native.id, { body: 'Native edit without custom changed timestamp' });
    }
  } finally { finish(); }
  const result = await checking; await writing;
  assert.equal(writable, true, 'remember must finish while the network response is pending');
  assert.deepEqual(result.results.map(row => row.slug), [stable.slug]);
  assert.deepEqual(result.skipped?.sort(), [changed.slug, archived.slug, native.slug].sort());
  const rows = await store.read();
  for (const id of [changed.id, archived.id, native.id]) assert.equal(rows.find(row => row.id === id)!.verdict, 'unknown');
  assert.equal(rows.find(row => row.id === stable.id)!.verdict, 'stale');
});

test('network evidence subprocesses leave the event loop responsive on success and failure', async t => {
  const { root } = await tracker(t); const bin = join(root, 'bin'); await mkdir(bin);
  for (const name of ['gh', 'npm']) {
    await writeFile(join(bin, name), '#!/bin/sh\nsleep 0.3\ncase "$2" in\n good@1.2.3) echo \'"1.2.3"\';;\n mismatch@1.2.3) echo \'"2.0.0"\';;\n *) exit 1;;\nesac\n');
    await chmod(join(bin, name), 0o755);
  }
  const prior = process.env.PATH; process.env.PATH = `${bin}${delimiter}${prior}`;
  t.after(() => { process.env.PATH = prior; });
  for (const claim of [{ type: 'repo', value: 'owner/missing' }, { type: 'package', value: 'good@1.2.3' }, { type: 'package', value: 'mismatch@1.2.3' } ] as const) {
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 30);
    const checking = checkClaim(claim, root, true);
    assert.equal(ticked, false, 'subprocess must return control before completion');
    const result = await checking; clearTimeout(timer);
    assert.equal(ticked, true);
    assert.equal(result.verdict, claim.value === 'good@1.2.3' ? 'verified' : 'unknown');
  }
});
