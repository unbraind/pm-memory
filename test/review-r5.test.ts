import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remember, consolidate, importDir, exportDir } from '../index.ts';
import { proposals } from '../src/consolidate.ts';
import { privacy } from '../src/core.ts';
import { gitEnvironment, testEnvironment } from '../scripts/environment.ts';
import { tracker, snapshot, assertTestsPassed } from './helpers.ts';

test('supersession targets survive duplicate merges on this and subsequent plans', async t => {
  const { options, store, client } = await tracker(t);
  const old = await remember('Policy\nEnable audit logging and retain access records daily', { ...options, kind: 'project', slug: 'old' });
  const newer = await remember('Policy\nDisable audit logging and retain access records daily', { ...options, kind: 'project', slug: 'newer', forceNew: true });
  const latest = await remember('Policy\nDisable audit logging and retain access records daily', { ...options, kind: 'project', slug: 'latest', forceNew: true });
  for (const id of [old.id, newer.id, latest.id]) await client.update(id, { title: 'Policy' });
  for (let pass = 0; pass < 2; pass++) {
    const plan = await consolidate(options);
    assert.ok(!plan.proposals.some(row => row.action === 'merge' && [old.slug, newer.slug, latest.slug].includes(row.slug)));
    await consolidate({ ...options, apply: true });
    const rows = await store.read();
    assert.ok(rows.every(row => row.status !== 'canceled'));
    assert.ok(rows.find(row => row.id === newer.id)!.supersedes!.includes(old.id));
  }
  const base = (await store.read())[0];
  assert.deepEqual(proposals([{ ...base, supersedes: ['absent'] }]), []);
});

test('credential URI authorities fail closed for every scheme without query false positives', async t => {
  const { options, workspace, root } = await tracker(t);
  const before = await snapshot(workspace);
  for (const uri of ['postgres://app:fake-password@db.test/app', 'mongodb+srv://user:pw@cluster.test/x', 'redis://:pw@cache.test:6379', 'amqp://u:p@mq.test', 'custom+v1://:fake-password@host.test', 'postgres://u@ser:pw@host.test/db']) {
    await assert.rejects(remember(`The development connection is ${uri}`, { ...options, kind: 'project', allowEmail: true }), /Credential-shaped/);
    const file = join(root, 'memory.md'); await writeFile(file, `# Connection guidance\nUse ${uri}\n`);
    await assert.rejects(importDir(file, { ...options, from: 'agents-md', allowEmail: true }), /Import refused/);
  }
  assert.deepEqual(await snapshot(workspace), before);
  for (const uri of ['https://host.test/?q=a:b@c', 'custom://host.test#hint=a:b@c', 'redis://user:@host.test', 'postgres://host.test/app']) privacy(uri, true);
});

test('punctuated import paths and path slugs resolve the same wiki aliases idempotently', async t => {
  const { root, options, store } = await tracker(t);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, '!My Note!.md'), '---\nname: canonical\n---\nCanonical instructions\n');
  await writeFile(join(source, '!Other Note!.md'), 'Another instruction\n');
  await writeFile(join(source, '_Hidden!.md'), 'Additional portable guidance\n');
  await writeFile(join(source, 'references.md'), 'See [[my-note]], [[other-note]] and [[_hidden]]\n');
  await assert.doesNotReject(async () => { assert.equal((await importDir(source, { ...options, from: 'claude-code' })).unresolved_links, 0); });
  const rows = await store.read();
  const references = rows.find(row => row.slug === 'references')!;
  assert.deepEqual(new Set(references.links), new Set(rows.filter(row => row.slug !== 'references').map(row => row.id)));
  const before = await snapshot(options.workspace);
  assert.equal((await importDir(source, { ...options, from: 'claude-code' })).unchanged, 4);
  assert.deepEqual(await snapshot(options.workspace), before);
});

