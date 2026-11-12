import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportDir, get, importDir, MemoryError, POLICY_MANIFEST, remember } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { snapshot, tracker } from './helpers.ts';

test('a body at the admission byte limit exports and imports with verified policy framing', async t => {
  const target = await tracker(t); const prefix = 'Public boundary guidance\n';
  const body = prefix + 'a'.repeat(1024 * 1024 - Buffer.byteLength(prefix));
  assert.equal(Buffer.byteLength(body), 1024 * 1024);
  await remember(body, { ...target.options, kind: 'reference', slug: 'boundary' });
  for (const to of ['agents-md', 'claude-code'] as const) {
    const directory = join(target.root, to); await exportDir(directory, { ...target.options, to });
    const manifest = JSON.parse(await readFile(join(directory, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    const row = manifest.guidance[0]; const bytes = await readFile(join(directory, row.path));
    assert.ok(bytes.length > 1024 * 1024, 'Only verified policy framing exceeds the payload limit');
    const fresh = await tracker(t);
    assert.equal((await importDir(directory, { ...fresh.options, from: to })).imported, 1);
    assert.equal((await get('boundary', fresh.options)).body, body);
    const before = await snapshot(fresh.workspace);
    await writeFile(join(directory, row.path), policyBody(row, body + 'a'));
    await assert.rejects(importDir(directory, { ...fresh.options, from: to }), error => error instanceof MemoryError && error.code === 'privacy' && /1 MiB/.test(error.remedy));
    assert.deepEqual(await snapshot(fresh.workspace), before);
    for (const corrupt of [Buffer.from('Foreign framing\n' + body), Buffer.concat([policyBody(row, ''), Buffer.from([255])])]) {
      await writeFile(join(directory, row.path), corrupt);
      await assert.rejects(importDir(directory, { ...fresh.options, from: to }), error => error instanceof MemoryError && error.code === 'validity' && error.message === 'Invalid or expanded portable policy window');
      assert.deepEqual(await snapshot(fresh.workspace), before);
    }
  }
  const before = await snapshot(target.workspace);
  await assert.rejects(remember(body + 'a', { ...target.options, kind: 'reference', slug: 'oversized' }), error => error instanceof MemoryError && error.code === 'privacy');
  assert.deepEqual(await snapshot(target.workspace), before);
});
