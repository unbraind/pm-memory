import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';
import { remember, get, MemoryError } from '../index.ts';
import { tracker, snapshot } from './helpers.ts';

test('environment references retain adjacent literal credential context', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const literal = 'SyntheticOnly123!';
  for (const name of ['password', 'passphrase', '_authToken', 'api_key', 'token']) {
    for (const value of [name + '=${X}' + literal, name + '="${X}' + literal + '"']) {
      await assert.rejects(remember(value, { ...target.options, kind: 'reference' }), error => error instanceof MemoryError && error.code === 'privacy' && !error.message.includes(literal));
      assert.deepEqual(await snapshot(target.workspace), before);
    }
  }
  for (const [index, value] of ['password=${X}', 'passphrase=${BUILD_PHRASE}', 'auth_token=${BUILD_TOKEN}(provided by the environment)', 'password="${X}"; use a secret manager'].entries()) {
    const result = await remember(value, { ...target.options, kind: 'reference', slug: 'reference-' + index, forceNew: true });
    assert.equal((await get(result.slug, target.options)).body, value);
  }
});

test('SDK assignment and quoted SSH context survive long whitespace', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  for (const whitespace of [' '.repeat(400), '\t'.repeat(400), '\n'.repeat(400)]) {
    for (const value of ['passphrase=' + whitespace + 'SyntheticOnly123!', 'sshpass' + whitespace + '-p' + whitespace + '"SyntheticOnly123!"']) {
      assert.ok(scanMutationSecrets(value).length > 0);
      await assert.rejects(remember(value, { ...target.options, kind: 'reference' }), error => error instanceof MemoryError && error.code === 'privacy');
      assert.deepEqual(await snapshot(target.workspace), before);
    }
  }
  const safe = 'passphrase=' + ' '.repeat(400) + '${BUILD_PHRASE}';
  const result = await remember(safe, { ...target.options, kind: 'reference' });
  assert.equal((await get(result.slug, target.options)).body, safe);
});
