import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';
import { MemoryError, remember, get, importDir, exportDir } from '../index.ts';
import { privacy } from '../src/core.ts';
import { tracker, snapshot } from './helpers.ts';

const secret = 'SyntheticOnly123!';
const xml = '<password>' + secret.repeat(20) + '</password>';
const prefix = 'Public documentation line.\n'.repeat(2600);
const bodies = { XML: xml, JSON: JSON.stringify({ example: xml }), 'after 64 KiB': prefix + xml };
const paths = ['remember', 'import agents-md', 'import claude-code', 'export agents-md', 'export claude-code'] as const;

/** Require a real credential finding rather than passing through a resource-bound refusal. */
function refusal(error: unknown): boolean {
  assert.ok(error instanceof MemoryError && error.code === 'privacy');
  assert.match(error.message, /Credential-shaped memory refused/);
  assert.equal(JSON.stringify({ message: error.message, remedy: error.remedy, cause: error.cause }).includes(secret), false);
  return true;
}

for (const [label, body] of Object.entries(bodies)) for (const path of paths) test(`complete-value ${label} refuses through ${path}`, async t => {
  assert.ok(scanMutationSecrets(body).some(finding => finding.rule === 'password_assignment'));
  assert.ok(xml.length > 128); assert.ok(Buffer.byteLength(prefix) > 64 * 1024);
  const target = await tracker(t); const file = join(target.root, 'input.md'); const output = join(target.root, 'output');
  await writeFile(file, body);
  if (path.startsWith('export')) {
    const seed = await remember('Public retained legacy guidance', { ...target.options, kind: 'reference', slug: 'legacy' });
    await target.client.update(seed.id, { body });
    assert.equal((await get(seed.slug, target.options)).body, body, 'Earlier persisted records remain readable');
  }
  const before = await snapshot(target.workspace);
  const run = path === 'remember' ? () => remember(body, { ...target.options, kind: 'reference' })
    : path.startsWith('import') ? () => importDir(file, { ...target.options, from: path === 'import agents-md' ? 'agents-md' : 'claude-code' })
    : () => exportDir(output, { ...target.options, to: path === 'export agents-md' ? 'agents-md' : 'claude-code' });
  await assert.rejects(run, refusal);
  assert.deepEqual(await snapshot(target.workspace), before);
  await assert.rejects(access(output), { code: 'ENOENT' });
  assert.equal(await readFile(file, 'utf8'), body);
});

test('complete-value benign control of the same size survives remember, both imports and both exports', async t => {
  const body = prefix + 'B'.repeat(xml.length);
  assert.equal(Buffer.byteLength(body), Buffer.byteLength(bodies['after 64 KiB']));
  assert.deepEqual(scanMutationSecrets(body), []); privacy(body);
  const target = await tracker(t); const saved = await remember(body, { ...target.options, kind: 'reference', slug: 'benign' });
  assert.equal((await get(saved.slug, target.options)).body, body);
  const input = join(target.root, 'benign.md'); await writeFile(input, body);
  for (const from of ['agents-md', 'claude-code'] as const) {
    const intake = await tracker(t); assert.equal((await importDir(input, { ...intake.options, from })).imported, 1);
    assert.equal((await get('benign', intake.options)).body, body);
    const output = join(target.root, from); await exportDir(output, { ...target.options, to: from });
    const restored = await tracker(t); await importDir(output, { ...restored.options, from });
    assert.equal((await get(saved.slug, restored.options)).body, body);
  }
});

test('complete-value resource bounds refuse the whole value with a typed privacy error', () => {
  for (const value of ['A'.repeat(1024 * 1024 + 1), 'eyJ-'.repeat(50000)]) {
    assert.throws(() => privacy(value), error => error instanceof MemoryError && error.code === 'privacy' && error.message === 'Memory privacy scan size limit exceeded');
  }
});

test('complete SDK positives cannot be masked by a safe reference or a later local finding', () => {
  for (const body of ['password=$BUILD_PASSWORD', '_authToken=${BUILD_TOKEN}', 'password=${TOKEN}\n' + xml, xml + '\nclient_secret=Zq8vN3kLmP0wXy7Ab']) {
    assert.ok(scanMutationSecrets(body).length > 0);
    assert.throws(() => privacy(body), refusal);
  }
});
