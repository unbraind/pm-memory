import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import extension, { remember, recall, index, MemoryError, packetTokens } from '../index.ts';
import { budget, digest, kind, pack, privacy, similarity, slug, text } from '../src/core.ts';
import { active, DUPLICATE_THRESHOLD, rank } from '../src/memory.ts';
import { tracker, snapshot } from './helpers.ts';
import { testEnvironment } from '../scripts/environment.ts';

/** Assert one typed refusal without exposing rejected content. */
function refused(error: unknown): boolean { assert.ok(error instanceof MemoryError); assert.ok(error.remedy.length > 0); return true; }

test('core validation and fail-closed privacy include realistic frontmatter with a fake credential', () => {
  assert.ok(extension); assert.equal(text(' hello '), ' hello ');
  for (const value of [null, {}, '']) assert.throws(() => text(value), refused);
  assert.equal(kind('user'), 'user'); assert.throws(() => kind('misc'), refused);
  assert.equal(budget(5), 5);
  for (const value of [0, -1, NaN, Infinity, 1.2]) assert.throws(() => budget(value), refused);
  assert.equal(slug('guidance-1'), 'guidance-1'); assert.throws(() => slug('../escape'), refused);
  assert.equal(digest('same'), digest('same'));
  for (const value of [
    '---\nname: Useful build guidance\ndescription: Build safely\nmetadata:\n  type: project\n---\nUse the build token: fake_token_1234567890 in the pipeline.\n',
    'sk-proj-fake000000000000000000000000', 'ghp_fake000000000000000000', 'github_pat_fake0000000000000000',
    'AKIAABCDEFGHIJKLMNOP', '-----BEGIN RSA PRIVATE KEY-----', 'password=synthetic-credential',
    'Authorization: Bearer synthetic-value', 'https://user:fake-password@example.test',
    'eyJ0123456789012345.0123456789012345.01234567890',
  ]) assert.throws(() => privacy(value, true), refused);
  assert.throws(() => privacy('Contact person@example.test'), refused);
  privacy('Contact person@example.test', true); privacy('Use a secret manager'); privacy('token: accounting'); privacy('token=$SECRET_TOKEN');
  assert.throws(() => privacy('token: abcdefghijklmnopqrstuvwxyz'), refused);
  assert.throws(() => privacy('password: lowercaseword'), refused);
});

test('dedup boundary includes title and body, explicit updates and force-new retain append-only history', async t => {
  const { options, store, client } = await tracker(t);
  const fact = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
  assert.equal(similarity(fact, `${fact} lambda mu`), 10 / 12);
  assert.ok(similarity(fact, `${fact} lambda mu`) >= DUPLICATE_THRESHOLD);
  assert.ok(similarity(fact, `${fact} lambda mu nu`) < DUPLICATE_THRESHOLD);
  const first = await remember(fact, { ...options, kind: 'project', slug: 'first', why: 'Build reasons', how: 'Run checks', pin: true, tags: ['workflow'] });
  const history = await readFile(getHistoryPath(options.workspace, first.id));
  await assert.rejects(remember(`${fact} lambda mu`, { ...options, kind: 'project', slug: 'near' }), error => { refused(error); assert.match((error as MemoryError).remedy, /--update first.*--force-new/); return true; });
  const second = await remember(`${fact} lambda mu nu`, { ...options, kind: 'feedback', slug: 'different' });
  await remember(fact, { ...options, kind: 'user', slug: 'forced', forceNew: true, links: [first.slug, second.id] });
  await assert.rejects(remember('new', { ...options, kind: 'project', update: 'absent' }), refused);
  await assert.rejects(remember('new', { ...options, kind: 'project', update: 'first', slug: 'other' }), refused);
  await assert.rejects(remember('new', { ...options, kind: 'project', links: ['missing-item'] }));
  await assert.rejects(remember('harmless', { ...options, kind: 'project', why: 'token=fake0000000000' }), refused);
  await remember(fact, { ...options, kind: 'project', slug: first.slug });
  const revised = await remember('New durable build guidance', { ...options, kind: 'reference', update: first.slug, pin: false, tags: ['updated'] });
  assert.equal(revised.updated, true);
  const after = await readFile(getHistoryPath(options.workspace, first.id)); assert.ok(after.subarray(0, history.length).equals(history));
  const item = (await store.read()).find(row => row.id === first.id)!;
  assert.equal(item.why, 'Build reasons'); assert.equal(item.how, 'Run checks'); assert.equal(item.pinned, false); assert.deepEqual(item.tags, ['updated']);
  await store.link(second.id, first.id); await store.link(second.id, first.id);
  const third = await remember('Unkeyed standing instructions', { ...options, kind: 'user' });
  assert.equal((await remember('Unkeyed standing instructions', { ...options, kind: 'user' })).id, third.id);
  await client.create({ title: 'Ordinary task', type: 'Task' });
  assert.equal((await store.read()).length, 4);
});

test('budget packer skips oversized rows and accounts for every encoding byte', () => {
  const rows = ['x'.repeat(4000), 'short', '😀漢字'];
  const rendered = pack(rows, 90, (selected, omitted) => ({ text: selected.join('\n'), omitted, complete: true }));
  assert.equal(rendered.omitted, 1); assert.ok(rendered.text!.includes('short'));
  assert.ok(packetTokens(rendered) <= 90); assert.equal(rendered.estimated_tokens, packetTokens(rendered));
  assert.throws(() => pack(rows, 1, (selected, omitted) => ({ text: selected.join(''), omitted, complete: true })), refused);
});

