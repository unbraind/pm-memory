import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';
import { MemoryError, remember, importDir, exportDir, get } from '../index.ts';
import { tracker, snapshot } from './helpers.ts';

const synthetic = 'aB3dE5gH7jK9mN2pQ4sT6vW8xY0zC1fR';
const refusedForms = [
  ['JSON password', '{"password":"abcdefgh"}'],
  ['Python API key', "'api_key': '" + synthetic + "'"],
  ['nested JSON array', 'Config: ' + JSON.stringify({ password: [{ value: [synthetic] }] })],
  ['XML password', '<password>' + synthetic + '</password>'],
] as const;

for (const [label, body] of refusedForms) test(`SDK structured ${label} refuses before memory or harness writes`, async t => {
  assert.ok(scanMutationSecrets(body).length > 0, 'The reviewed public SDK must own this spelling');
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const file = join(target.root, 'source.md'); await writeFile(file, body);
  const refusal = (error: unknown): boolean => {
    assert.ok(error instanceof MemoryError && error.code === 'privacy');
    assert.equal(JSON.stringify(error).includes(body), false); return true;
  };
  await assert.rejects(remember(body, { ...target.options, kind: 'reference', allowEmail: true }), refusal);
  for (const from of ['agents-md', 'claude-code'] as const) await assert.rejects(importDir(file, { ...target.options, from, allowEmail: true }), refusal);
  assert.deepEqual(await snapshot(target.workspace), before);
});

for (const [label, body] of [['environment placeholder', '${TOKEN}'], ['scrubbed marker', 'password=[scrubbed]'], ['localization label', '"New password": "Enter it"']] as const) test(`SDK structured control preserves ${label} through remember and portable transfer`, async t => {
  assert.deepEqual(scanMutationSecrets(body), []);
  const target = await tracker(t);
  const saved = await remember(body, { ...target.options, slug: 'safe-control', kind: 'reference' });
  assert.equal((await get(saved.slug, target.options)).body, body);
  const path = join(target.root, 'policy'); await exportDir(path, { ...target.options, to: 'agents-md' });
  const fresh = await tracker(t); assert.equal((await importDir(path, { ...fresh.options, from: 'agents-md' })).imported, 1);
  assert.equal((await get(saved.slug, fresh.options)).body, body);
  const raw = join(target.root, 'raw'); await mkdir(raw); await writeFile(join(raw, 'control.md'), body);
  for (const from of ['agents-md', 'claude-code'] as const) {
    const intake = await tracker(t);
    assert.equal((await importDir(raw, { ...intake.options, from })).imported, 1);
  }
});