test('agents policy round trips preserve native state and include new content once', async t => {
  const first = await tracker(t);
  await remember('First standing guidance', { ...first.options, kind: 'project', slug: 'first' });
  const original = join(first.root, 'original'); await exportDir(original, { ...first.options, to: 'agents-md' });
  const second = await tracker(t); await importDir(original, { ...second.options, from: 'agents-md' });
  const repeated = join(second.root, 'repeated');
  assert.deepEqual(await exportDir(repeated, { ...second.options, to: 'agents-md' }), { exported: 3, byte_preserved: 0 });
  const retained = (await second.client.listAllComplete({ includeBody: true })).items;
  await importDir(repeated, { ...second.options, from: 'agents-md' });
  assert.deepEqual((await second.client.listAllComplete({ includeBody: true })).items, retained);
  await remember('Second distinct standing guidance', { ...second.options, kind: 'user', slug: 'second' });
  const expanded = join(second.root, 'expanded');
  assert.deepEqual(await exportDir(expanded, { ...second.options, to: 'agents-md' }), { exported: 4, byte_preserved: 0 });
  const content = await readFile(join(expanded, 'AGENTS.md'), 'utf8');
  for (const phrase of ['memories/first.md', 'memories/second.md']) assert.equal(content.split(phrase).length - 1, 1);
  const third = await tracker(t); await importDir(expanded, { ...third.options, from: 'agents-md' });
  const final = join(third.root, 'final');
  assert.deepEqual(await exportDir(final, { ...third.options, to: 'agents-md' }), { exported: 4, byte_preserved: 0 });
  assert.equal(await readFile(join(final, 'AGENTS.md'), 'utf8'), content);
  for (const slug of ['first', 'second']) {
    const body = (await readFile(join(final, 'memories', `${slug}.md`), 'utf8')).split('\n').slice(1).join('\n');
    assert.equal(body, (await third.store.read()).find(row => row.slug === slug)!.body);
  }
});

test('privacy audit uses its own repository even under inherited Git hook overrides', async t => {
  const { root } = await tracker(t);
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=authored and tracker files', 'test/edges.test.ts'], {
    cwd: join(import.meta.dirname, '..'), encoding: 'utf8',
    env: { ...testEnvironment(gitEnvironment(process.env)), GIT_DIR: join(root, 'nonexistent.git'), GIT_WORK_TREE: root, GIT_INDEX_FILE: join(root, 'index') },
  });
  assertTestsPassed(result, 'authored and tracker files');
});

test('README path and export contracts match the implemented behaviour', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Export creates missing destination parents after preflight/);
  assert.match(readme, /Home-relative and home-absolute paths can resolve when their portable suffix matches an indexed path under a declared root/);
  assert.ok(!readme.includes('its parent must exist'));
});

test('pending merge receipts refuse intervening source and target edits before any writes', async t => {
  const { options, store, workspace, client } = await tracker(t);
  const source = await remember('Repeated safe guidance', { ...options, kind: 'project', slug: 'source' });
  const target = await remember('Repeated safe guidance', { ...options, kind: 'project', slug: 'target', forceNew: true });
  const initialTarget = (await store.read()).find(row => row.id === target.id)!;
  await consolidate({ ...options, apply: true });
  const rows = await store.read();
  const history = (await readFile(join(workspace, 'history', `${source.id}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { patch: { path: string; value?: unknown }[] });
  const recorded = history.flatMap(event => event.patch).find(patch => patch.path.endsWith('/memory_merge') && typeof patch.value === 'string' && patch.value !== '')!.value as string;
  const receipt = JSON.parse(recorded) as Record<string, unknown>;
  const unsafe = [recorded, '{', 'null', JSON.stringify({ target: target.slug, body: 'Legacy context', changed_at: '2020' }), ...[{ target: 'missing' }, { body: 1 }, { changed_at: 1 }].map(patch => JSON.stringify({ ...receipt, ...patch }))];
  for (const scenario of ['source', 'target', 'archived', ...unsafe]) {
    await client.update(source.id, { body: scenario === 'source' ? 'Acknowledged intervening source edit' : rows.find(row => row.id === source.id)!.body, status: 'open' });
    await client.update(target.id, { body: scenario === 'target' ? 'Acknowledged intervening target edit' : rows.find(row => row.id === target.id)!.body, status: scenario === 'archived' ? 'canceled' : 'open', closeReason: 'Synthetic concurrent lifecycle change' });
    await store.fields(source.id, { merge: unsafe.includes(scenario) ? scenario : recorded });
    const before = await snapshot(workspace);
    if (scenario === recorded) {
      await consolidate({ ...options, apply: true });
      assert.equal((await store.read()).find(row => row.id === source.id)!.merge, '');
      continue;
    }
    await assert.rejects(consolidate({ ...options, apply: true }), /pending memory merge|Pending memory merge/);
    assert.deepEqual(await snapshot(workspace), before);
    assert.notEqual((await store.read()).find(row => row.id === source.id)!.merge, '');
  }
  await client.update(target.id, { body: initialTarget.body });
  await store.fields(target.id, { changed_at: initialTarget.updated });
  await store.fields(source.id, { merge: recorded });
  await consolidate({ ...options, apply: true });
  assert.equal((await store.read()).find(row => row.id === target.id)!.body, rows.find(row => row.id === target.id)!.body);
  assert.equal((await store.read()).find(row => row.id === source.id)!.merge, '');
});
