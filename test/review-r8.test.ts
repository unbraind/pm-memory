import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consolidate, exportDir, importDir, remember } from '../index.ts';
import { MemoryError } from '../src/core.ts';
import { testEnvironment } from '../scripts/environment.ts';
import { assertTestsPassed, snapshot, tracker } from './helpers.ts';

test('pending merge refusals identify the source, target and audited recovery field', async t => {
  const { options, store, workspace } = await tracker(t);
  const source = await remember('Repeated context for safe recovery', { ...options, kind: 'project', slug: 'source' });
  const target = await remember('Repeated context for safe recovery', { ...options, kind: 'project', slug: 'target', forceNew: true });
  for (const receipt of ['{', JSON.stringify({ target: target.slug }), 'null']) {
    await store.fields(source.id, { merge: receipt });
    const before = await snapshot(workspace);
    for (const apply of [false, true]) {
      await assert.rejects(consolidate({ ...options, apply }), (error: unknown) => {
        assert.ok(error instanceof MemoryError);
        assert.equal(error.code, 'conflict');
        assert.match(error.message, /source/);
        if (receipt.startsWith('{"')) assert.match(error.message, /source -> target/);
        assert.match(error.remedy, /memory_merge on source/);
        assert.match(error.remedy, /reconcile or clear.*audited pm update/);
        return true;
      });
      assert.deepEqual(await snapshot(workspace), before);
    }
  }
});

test('remember refuses index artifact slugs for both creation and explicit updates without writes', async t => {
  const { root, options, store, client } = await tracker(t);
  const input = join(root, 'input'); await mkdir(input);
  await writeFile(join(input, 'MEMORY.md'), '# Synthetic index\n');
  await importDir(input, { ...options, from: 'claude-code' });
  const artifact = (await store.read())[0];
  assert.equal(artifact.slug, 'memory'); assert.equal(artifact.artifact, true);
  for (const status of ['open', 'canceled']) {
    await client.update(artifact.id, { status, closeReason: 'Synthetic artifact lifecycle' });
    const before = await snapshot(options.workspace);
    for (const selector of [{ slug: 'memory' }, { update: 'memory' }, { slug: 'memory', update: 'memory', forceNew: true }]) {
      await assert.rejects(remember('Keep new guidance visible', { ...options, kind: 'project', ...selector }), (error: unknown) => {
        assert.ok(error instanceof MemoryError);
        assert.equal(error.code, 'conflict');
        assert.match(error.message, /memory.*index artifact/);
        assert.match(error.remedy, /different --slug/);
        return true;
      });
      assert.deepEqual(await snapshot(options.workspace), before);
    }
  }
  await client.update(artifact.id, { status: 'open' });
  const output = join(root, 'output');
  await exportDir(output, { ...options, to: 'claude-code' });
  assert.deepEqual(await snapshot(output), await snapshot(input));
});

test('child test assertions reject successful processes with zero matching tests', () => {
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^no-such-regression-test$', 'test/edges.test.ts'], {
    cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: testEnvironment(process.env),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.throws(() => assertTestsPassed(result, 'authored and tracker files'), assert.AssertionError);
  for (const prefix of ['#', 'ℹ']) {
    assert.throws(() => assertTestsPassed({ ...result, stdout: `authored and tracker files\n${prefix} pass 0\n` }, 'authored and tracker files'), assert.AssertionError);
  }
});
