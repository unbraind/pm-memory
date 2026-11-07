import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { remember, get, exportDir, MemoryError } from '../index.ts';
import { tracker, snapshot } from './helpers.ts';

test('export refuses encoded legacy originals even when the current body is safe', async t => {
  const target = await tracker(t);
  const result = await remember('Safe current guidance', { ...target.options, kind: 'reference', slug: 'legacy-original' });
  const secret = 'SyntheticOnly123!';
  const original = Buffer.from(JSON.stringify({ password: secret })).toString('base64');
  const patch = { body: 'Safe current guidance', memoryDocument: JSON.stringify({ version: 1, format: 'legacy', harness: 'agents-md', path: 'legacy.md', original }) };
  await target.client.update(result.id, patch);
  assert.equal((await get(result.slug, target.options)).body, 'Safe current guidance');
  const before = await snapshot(target.workspace); const output = join(target.root, 'export');
  await assert.rejects(exportDir(output, { ...target.options, to: 'agents-md' }), error => {
    assert.ok(error instanceof MemoryError && error.code === 'privacy');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  await assert.rejects(access(output), { code: 'ENOENT' });
  assert.deepEqual(await snapshot(target.workspace), before);
});
