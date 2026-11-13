import assert from 'node:assert/strict';
import fs, { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { getItemPath, readSettings, resolveItemTypeRegistry } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, MemoryError, remember } from '../index.ts';
import { aggregatePrivacy, aggregateSize, digest, privacy } from '../src/core.ts';
import { runCommand } from '../src/commands.ts';
import { importPolicy, POLICY_MANIFEST } from '../src/portable.ts';
import { snapshot, tracker } from './helpers.ts';

/** Capture only stable policy outcomes, never exception stacks or supplied values. */
function verdict(value: string): string {
  try { privacy(value, true); return 'allow'; }
  catch (error) { assert.ok(error instanceof MemoryError); return error.code + ':' + error.message; }
}

/** Exercise the prior corpus spellings plus deterministic malformed quote and escape combinations. */
function quotedCorpus(): string[] {
  const values = ['', 'ab', 'SyntheticOnly123!', '${BUILD_PASSWORD}', '<secret-manager-reference>', "aa''bb''cccc", 'abc\\', 'ab"cdefghi', 'abc\\qdefgh'];
  const corpus: string[] = [];
  for (const name of ['password', 'api_key', '_authToken', 'db-password', 'note']) for (const value of values) {
    const json = JSON.stringify({ [name]: value });
    corpus.push(json, JSON.stringify(json), 'He is 5" tall. ' + JSON.stringify({ note: json }), '"' + name + '": ' + JSON.stringify(value), "'" + name + "': '" + value + "'", '"' + name + '": ' + JSON.stringify(value).slice(0, -1));
  }
  for (let seed = 0; seed < 512; seed++) {
    let bits = seed; let value = '';
    for (let at = 0; at < 9; at++, bits >>>= 1) value += (bits & 1) === 0 ? "'" : '\\';
    for (const quote of ['"', "'"]) corpus.push(quote + 'password' + quote + ': ' + quote + value, quote + 'password' + quote + ': ' + quote + value + '\n');
  }
  return corpus;
}

test('quoted scanner preserves the prior matcher corpus', () => {
  const corpus = quotedCorpus();
  assert.equal(corpus.length, 2318);
  // Verdict digest captured from bb8fcd3 before replacing the quoted-value matchers.
  assert.equal(digest(JSON.stringify(corpus.map(verdict))), 'b3cdcaf3dcd9a91eaa2e19fcd05635bb94aee726a98b0a20b8511e83b1d30bd1');
});

test('100k escaped-quote inputs complete without backtracking quote matchers', t => {
  // Reject the unsafe algorithm before running it: this guard has no wall-clock threshold.
  const original = RegExp.prototype.exec; let unsafeCalls = 0;
  const hook = t.mock.method(RegExp.prototype, 'exec', function (this: RegExp, value: string) {
    if (value.length >= 100000 && (this.source.includes('\\\\.|[^"\\\\]') || this.source.includes("\\\\.|[^'\\\\]"))) { unsafeCalls++; throw new Error('Escaped quote spans must use linear scanning'); }
    return original.call(this, value);
  });
  try {
    const adversary = '"' + '\\"'.repeat(50000);
    privacy(adversary);
    privacy('"password": "x"; note: ' + adversary);
    privacy('"password": "x"; note: ' + adversary + '"');
    privacy("'password': 'x'; note: '" + "\\'".repeat(50000));
  } finally { hook.mock.restore(); }
  assert.equal(unsafeCalls, 0, 'Escaped quote spans must use linear scanning');
});

