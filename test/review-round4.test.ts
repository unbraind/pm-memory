import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { exportDir, importDir, LEGACY_ORIGINS, MemoryError, POLICY_MANIFEST, remember } from '../index.ts';
import { privacy } from '../src/core.ts';
import { installExtension, snapshot, tracker, withoutGit } from './helpers.ts';
import { nativeHost } from './native-host-helpers.ts';

const literal = 'SyntheticOnly123!';
const remedy = 'Remove credentials and reference a secret manager instead';
const runtimePath = process.env.PATH;

for (const [path, displayed] of [
  ['guides/password=' + literal + '.md', 'guides/[redacted]'],
  ['password=' + literal + '/guide.md', '[redacted]/guide.md'],
  ['guides/' + encodeURIComponent('password=' + literal) + '.md', 'guides/[redacted]'],
  ['guides/password=Synt/heticOnly123!.md', '[redacted]'],
  ['guides/public.md', 'guides/public.md'],
]) test(`import diagnostic path case ${displayed} preserves safe context in SDK and CLI refusals`, async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  await target.store.register(); await installExtension(target.workspace);
  const input = join(target.root, 'input'); const file = join(input, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'Public note\n' + JSON.stringify({ password: literal }));
  const before = await snapshot(target.workspace);
  await nativeHost(target.workspace, async client => {
    await assert.rejects(importDir(input, { ...target.options, client, from: 'agents-md' }), error => {
      assert.ok(error instanceof MemoryError && error.code === 'privacy');
      assert.equal(error.message, `Import refused: ${displayed}:multiline (Credential-shaped memory refused)`);
      assert.equal(error.remedy, remedy); assert.equal(String(error).includes(literal), false); return true;
    });
  });
  for (const flags of [[], ['--json']]) {
    const result = spawnSync(process.execPath, [resolve('node_modules/.bin/pm'), 'memory', 'import', input, '--from', 'agents-md', ...flags], {
      cwd: target.root, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, HOME: target.root, PM_PATH: target.workspace, PM_AUTHOR: 'memory-test', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 4, output); assert.equal(output.includes(literal), false);
    if (path !== displayed) assert.equal(output.includes(path), false);
    assert.ok(output.includes(displayed)); assert.ok(output.includes(remedy));
    if (flags.length > 0) assert.equal(JSON.parse(output).code, 'privacy');
  }
  assert.deepEqual(await snapshot(target.workspace), before);
  if (path === 'guides/public.md') {
    await writeFile(file, 'password=${BUILD_PASSWORD}');
    await nativeHost(target.workspace, async client => {
      assert.equal((await importDir(input, { ...target.options, client, from: 'agents-md' })).imported, 1);
    });
  }
});

test('retained artifact originals refuse secrets before publication while clean exports remain byte-identical', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const source = join(target.root, 'source'); await mkdir(source);
  const index = '- [Alpha](alpha.md)\r\n';
  await writeFile(join(source, 'MEMORY.md'), index); await writeFile(join(source, 'alpha.md'), 'Public guidance\r\n');
  await importDir(source, { ...target.options, from: 'claude-code' });
  const first = join(target.root, 'first'); const second = join(target.root, 'second');
  await exportDir(first, { ...target.options, to: 'claude-code' });
  await exportDir(second, { ...target.options, to: 'claude-code' });
  assert.ok((await readdir(first)).includes(LEGACY_ORIGINS));
  for (const name of await readdir(first)) assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)));
  assert.equal(await readFile(join(first, 'MEMORY.md'), 'utf8'), index);
  assert.deepEqual(await readFile(join(first, 'alpha.md')), await readFile(join(source, 'alpha.md')));
  const artifact = (await target.store.read()).find(item => item.artifact)!; assert.ok(artifact.document);
  const patch = { body: artifact.body, memoryDocument: JSON.stringify({ ...artifact.document, format: 'policy', original: Buffer.from(JSON.stringify({ password: literal })).toString('base64') }) };
  await target.client.update(artifact.id, patch);
  const before = await snapshot(target.workspace); const output = join(target.root, 'uncreated', 'refused');
  await assert.rejects(exportDir(output, { ...target.options, to: 'claude-code' }), error => {
    assert.ok(error instanceof MemoryError && error.code === 'privacy');
    assert.ok(error.message.includes(`record ${artifact.id}, field document.original:`));
    assert.equal(error.message.includes(literal), false); assert.equal(error.remedy, remedy); return true;
  });
  await assert.rejects(access(dirname(output)), { code: 'ENOENT' });
  assert.deepEqual(await snapshot(target.workspace), before);
  const fact = (await target.store.read()).find(item => !item.artifact)!;
  await target.client.update(fact.id, { body: 'Native body edit selects policy output' });
  const fallback = join(target.root, 'fallback'); await exportDir(fallback, { ...target.options, to: 'claude-code' });
  assert.ok((await readdir(fallback)).includes(POLICY_MANIFEST));
  assert.equal((await readFile(join(fallback, POLICY_MANIFEST), 'utf8')).includes(Buffer.from(JSON.stringify({ password: literal })).toString('base64')), false);
  await remember('Native guidance selects policy output', { ...target.options, kind: 'reference', slug: 'native' });
  const policy = join(target.root, 'policy'); await exportDir(policy, { ...target.options, to: 'claude-code' });
  assert.ok((await readdir(policy)).includes(POLICY_MANIFEST));
  const manifest = await readFile(join(policy, POLICY_MANIFEST), 'utf8');
  assert.equal(manifest.includes(literal), false);
  assert.equal(manifest.includes(Buffer.from(JSON.stringify({ password: literal })).toString('base64')), false);
});

test('reference terminators inspect 100000 spaces within a bounded process deadline', async () => {
  for (const tail of ['', '}', ',', ']', ':', 'x']) {
    const value = 'password=${X}"' + ' '.repeat(100000) + tail;
    const result = spawnSync(process.execPath, [resolve('test/privacy-process.ts')], { input: value, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    const elapsed = Number(result.stdout.trim().split('\n').at(-1));
    assert.ok(elapsed < 750, `100000-space scan took ${elapsed}ms`);
  }
  const start = performance.now();
  privacy(JSON.stringify({ note: 'password=${X}' }));
  assert.throws(() => privacy('password=${X}"' + ' '.repeat(100000) + literal + '"'), error => error instanceof MemoryError && error.code === 'privacy');
  assert.ok(performance.now() - start < 750);
});

test('published documentation includes credential policy and preserves the existing public files', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { files: string[]; pm: { docs: string[] } };
  assert.ok(manifest.pm.docs.includes('docs/sdk-adoption.md'));
  const safe = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|PASSWORD|SECRET|KEY|AUTH|CREDENTIAL|PAT(?:_|$)/i.test(key) && key !== 'NPM_MEDIA_SERVER'));
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', timeout: 60000, env: { ...safe, PATH: runtimePath, NPM_CONFIG_USERCONFIG: devNull } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout) as { files: { path: string; size: number }[] }[];
  for (const path of ['docs/sdk-adoption.md', 'README.md', 'ARCHITECTURE.md', 'manifest.json', 'dist/index.js']) {
    const file = packed[0].files.find(file => file.path === path); assert.ok(file, path);
    assert.equal(file.size, (await readFile(path)).length);
  }
  assert.ok(packed[0].files.every(file => !file.path.startsWith('.agents/') && !file.path.startsWith('test/')));
});
