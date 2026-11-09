import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remember, get, importDir, exportDir, MemoryError } from '../index.ts';
import { tracker, snapshot } from './helpers.ts';
import { privacy } from '../src/core.ts';
import { itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';

const secret = 'SyntheticOnly123!';
const reference = '${BUILD_PASSWORD}';
/** Keep both the diagnostic and remediation free of credential content. */
function credentialRefusal(error: unknown): boolean {
  assert.ok(error instanceof MemoryError && error.code === 'privacy');
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(error.message.includes(secret), false);
  return true;
}

test('duplicate credential members retain every scalar and nested value before persistence', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const declarations = [
    '"password":"' + secret + '","password":"x"',
    '"password":"' + secret + '","password":"' + reference + '"',
    '"password":{"value":"' + secret + '"},"password":null',
    '"password":[{"value":"' + secret + '"}],"password":false',
    '"password":{"value":"' + secret + '","value":"x"}',
    '"password":12345678,"password":1',
    '"password":"' + secret + '","pass\\u0077ord":"x"',
    '"__proto__":{"password":"' + secret + '"},"__proto__":{}',
  ];
  for (const declaration of declarations) {
    const fact = '{' + declaration + '}';
    for (const wrapped of [fact, JSON.stringify({ note: fact })]) {
      await assert.rejects(remember(wrapped, { ...target.options, kind: 'reference' }), credentialRefusal);
      assert.deepEqual(await snapshot(target.workspace), before);
    }
  }
  for (const fact of ['{"password":"ab","password":"' + reference + '"}', '{"password":{"value":"x","value":"<secret-manager-reference>"}}', '{"password":1,"password":null}', '{"note":"ordinary: descriptive text","password":"x"}']) {
    privacy(fact);
  }
});

test('stray prose quotes cannot hide escaped credential declarations or break references', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  for (const prefix of ['He is 5" tall. ', 'A "stray quote. ', 'A "bad\\q" quote. ']) {
    for (const name of ['password', 'api_key', '_authToken']) {
      const fact = prefix + JSON.stringify({ note: JSON.stringify({ [name]: secret }) });
      await assert.rejects(remember(fact, { ...target.options, kind: 'reference' }), credentialRefusal);
      assert.deepEqual(await snapshot(target.workspace), before);
    }
  }
  for (const literal of [reference, '<secret-manager-reference>']) {
    const fact = 'He is 5" tall. ' + JSON.stringify({ note: JSON.stringify({ password: literal }) });
    const result = await remember(fact, { ...target.options, kind: 'reference', forceNew: true });
    assert.equal((await get(result.slug, target.options)).body, fact);
  }
});

test('duplicate and stray-quote credentials refuse imports and legacy exports before side effects', async t => {
  const target = await tracker(t); const input = join(target.root, 'input'); await mkdir(input);
  const facts = ['{"password":"' + secret + '","password":"x"}', 'He is 5" tall. ' + JSON.stringify({ note: JSON.stringify({ password: secret }) })];
  const before = await snapshot(target.workspace);
  for (const fact of facts) {
    await writeFile(join(input, 'guide.md'), fact);
    await assert.rejects(importDir(input, { ...target.options, from: 'agents-md' }), credentialRefusal);
    assert.deepEqual(await snapshot(target.workspace), before);
  }
  const saved = await remember('Safe legacy content', { ...target.options, kind: 'reference' });
  for (const fact of facts) {
    await target.client.update(saved.id, { body: fact });
    assert.equal((await get(saved.slug, target.options)).body, fact);
    const retained = await snapshot(target.workspace); const output = join(target.root, 'output');
    await assert.rejects(exportDir(output, { ...target.options, to: 'agents-md' }), credentialRefusal);
    assert.deepEqual(await snapshot(target.workspace), retained);
    await assert.rejects(access(output), { code: 'ENOENT' });
  }
});

test('export privacy refusals identify safe native record and field without disclosing values', async t => {
  const target = await tracker(t);
  const saved = await remember('Safe legacy context', { ...target.options, kind: 'reference' });
  const bad = JSON.stringify({ password: secret });
  for (const [field, key] of [['title', 'title'], ['description', 'description'], ['body', 'body'], ['why', 'memoryWhy'], ['how', 'memoryHow'], ['slug', 'memorySlug'], ['tags[0]', 'tags']] as const) {
    const original = (await target.client.get(saved.id, { full: true })).item;
    const value = field === 'slug' || field === 'tags[0]' ? 'rk-abcdefghijklmnop' : bad;
    await target.client.update(saved.id, key === 'tags' ? itemDocumentToMutationOptions(JSON.stringify({ tags: [value] }), 'update') : { [key]: value });
    const before = await snapshot(target.workspace); const output = join(target.root, 'refused-' + field);
    await assert.rejects(exportDir(output, { ...target.options, to: 'agents-md' }), error => {
      assert.ok(error instanceof MemoryError && error.code === 'privacy', `Expected privacy refusal for ${field}; received ${error instanceof MemoryError ? error.code : 'unexpected error'}`);
      credentialRefusal(error);
      assert.equal(error.message.includes(value), false);
      assert.ok(error instanceof MemoryError && error.message.includes(`record ${saved.id}, field ${field}:`));
      return true;
    });
    assert.deepEqual(await snapshot(target.workspace), before);
    await assert.rejects(access(output), { code: 'ENOENT' });
    await target.client.update(saved.id, key === 'tags' ? itemDocumentToMutationOptions(JSON.stringify({ tags: [] }), 'update') : { [key]: field === 'why' || field === 'how' ? '' : original[field === 'slug' ? 'memory_slug' : field] });
  }
});
