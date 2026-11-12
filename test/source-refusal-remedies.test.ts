import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { importDir, MemoryError } from '../index.ts';
import { privacy } from '../src/core.ts';
import { snapshot, tracker } from './helpers.ts';

for (const count of [1, 2]) test(`source refusal preserves a shared remedy for ${count} offending files`, async t => {
  const target = await tracker(t); const input = join(target.root, 'input'); await mkdir(input);
  const value = 'Public note\nContact person@example.test';
  for (let at = 0; at < count; at++) await writeFile(join(input, `guide-${at}.md`), value);
  const before = await snapshot(target.workspace);
  await assert.rejects(importDir(input, { ...target.options, from: 'agents-md' }), error => {
    assert.ok(error instanceof MemoryError && error.code === 'privacy');
    for (let at = 0; at < count; at++) assert.ok(error.message.includes(`guide-${at}.md:multiline (Email address refused)`));
    assert.match(error.remedy, /Remove addresses or explicitly use --allow-email/);
    assert.equal(error.remedy.split('Remove addresses').length - 1, 1, 'Shared class remedies are deduplicated');
    assert.equal(error.remedy.includes('Edit each listed file'), count > 1);
    assert.doesNotMatch(error.message + error.remedy, /person@example.test/); return true;
  });
  assert.deepEqual(await snapshot(target.workspace), before);
  for (let at = 0; at < count; at++) assert.equal(await readFile(join(input, `guide-${at}.md`), 'utf8'), value);
});

test('mixed source refusal combines file guidance with every class remedy before writes', async t => {
  const target = await tracker(t); const input = join(target.root, 'mixed'); await mkdir(input);
  const files = new Map([
    ['large.md', 'a'.repeat(1024 * 1024 + 1)],
    ['address.md', 'Contact person@example.test'],
    ['credential.md', 'password=SyntheticOnly123!'],
    ['safe.md', 'Public guidance'],
  ]);
  for (const [name, value] of files) await writeFile(join(input, name), value);
  const before = await snapshot(target.workspace);
  await assert.rejects(importDir(input, { ...target.options, from: 'claude-code' }), error => {
    assert.ok(error instanceof MemoryError && error.code === 'privacy');
    assert.equal(error.message, 'Import refused: address.md:line 1 (Email address refused); credential.md:line 1 (Credential-shaped memory refused); large.md:line 1 (Memory privacy scan size limit exceeded)');
    for (const remedy of [/1 MiB per inspected value.*simplify/, /--allow-email/, /secret manager/, /Edit each listed file/]) assert.match(error.remedy, remedy);
    assert.doesNotMatch(error.message + error.remedy, /SyntheticOnly123!|person@example.test/); return true;
  });
  assert.deepEqual(await snapshot(target.workspace), before);
  for (const [name, value] of files) assert.equal(await readFile(join(input, name), 'utf8'), value);
});

test('quoted assignments without an unquoted scalar preserve controls and inspect later credentials', () => {
  privacy('"password":', true);
  for (const control of ['"password": <redacted>', '"password": `label`', '"password": ab']) {
    privacy(control, true);
    assert.throws(() => privacy(control + '\n"api_key": "SyntheticOnly123!"', true), error => error instanceof MemoryError && error.code === 'privacy' && error.message === 'Credential-shaped memory refused');
  }
});
