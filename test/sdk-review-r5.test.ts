import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';
import { remember, get, MemoryError } from '../index.ts';
import { privacy } from '../src/core.ts';
import { tracker, snapshot } from './helpers.ts';

test('nested object credentials retain their enclosing credential key', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const literal = 'SyntheticOnly123!';
  for (const fact of [{ password: { value: literal } }, { password: { inner: [{ value: literal }] } }, { password: { _authToken: 'x' } }]) {
    await assert.rejects(remember(JSON.stringify(fact), { ...target.options, kind: 'reference' }), { code: 'privacy', message: 'Credential-shaped memory refused' });
    assert.deepEqual(await snapshot(target.workspace), before);
  }
  const safe = JSON.stringify({ password: { value: '${BUILD_PASSWORD}' }, api_key: { value: '<secret-manager-reference>' } });
  const saved = await remember(safe, { ...target.options, kind: 'reference' });
  assert.equal((await get(saved.slug, target.options)).body, safe);
});

test('public SDK finding policy preserves reviewed identity exclusions and credentials', async t => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string> };
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string }> };
  const reviewed = lock.packages['node_modules/@unbrained/pm-cli'].version;
  assert.equal(manifest.peerDependencies['@unbrained/pm-cli'], reviewed, 'Supported SDK must match the reviewed detector inventory');
  assert.equal(manifest.devDependencies['@unbrained/pm-cli'], reviewed);
  const target = await tracker(t);
  const ip = [192, 168, 50, 60].join('.');
  const identity = '/' + ['home', 'fixture', 'guide'].join('/') + '\nssh fixture@' + ip;
  assert.deepEqual([...new Set(scanMutationSecrets(identity).map(row => row.rule))].sort(), ['absolute_home_path', 'private_ip', 'private_ssh_target', 'user_at_private_host'].sort());
  privacy(identity);
  const saved = await remember(identity, { ...target.options, kind: 'reference' });
  assert.equal((await get(saved.slug, target.options)).body, identity);
  const before = await snapshot(target.workspace); const credential = 'npm_' + 'A'.repeat(30);
  assert.ok(scanMutationSecrets(credential).some(row => row.rule === 'npm_token'));
  await assert.rejects(remember(credential, { ...target.options, kind: 'reference' }), error => error instanceof MemoryError && error.code === 'privacy' && !error.message.includes(credential));
  assert.deepEqual(await snapshot(target.workspace), before);
});
