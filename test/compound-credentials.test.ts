import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remember, importDir, MemoryError } from '../index.ts';
import { privacy } from '../src/core.ts';
import { tracker, snapshot, exportedPolicy } from './helpers.ts';
import { causeDiagnostics } from './privacy-diagnostics.ts';

const literal = 'Zq8vN3kLmP0wXy7Ab';
const keys = ['db_password', 'DB_PASSWORD', 'client_secret', 'GITHUB_TOKEN', 'aws_secret_access_key', 'stripe_api_key'];
const forms: Readonly<Record<string, (key: string) => string>> = {
  'bare colon': key => `${key}: ${literal}`,
  'bare equals': key => `${key}=${literal}`,
  'CLI equals': key => `tool --${key}=${literal}`,
  JSON: key => JSON.stringify({ [key]: literal }),
  'malformed JSON value': key => '{"' + key + '":"' + literal + '\\q"}',
  Python: key => `{'${key}': '${literal}'}`,
  'nested array': key => JSON.stringify({ config: { [key]: [{ value: literal }] } }),
  'nested object': key => JSON.stringify({ [key]: { credentials: { value: literal } } }),
};

/** Refusals retain a safe domain diagnostic without returning credential text. */
function refusal(error: unknown): boolean {
  assert.ok(error instanceof MemoryError && error.code === 'privacy');
  assert.equal((JSON.stringify({ message: error.message, remedy: error.remedy, cause: error.cause }) + causeDiagnostics(error.cause)).includes(literal), false);
  return true;
}

test('compound refusal diagnostics accept safe nested causes', () => {
  const cause = new Error('Safe wrapper', { cause: new Error('Safe nested detail') });
  assert.equal(refusal(new MemoryError('privacy', 'Safe refusal', 'Safe remedy', { cause })), true);
});

for (const key of keys) for (const [form, render] of Object.entries(forms)) test(`compound credential ${key} refuses ${form} before writes`, async t => {
  const body = render(key); assert.throws(() => privacy(body), refusal);
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const file = join(target.root, 'source.md'); await writeFile(file, body);
  const attempts = [
    () => remember(body, { ...target.options, slug: 'credential-case', kind: 'reference', allowEmail: true }),
    ...(['agents-md', 'claude-code'] as const).map(from => () => importDir(file, { ...target.options, from, allowEmail: true })),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt, refusal);
    assert.deepEqual(await snapshot(target.workspace), before, 'Each admission path must refuse before native writes');
  }
});

const controls = [
  'token_budget: 800', 'max_tokens: 4096', 'output_token_budget: 2000', 'token_count: 12',
  'api_key: ${API_KEY}', 'client_secret: <your secret>', 'db_password: [scrubbed]',
  'the token expires after 5 minutes', '"Secret question": "Pick one"',
];
for (const [index, body] of controls.entries()) test(`compound credential control ${index + 1} remains writable and portable`, async t => {
  privacy(body); const target = await tracker(t);
  await remember(body, { ...target.options, slug: 'safe-control', kind: 'reference' });
  const expected = [{ slug: 'safe-control', body }];
  assert.deepEqual((await target.store.read()).map(({ slug, body }) => ({ slug, body })), expected);
  const policy = await exportedPolicy(target); const destination = await tracker(t);
  const receipt = await importDir(policy.path, { ...destination.options, from: 'agents-md' });
  assert.equal(receipt.imported, expected.length);
  assert.deepEqual((await destination.store.read()).map(({ slug, body }) => ({ slug, body })), expected);
});

test('compound grammar covers every suffix and repeated numeric prefixes without widening value rules', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  for (const suffix of ['password', 'passphrase', 'passwd', 'pwd', 'secret', 'token', 'apiKey', 'api_key', 'api-key', 'api key', 'accessToken', 'access_key', 'access-key', 'authToken', 'auth-token', 'privateKey', 'private_key', 'clientSecret', 'client-secret', 'secretKey', 'secret_access_key']) {
    const key = 'R2_region-' + suffix;
    for (const body of [forms['bare colon'](key), forms.JSON(key), forms.Python(key), forms['nested object'](key)]) {
      await assert.rejects(remember(body, { ...target.options, kind: 'reference' }), refusal);
    }
    for (const reference of ['${API_KEY}', '<your secret>']) {
      privacy(`${key}: ${reference}`); privacy(JSON.stringify({ [key]: { value: reference } }));
    }
    privacy(`${key}: [scrubbed]`); privacy(`${key}: short`);
  }
  privacy(JSON.stringify({ db_password: { value: '[scrubbed]' } }));
  for (const name of ['token_budget', 'max_tokens', 'output_token_budget', 'token_count']) privacy(`${name}: ${literal}`);
  assert.deepEqual(await snapshot(target.workspace), before);
});