test('aggregate inventories have an independent limit and actionable remedy before writes', async t => {
  aggregateSize(16 * 1024 * 1024);
  aggregatePrivacy('Public prose. '.repeat(90000));
  assert.throws(() => aggregatePrivacy('eyJ-'.repeat(50000)), error => error instanceof MemoryError && /aggregate scan work/.test(error.message) && /Split.*simplify/.test(error.remedy));
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 'a');
  /** Require the aggregate remedy instead of the individual-value remedy. */
  const refused = (error: unknown): boolean => {
    assert.ok(error instanceof MemoryError && error.code === 'privacy');
    assert.equal(error.message, 'Memory aggregate size limit exceeded');
    assert.match(error.remedy, /Split.*16 MiB/); return true;
  };
  assert.throws(() => aggregateSize(oversized.length), refused);
  assert.throws(() => aggregatePrivacy(oversized.toString()), refused);
  await assert.rejects(importPolicy([{ path: POLICY_MANIFEST, bytes: oversized }], { ...target.options, from: 'agents-md' }), refused);
  const input = join(target.root, 'batch'); await mkdir(input);
  for (let at = 0; at < 17; at++) await writeFile(join(input, at + '.md'), Buffer.alloc(1024 * 1024, 'a'));
  await assert.rejects(importDir(input, { ...target.options, from: 'agents-md' }), refused);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('220 benign 4 KiB sources round trip through both harnesses', async t => {
  const target = await tracker(t); const input = join(target.root, 'input'); await mkdir(input);
  const body = 'Public guidance. '.repeat(256).slice(0, 4096);
  assert.equal(Buffer.byteLength(body), 4096);
  for (let at = 0; at < 220; at++) await writeFile(join(input, 'guide-' + at + '.md'), body);
  assert.equal((await importDir(input, { ...target.options, from: 'agents-md' })).imported, 220);
  for (const to of ['agents-md', 'claude-code'] as const) {
    const output = join(target.root, to); await exportDir(output, { ...target.options, to });
    const companion = POLICY_MANIFEST;
    assert.ok((await readFile(join(output, companion))).length > 1024 * 1024);
    const restored = await tracker(t);
    assert.equal((await importDir(output, { ...restored.options, from: to })).imported, 220);
    const items = (await restored.client.listAllComplete({ includeBody: true })).items;
    assert.equal(items.filter(item => item.body === body).length, 220);
  }
});

test('whole-source refusals preserve size and identifier remedies with safe locations', async t => {
  const target = await tracker(t); const input = join(target.root, 'input'); await mkdir(input);
  const before = await snapshot(target.workspace);
  for (const value of ['a'.repeat(1024 * 1024 + 1), 'eyJ-'.repeat(50000)]) {
    await writeFile(join(input, 'guide.md'), value);
    await assert.rejects(importDir(input, { ...target.options, from: 'agents-md' }), error => {
      assert.ok(error instanceof MemoryError && error.code === 'privacy');
      assert.match(error.message, /guide.md:line 1/);
      assert.match(error.remedy, /1 MiB per inspected value.*simplify/);
      assert.doesNotMatch(error.remedy, /Remove credentials/); return true;
    });
    assert.deepEqual(await snapshot(target.workspace), before);
  }
});

test('mixed source refusals retain every applicable safe remedy', async t => {
  const target = await tracker(t); const input = join(target.root, 'mixed'); await mkdir(input);
  const before = await snapshot(target.workspace);
  await writeFile(join(input, 'large.md'), 'a'.repeat(1024 * 1024 + 1));
  await writeFile(join(input, 'address.md'), 'Contact person@example.test');
  await writeFile(join(input, 'credential.md'), 'password=SyntheticOnly123!');
  await assert.rejects(importDir(input, { ...target.options, from: 'agents-md' }), error => {
    assert.ok(error instanceof MemoryError && error.code === 'privacy');
    for (const name of ['large', 'address', 'credential']) assert.ok(error.message.includes(name + '.md:line 1'));
    assert.match(error.remedy, /1 MiB/); assert.match(error.remedy, /--allow-email/); assert.match(error.remedy, /secret manager/);
    assert.doesNotMatch(error.message + error.remedy, /SyntheticOnly123!|person@example.test/); return true;
  });
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('operational CLI failures retain their cause while privacy refusals have none', async t => {
  const target = await tracker(t);
  const ctx = { command: 'memory import', pm_root: target.workspace, args: [join(target.root, 'missing')], options: { from: 'agents-md' }, global: {} } as CommandHandlerContext;
  await assert.rejects(runCommand('import', ctx), error => {
    assert.ok(error instanceof Error && error.cause instanceof Error);
    assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT');
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'cause'), false); return true;
  });
  await assert.rejects(runCommand('remember', { ...ctx, args: ['password=SyntheticOnly123!'], options: { kind: 'reference' } }), error => {
    assert.ok(error instanceof Error); assert.equal(error.cause, undefined); return true;
  });
});

for (const code of ['deleted', 'ENOENT', 'EACCES']) test(`revision capture handles ${code} without masking reader failures`, async t => {
  const target = await tracker(t); const input = join(target.root, 'input');
  for (const slug of ['alpha', 'bravo']) await remember('Public ' + slug, { ...target.options, kind: 'reference', slug, forceNew: true });
  await exportDir(input, { ...target.options, to: 'agents-md' });
  const items = (await target.client.listAllComplete()).items;
  const alpha = items.find(item => item.memory_slug === 'alpha')!;
  const settings = await readSettings(target.workspace);
  const path = getItemPath(target.workspace, 'Knowledge', alpha.id, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
  const manifest = JSON.parse(await readFile(join(input, POLICY_MANIFEST), 'utf8')) as { guidance: { slug: string; path: string }[] };
  for (const row of manifest.guidance) {
    const file = join(input, row.path);
    await writeFile(file, (await readFile(file, 'utf8')).replaceAll('Public ' + row.slug, 'Revised ' + row.slug));
  }
  const original = fs.readFile; let armed = false; let fired = false;
  const failure = Object.assign(new Error('Synthetic revision read failure'), { code: code === 'deleted' ? 'ENOENT' : code });
  const hook = t.mock.method(fs, 'readFile', (async (...args: Parameters<typeof original>) => {
    if (armed && !fired && String(args[0]) === path) {
      fired = true; if (code === 'deleted') await rm(path);
      throw failure;
    }
    return original(...args);
  }) as typeof original);
  syncBuiltinESMExports();
  const run = () => importDir(input, { ...target.options, from: 'agents-md' as const, onStep: step => { if (step === 'item-read') armed = true; } });
  try {
    if (code !== 'deleted') await assert.rejects(run(), error => error === failure || error instanceof Error && error.cause === failure);
    else {
      const result = await run(); assert.ok('skipped' in result);
      assert.ok(result.skipped.some(row => row.conflict?.item === alpha.id));
      assert.ok((await target.client.listAllComplete({ includeBody: true })).items.some(item => item.memory_slug === 'bravo' && item.body === 'Revised bravo'));
      await assert.rejects(access(path), { code: 'ENOENT' });
    }
    assert.ok(fired);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test('aggregate companions retain per-value decoded metadata limits before writes', async t => {
  const target = await tracker(t);
  await remember('Public metadata control', { ...target.options, kind: 'reference', slug: 'alpha' });
  const directory = join(target.root, 'policy'); await exportDir(directory, { ...target.options, to: 'agents-md' });
  const file = join(directory, POLICY_MANIFEST);
  const value = JSON.parse(await readFile(file, 'utf8')) as { guidance: { title: string }[] };
  value.guidance[0].title = 'a'.repeat(1024 * 1024 + 1); await writeFile(file, JSON.stringify(value));
  const before = await snapshot(target.workspace);
  await assert.rejects(importDir(directory, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && /privacy scan size limit/.test(error.message) && /1 MiB/.test(error.remedy));
  assert.deepEqual(await snapshot(target.workspace), before);
});
