import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remember, exportDir, index, recall } from '../index.ts';
import { MemoryError, pack, privacy, words } from '../src/core.ts';
import { contradicts, proposals } from '../src/consolidate.ts';
import { checkClaim } from '../src/verify.ts';
import { metadata } from '../src/store.ts';
import { indexOrder, rank } from '../src/memory.ts';
import { gitEnvironment } from '../scripts/environment.ts';
import { tracker } from './helpers.ts';

test('privacy variable references and token assignment forms remain discriminated', () => {
  assert.deepEqual([...words('Feedback: CodeRabbit, stable.')], ['feedback', 'coderabbit', 'stable']);
  privacy('token=$SOME_VARIABLE(suffix)'); privacy('token=${SOME_VARIABLE}'); privacy('token: accounting');
  assert.throws(() => privacy('token=lowercaseword'), MemoryError);
  assert.throws(() => privacy('token: fake_00000000'), MemoryError);
  assert.throws(() => privacy('password: lowercaseword'), MemoryError);
  assert.throws(() => privacy('token: abcdefghijklmnopqrstuvwxyz'), MemoryError);
  assert.throws(() => pack([], 1, (_selected, omitted) => ({ omitted, complete: true })), MemoryError);
});

test('sparse SDK Knowledge metadata uses documented defaults without active extension registrations', async t => {
  const { options, store, client } = await tracker(t); await store.register();
  await client.run('create', { options: { title: 'Sparse default memory', type: 'Knowledge', ...metadata({ slug: 'sparse', kind: 'reference' }) } });
  const memories = await store.read(); assert.equal(memories[0].recalls, 0); assert.equal(memories[0].verdict, 'unknown');
  assert.equal(memories[0].source, 'native:item'); assert.equal(memories[0].why, ''); assert.equal(memories[0].how, '');
  assert.ok((await recall('unmatched', options)).memories!.length > 0);
  await remember('Second feedback guidance', { ...options, kind: 'feedback', slug: 'feedback' });
  await remember('Third user preference', { ...options, kind: 'user', slug: 'user' });
  const rows = await store.read();
  const same = { ...rows[0], kind: 'project' as const, pinned: false, updated: '2020-01-01T00:00:00.000Z' };
  const older = { ...same, slug: 'one', title: 'Equal policy', body: 'disable' };
  const newer = { ...same, slug: 'two', title: 'Equal policy', body: 'enable' };
  assert.equal(contradicts(older, newer), true); assert.equal(contradicts(newer, older), true);
  assert.equal(proposals([older, newer])[0].target, 'two');
  assert.equal(rank([newer, older], 'no-match')[0].slug, 'one');
  assert.ok(indexOrder(older, newer) < 0);
  assert.ok(indexOrder({ ...older, pinned: true }, newer) < 0);
  assert.ok(indexOrder({ ...older, kind: 'feedback' }, newer) < 0);
  assert.ok(indexOrder({ ...older, updated: '2021-01-01T00:00:00.000Z' }, newer) < 0);
  assert.ok((await index(options)).text!.includes('feedback'));
});

test('index tie breaking handles equal kinds and timestamp ordering through native writes', async t => {
  const { options } = await tracker(t);
  await remember('Repeated kind first', { ...options, kind: 'user', slug: 'first' });
  await remember('Repeated kind second', { ...options, kind: 'user', slug: 'second' });
  const output = await index(options); assert.ok(output.text!.indexOf('(second)') < output.text!.indexOf('(first)'));
});

test('export detects path collisions for original artifacts and generated memories', async t => {
  const { root, options, store } = await tracker(t);
  const first = await remember('First collision fixture', { ...options, kind: 'reference', slug: 'native' });
  const second = await remember('Second collision fixture', { ...options, kind: 'reference', slug: 'source' });
  await store.fields(first.id, { original: Buffer.from('First collision fixture').toString('base64'), source: 'claude-code:relative-file', path: 'collision.md', edited: false });
  await store.fields(second.id, { original: Buffer.from('Second collision fixture').toString('base64'), source: 'claude-code:relative-file', path: 'collision.md', edited: false });
  await assert.rejects(exportDir(join(root, 'collision'), { ...options, to: 'claude-code' }), /collide/);
  const ordered = await store.read();
  await store.fields(ordered[0].id, { path: `${ordered[1].slug}.md` });
  await store.fields(ordered[1].id, { edited: true });
  await assert.rejects(exportDir(join(root, 'generated-collision'), { ...options, to: 'claude-code' }), /collide/);
  await store.fields(ordered[0].id, { edited: true });
  await store.fields(ordered[1].id, { edited: false, path: `${ordered[0].slug}.md` });
  await assert.rejects(exportDir(join(root, 'reverse-collision'), { ...options, to: 'claude-code' }), /collide/);
});

test('filesystem permission and symlink loop failures produce safe typed evidence refusals', async t => {
  const { root, options } = await tracker(t);
  await symlink('loop.ts', join(root, 'loop.ts'));
  await assert.rejects(checkClaim({ type: 'file', value: 'loop.ts' }, root, false), /could not be read/);
  await remember('Export permission fixture', { ...options, kind: 'project', slug: 'permission' });
  const output = join(root, 'readonly'); await mkdir(output); await chmod(output, 0o500);
  try { await assert.rejects(exportDir(output, { ...options, to: 'agents-md' })); } finally { await chmod(output, 0o700); }
});

/** Author-controlled files must never embed this run's scratch locations or private home paths. */
test('authored and tracker files contain no absolute temporary or private home paths', async () => {
  const repository = join(import.meta.dirname, '..');
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repository, encoding: 'utf8', env: gitEnvironment(process.env) }).split('\0').filter(Boolean);
  const forbidden = new RegExp(`(?<![\\w.])(?:${['tmp', 'home', 'Users'].map(name => `[/]${name}[/]`).join('|')})`);
  for (const file of files) {
    const content = await readFile(join(repository, file), 'utf8');
    assert.equal(forbidden.test(content), false, `Private absolute path in ${file}`);
  }
});

/** Opposite frequency words require matching guidance, and negation can reverse toggle polarity. */
test('consolidation respects equivalent negations and refuses ambiguous opposite-word mixtures', async t => {
  const { options, store } = await tracker(t);
  await remember('Policy fixture', { ...options, kind: 'project', slug: 'policy' });
  const base = (await store.read())[0];
  for (const [yes, no] of [['enable', 'disable'], ['required', 'forbidden'], ['always', 'never']]) {
    for (let mask = 0; mask < 16; mask++) {
      const a = Boolean(mask & 1), b = Boolean(mask & 2), c = Boolean(mask & 4), d = Boolean(mask & 8);
      const left = { ...base, body: [a ? yes : '', b ? no : '', 'tests'].join(' ') };
      const right = { ...base, body: [c ? yes : '', d ? no : '', 'tests'].join(' ') };
      assert.equal(contradicts(left, right), (a && !b && d && !c) || (b && !a && c && !d));
    }
  }
  for (const [left, right, expected] of [
    ['Always enable the feature', 'Never disable the feature', false],
    ['Do not enable the feature', 'Enable the feature', true],
    ['Must not disable the feature', 'Disable the feature', true],
    ['Not required for tests', 'Forbidden for tests', false],
    ['Always run tests', 'Never skip tests', false],
    ['Always run tests', 'Never run tests', true],
  ] as const) assert.equal(contradicts({ ...base, body: left }, { ...base, body: right }), expected);
});
