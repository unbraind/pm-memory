import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remember, get, importDir, exportDir, MemoryError } from '../index.ts';
import { privacy } from '../src/core.ts';
import { tracker, snapshot } from './helpers.ts';
import { causeDiagnostics } from './privacy-diagnostics.ts';

const secret = 'SyntheticOnly123!';
const reference = '$' + '{BUILD_PASSWORD}';
/** Assert the shared typed refusal never echoes the supplied literal. */
function refused(error: unknown): boolean {
  assert.ok(error instanceof MemoryError && error.code === 'privacy');
  const diagnostic = JSON.stringify({ message: error.message, remedy: error.remedy, cause: error.cause }) + causeDiagnostics(error.cause);
  assert.equal(diagnostic.includes(secret), false, 'Refusal must not expose literal content');
  return true;
}

test('quoted refusal diagnostics accept safe nested causes', () => {
  const cause = new Error('Safe wrapper', { cause: new Error('Safe nested detail') });
  assert.equal(refused(new MemoryError('privacy', 'Safe refusal', 'Safe remedy', { cause })), true);
});

test('quoted credential keys refuse before any durable memory write', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  for (const name of ['password', 'passphrase', 'passwd', 'pwd', 'api_key', 'access_token', 'auth_token', 'secret', 'token', '_authToken']) {
    for (const fact of [JSON.stringify({ [name]: secret }), "'" + name + "': '" + secret + "'"]) {
      await assert.rejects(remember(fact, { ...target.options, kind: 'reference', allowEmail: true }), refused);
      assert.deepEqual(await snapshot(target.workspace), before);
    }
  }
  await assert.rejects(remember('Safe guidance', { ...target.options, kind: 'reference', why: JSON.stringify({ password: secret }) }), refused);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('quoted credentials cover nested, escaped and normalized representations', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const plain = JSON.stringify({ password: secret });
  let four = plain; for (let depth = 0; depth < 4; depth++) four = JSON.stringify(four);
  const encodedKey = '{"pass' + '\\u0077' + 'ord":' + JSON.stringify(secret) + '}';
  const fixtures = [
    JSON.stringify({ nested: [{ api_key: secret }] }), encodedKey,
    [...plain].map(char => '%' + char.charCodeAt(0).toString(16)).join(''),
    JSON.stringify({ 'ｐａｓｓｗｏｒｄ': secret }), JSON.stringify({ ['pass' + '\u200b' + 'word']: secret }),
    JSON.stringify({ password: 'ab"cdefghi' }), JSON.stringify({ password: 'ﬃﬃﬃ' }), "'api_key': " + secret, '{"password":["' + secret + '"]}',
    '"password": "' + secret, "'password': '" + secret, '"password": "abc\\qdefgh"', '"password": "low entropy value"',
    "'password': 'aa''bb''cccc'", JSON.stringify(plain), four,
    'Example: ' + JSON.stringify(plain), JSON.stringify(plain).slice(1, -1),
    JSON.stringify(plain).slice(1, -1) + '\\q', '{"token":"accounting"}', '{"_authToken":"x"}',
    '{"password":12345678}', '{"safe":true,"note":' + JSON.stringify(plain) + '}',
    JSON.stringify({ password: '<' + secret + '>' }), "password: '<" + secret + ">'",
    'password: <' + secret + '>', 'password=<' + secret + '>',
    "password: <Pass'word123!>", 'password: <Pass"word123!>', "password=\"<Pass'word123!>\"", "'password': '<Pass'word123!>'",
    JSON.stringify({ api_key: '<hunter2>' }), JSON.stringify({ token: '<' + 'ghp_' + 'SyntheticFixture1234567890' + '>' }),
    JSON.stringify({ password: '<redacted!123>' }), JSON.stringify({ secret: '<pass word2>' }),
  ];
  for (const fact of fixtures) {
    // The shared helper also inspects the remedy and the cause chain.
    await assert.rejects(remember(fact, { ...target.options, kind: 'reference', allowEmail: true }), refused);
    assert.deepEqual(await snapshot(target.workspace), before);
  }
  let excessive = four; excessive = JSON.stringify(excessive);
  await assert.rejects(remember(excessive, { ...target.options, kind: 'reference' }), refused);
});

