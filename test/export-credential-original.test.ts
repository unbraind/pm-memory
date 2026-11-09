import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { remember, get, exportDir, MemoryError } from '../index.ts';
import { privacy, privacyRefusal } from '../src/core.ts';
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
    assert.ok(error.message.includes(`record ${result.id}, field document.original:`));
    return true;
  });
  await assert.rejects(access(output), { code: 'ENOENT' });
  assert.deepEqual(await snapshot(target.workspace), before);
});

/** Bodies that trigger each distinct privacy refusal mode, none of which may be echoed. */
function refusalModes(): [message: string, remedy: string, body: string][] {
  const secret = 'SyntheticOnly123!';
  let overlimit = JSON.stringify({ password: secret }); for (let depth = 0; depth < 5; depth++) overlimit = JSON.stringify(overlimit);
  return [
    ['Credential-shaped memory refused', 'Remove credentials and reference a secret manager instead', JSON.stringify({ password: secret })],
    ['Memory normalization limit exceeded', 'Replace repeatedly encoded content with plain text and secret-manager references', overlimit],
    ['Escaped credential declaration refused', 'Use plain text with an environment or secret-manager reference', 'note \\"password\\" = \\"abc\\qdefgh\\"'],
  ];
}

test('export refusals preserve each real privacy cause and remedy for the exact record and field', async t => {
  for (const [message, remedy, body] of refusalModes()) {
    const target = await tracker(t);
    const result = await remember('Safe current guidance', { ...target.options, kind: 'reference', slug: 'cause' });
    await target.client.update(result.id, { body });
    assert.equal((await get(result.slug, target.options)).body, body);
    const before = await snapshot(target.workspace); const output = join(target.root, 'export');
    await assert.rejects(exportDir(output, { ...target.options, to: 'agents-md' }), error => {
      assert.ok(error instanceof MemoryError && error.code === 'privacy', message);
      assert.equal(error.message, `Export refused for record ${result.id}, field body: ${message}`);
      assert.equal(error.remedy, remedy);
      assert.ok(!JSON.stringify({ message: error.message, remedy: error.remedy }).includes(body), 'Refusal must not echo the refused content');
      return true;
    });
    await assert.rejects(access(output), { code: 'ENOENT' });
    assert.deepEqual(await snapshot(target.workspace), before);
  }
});

test('the privacy refusal wrapper preserves every domain cause and rethrows all other failures', () => {
  for (const [, , body] of refusalModes()) {
    let thrown: unknown;
    assert.throws(() => privacy(body, true), error => { thrown = error; return error instanceof MemoryError && error.code === 'privacy'; });
    assert.ok(privacyRefusal(thrown) === thrown, 'A privacy refusal must pass through with its real cause and remedy');
  }
  for (const failure of [new Error('Ordinary defect'), new TypeError('Typed defect'), 'string failure', 7, null, new AggregateError([new Error('Nested defect')], 'Aggregate defect'), new MemoryError('schema', 'Another domain refusal', 'Its own remedy')]) {
    assert.throws(() => privacyRefusal(failure), thrown => thrown === failure, 'Non-privacy failures must surface as themselves');
  }
});