test('real SDK recall ranking uses rationale and tags; indexes prioritize pinned then kind and recency', async t => {
  const { options, store } = await tracker(t);
  const a = await remember('Build pipeline guidance', { ...options, kind: 'project', slug: 'build', why: 'release workflow provenance', how: 'merge driver verification', tags: ['coderabbit'] });
  await remember('Standing personal preference', { ...options, kind: 'user', slug: 'standing', pin: true });
  await remember('Temporary prose unrelated to the query', { ...options, kind: 'feedback', slug: 'other' });
  await remember('Reference related to architecture', { ...options, kind: 'reference', slug: 'architecture' });
  const memories = await store.read();
  assert.equal(rank(memories, 'coderabbit')[0].slug, 'build');
  assert.equal(rank(memories, 'release workflow')[0].slug, 'build');
  const recalled = await recall('merge driver', { ...options, budget: 400, kind: 'project' });
  assert.equal(recalled.memories![0].slug, 'build'); assert.ok(packetTokens(recalled) <= 400);
  assert.equal((await store.read()).find(item => item.id === a.id)!.recalls, 1);
  const packet = await index({ ...options, budget: 400 }); assert.ok(packet.text!.startsWith('- [Standing'));
  assert.ok(packet.text!.endsWith('<!-- omitted: 0 memories -->')); assert.equal(packet.estimated_tokens, packetTokens(packet));
  await recall('no lexical match', options); await index(options);
  await assert.rejects(recall('q', { ...options, kind: 'wrong' as 'user' }), refused);
  await assert.rejects(recall('q', { ...options, budget: 1 }), refused);
  await store.fields(a.id, { recalls: Number.MAX_SAFE_INTEGER });
  await assert.rejects(recall('merge driver', { ...options, kind: 'project' }), refused);
  assert.equal(active([{ ...memories[0], status: 'canceled' }, { ...memories[0], artifact: true }]).length, 0);
});

test('independent process recallers serialize counter read and write without losing increments', async t => {
  const { options, store } = await tracker(t);
  await remember('Concurrent exact counter guidance', { ...options, kind: 'project', slug: 'counter' });
  const children = Array.from({ length: 2 }, () => fork(join(import.meta.dirname, 'recaller.ts'), [options.workspace], { env: testEnvironment(process.env), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  for (const child of children) t.after(() => child.kill());
  const exits = children.map(child => once(child, 'exit'));
  await Promise.all(children.map(child => once(child, 'message')));
  for (const child of children) child.send('go');
  for (const outcome of await Promise.all(exits)) assert.deepEqual(outcome, [0, null]);
  assert.equal((await store.read())[0].recalls, 6);
});

test('budget property over random sets from real SDK memories covers UTF-8, omitted rows and tiny budgets', async t => {
  const { options, store } = await tracker(t);
  let seed = 19;
  /** Deterministic randomized fixture generator independent of platform entropy. */
  function random(): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
  for (let n = 0; n < 18; n++) await remember(`Fact ${n}\n${'😀 漢字 synthetic '.repeat(1 + Math.floor(random() * 40))}`, { ...options, kind: n % 2 ? 'user' : 'reference', slug: `fact-${n}`, forceNew: true, pin: n % 3 === 0 });
  const memories = await store.read();
  for (let n = 0; n < 300; n++) {
    const rows = memories.filter(() => random() > 0.3).map(item => ({ slug: item.slug, title: item.title, text: item.body }));
    const limit = 40 + Math.floor(random() * 2000);
    const packet = pack(rows, limit, (selected, omitted) => ({ memories: selected, omitted, complete: true }));
    assert.ok(packetTokens(packet) <= limit); assert.equal(packet.memories!.length + packet.omitted, rows.length);
  }
  for (const limit of [200, 800, 1500]) {
    assert.ok(packetTokens(await recall('synthetic', { ...options, budget: limit })) <= limit);
    assert.ok(packetTokens(await index({ ...options, budget: limit })) <= limit);
  }
});

test('read-only empty retrieval and consolidation receipts do not initialize memory schema', async t => {
  const { options, workspace } = await tracker(t); const before = await snapshot(workspace);
  assert.equal((await recall('no facts', options)).omitted, 0); assert.equal((await index(options)).omitted, 0);
  assert.deepEqual(await snapshot(workspace), before);
});

test('store refuses incompatible schema, duplicate keys, corrupt counters and missing history', async t => {
  const { options, store, client } = await tracker(t);
  await client.schemaAddField('memory_slug', { type: 'number' });
  await assert.rejects(store.register(), refused);
  await client.schemaRemoveField('memory_slug'); await store.register();
  const first = await remember('One fact', { ...options, kind: 'project', slug: 'one' });
  const second = await remember('Other distinct record', { ...options, kind: 'user', slug: 'two' });
  await store.fields(second.id, { slug: 'one' }); await assert.rejects(store.read(), refused);
  await store.fields(second.id, { slug: 'two', recalls: -1 }); await assert.rejects(store.read(), refused);
  await store.fields(second.id, { recalls: 0, verdict: 'incorrect' }); await assert.rejects(store.read(), refused);
  await store.fields(second.id, { verdict: 'verified' });
  await writeFile(getHistoryPath(options.workspace, first.id), ''); await assert.rejects(store.history(first.id), refused);
});