test('quoted safe references and short scalar controls remain readable and exportable', async t => {
  const target = await tracker(t);
  const fixtures = [
    JSON.stringify({ password: reference, api_key: '$BUILD_KEY' }),
    "'password': '<secret-manager-reference>'", "'password': '" + reference + "'", '"password": ""', '{"password":null,"enabled":true}',
    JSON.stringify({ password: 'abc\\', note: 'An ordinary long descriptive value' }),
    JSON.stringify({ password: 'ab', note: 'The word password is a field label' }),
    JSON.stringify(JSON.stringify({ password: reference })),
    'Example: ' + JSON.stringify(JSON.stringify({ password: reference })),
    JSON.stringify(JSON.stringify({ password: reference })).slice(1, -1),
    JSON.stringify({ password: [reference, '<redacted>'], note: [12, true, null] }),
    'Contact person@example.test', 'Example "bad' + '\\q' + '" and "password": "<redacted>"',
    'token: accounting; reference credentials through a secret manager',
    JSON.stringify({ password: '<secret manager reference>' }), JSON.stringify({ api_key: '<BUILD-PASSWORD>' }),
    'token: <accounting phrase>', 'password: <enter your password here>',
  ];
  for (const [index, fact] of fixtures.entries()) {
    const result = await remember(fact, { ...target.options, kind: 'reference', slug: 'safe-' + index, forceNew: true, allowEmail: true });
    assert.equal((await get(result.slug, target.options)).body, fact);
  }
  privacy('{"password":}'); privacy('"password": "abc'); privacy("'password': '<redacted>'");
  privacy(JSON.stringify({ password: '<secret-manager-reference>' }));
  const output = join(target.root, 'export');
  await exportDir(output, { ...target.options, to: 'agents-md' });
  assert.ok(Object.values(await snapshot(output)).map(value => Buffer.from(value, 'base64').toString('utf8')).join('\n').includes('BUILD_PASSWORD'));
});

test('quotes inside bracket wrappers refuse for every quote style and assignment form', () => {
  const body = 'Pass' + 'word123!';
  const forms = (wrapped: string) => [
    'password: ' + wrapped, 'password=' + wrapped, 'password: "' + wrapped + '"', "password: '" + wrapped + "'",
    "'password': '" + wrapped + "'", '"api_key": "' + wrapped + '"', 'token: ' + wrapped,
  ];
  for (const quote of ["'", '"']) for (const at of [0, 4, body.length]) {
    const literal = body.slice(0, at) + quote + body.slice(at);
    for (const fact of forms('<' + literal + '>')) assert.throws(() => privacy(fact, true), error => error instanceof MemoryError && error.code === 'privacy' && !error.message.includes(literal), fact);
  }
  for (const safe of ['password: <redacted>', 'password: "<redacted>"', "'password': '<secret-manager-reference>'", 'password: <enter your password here>', 'token: <accounting phrase>', 'note: use <angle brackets> and a "quote"']) privacy(safe, true);
});

test('quoted secret imports refuse before tracker mutation', async t => {
  const target = await tracker(t); const input = join(target.root, 'input'); await mkdir(input);
  const before = await snapshot(target.workspace);
  for (const fact of [JSON.stringify({ password: secret }), "'api_key': '" + secret + "'", 'Example: ' + JSON.stringify(JSON.stringify({ password: secret }))]) {
    await writeFile(join(input, 'guidance.md'), fact);
    await assert.rejects(importDir(input, { ...target.options, from: 'agents-md', allowEmail: true }), refused);
    assert.deepEqual(await snapshot(target.workspace), before);
  }
});

test('legacy quoted credentials remain readable but cannot be exported', async t => {
  const target = await tracker(t); const result = await remember('Safe legacy guidance', { ...target.options, kind: 'reference', slug: 'legacy' });
  const fact = JSON.stringify({ password: secret });
  await target.client.update(result.id, { body: fact });
  assert.equal((await get(result.slug, target.options)).body, fact);
  const before = await snapshot(target.workspace);
  const output = join(target.root, 'refused-export');
  await assert.rejects(exportDir(output, { ...target.options, to: 'agents-md' }), refused);
  await assert.rejects(access(output), { code: 'ENOENT' });
  assert.deepEqual(await snapshot(target.workspace), before);
});
