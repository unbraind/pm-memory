import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportDir, importDir, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { tracker, withoutGit, importText, importHarness, assertExportIdentity, snapshot } from './helpers.ts';

/** Read one complete native item through the same public SDK endpoint on both sides. */
async function record(target: Awaited<ReturnType<typeof tracker>>, id: string) { return (await target.client.get(id, { full: true })).item; }

for (const from of ['agents-md', 'claude-code', 'cursor'] as const) test(`current legacy grammar recognizes newly introduced frontmatter from ${from}`, async t => {
  for (const to of ['agents-md', 'claude-code'] as const) {
    const target = await tracker(t); withoutGit(t, target.root);
    const input = join(target.root, 'alpha.md'); const original = 'Alpha body'; await writeFile(input, original);
    await importDir(input, { ...target.options, from });
    const initial = (await target.client.listAllComplete()).items[0];
    const output = join(target.root, 'canonical'); await exportDir(output, { ...target.options, to });
    const manifest = JSON.parse(await readFile(join(output, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    const file = join(output, manifest.guidance[0].path); const emitted = await readFile(file, 'utf8');
    const marker = emitted.slice(0, emitted.indexOf('\n') + 1);
    const next = '---\r\ntype: feedback\r\ndescription: newly represented hook\r\ncustom: {nested: [false, null, 3]}\r\n---\r\nAlpha body';
    await writeFile(file, marker + next);
    assert.equal((await importDir(output, { ...target.options, from: to })).updated, 1);
    const actual = await record(target, initial.id);
    assert.equal(actual.memory_kind, 'feedback'); assert.equal(actual.description, 'newly represented hook'); assert.equal(actual.body, original);
    assert.equal(JSON.parse(String(actual.memory_document)).original, Buffer.from(next).toString('base64'));
    const stable = await record(target, initial.id); assert.equal((await importDir(output, { ...target.options, from: to })).updated, 0);
    assert.deepEqual(await record(target, initial.id), stable);
    await target.client.run('update', { id: initial.id, options: { description: 'Native hook', memoryKind: 'project' } });
    const freshOutput = join(target.root, 'after-native'); await exportDir(freshOutput, { ...target.options, to });
    const payload = join(freshOutput, manifest.guidance[0].path); const current = await readFile(payload, 'utf8');
    await writeFile(payload, current.replace('nested: [false', 'nested: [true'));
    assert.equal((await importDir(freshOutput, { ...target.options, from: to })).updated, 1);
    const native = await record(target, initial.id); assert.equal(native.description, 'Native hook'); assert.equal(native.memory_kind, 'project');
    const final = join(target.root, 'final'); await exportDir(final, { ...target.options, to });
    const bytes = await readFile(join(final, manifest.guidance[0].path), 'utf8'); assert.equal(bytes.slice(bytes.indexOf('\n') + 1), next.replace('nested: [false', 'nested: [true'));
    const destination = await tracker(t); await importDir(final, { ...destination.options, from: to });
    const copied = (await destination.client.listAllComplete({ includeBody: true })).items[0];
    assert.equal(copied.body, original); assert.equal(copied.memory_kind, 'project'); assert.equal(copied.description, 'Native hook');
  }
});

test('legacy export frames literal native YAML before current-grammar import', async t => {
  for (const hadFrontmatter of [false, true]) for (const literal of ['---\ntype: feedback\ndescription: literal only\n---\nNative body', '---\ninvalid: [\n---\nNative body']) {
    const target = await tracker(t); withoutGit(t, target.root);
    await importText(target, 'alpha.md', (hadFrontmatter ? '---\ncustom: retained\n---\n' : '') + 'Alpha body', 'cursor');
    const id = (await target.client.listAllComplete()).items[0].id;
    await target.client.run('update', { id, options: { body: literal, description: 'Native semantic hook', memoryKind: 'project' } });
    const output = join(target.root, 'output'); await assertExportIdentity(target, output, 'agents-md');
    const manifest = JSON.parse(await readFile(join(output, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    const bytes = await readFile(join(output, manifest.guidance[0].path), 'utf8');
    assert.equal(bytes.slice(bytes.indexOf('\n') + 1), (hadFrontmatter ? '---\ncustom: retained\n---\n' : '---\n{}\n---\n') + literal);
    const fresh = await tracker(t); await importDir(output, { ...fresh.options, from: 'agents-md' });
    const copied = (await fresh.client.listAllComplete({ includeBody: true })).items[0]; assert.equal(copied.body, literal); assert.equal(copied.description, 'Native semantic hook'); assert.equal(copied.memory_kind, 'project');
  }
});

test('raw and companion adapters also parse grammar transitions before native writes', async t => {
  for (const from of ['agents-md', 'claude-code'] as const) for (const companion of [false, true]) {
    const target = await tracker(t); withoutGit(t, target.root); const { directory: source, name } = await importHarness(target, from, 'Alpha body');
    const input = companion ? join(target.root, 'companion') : source;
    if (companion) await exportDir(input, { ...target.options, to: from });
    await writeFile(join(input, name), '---\ntype: feedback\ndescription: introduced\n---\nAlpha body');
    assert.equal((await importDir(input, { ...target.options, from })).updated, 1);
    const row = (await target.client.listAllComplete({ includeBody: true })).items.find(item => item.memory_artifact !== true)!;
    assert.equal(row.memory_kind, 'feedback'); assert.equal(row.description, 'introduced'); assert.equal(row.body, 'Alpha body');
  }
});

test('current plain export baseline preserves native title rationale and application overrides', async t => {
  const target = await tracker(t); withoutGit(t, target.root); await importText(target, 'alpha.md', 'Original plain source', 'cursor');
  const id = (await target.client.listAllComplete()).items[0].id;
  await target.client.run('update', { id, options: { title: 'Native title', memoryWhy: 'Native rationale', memoryHow: 'Native application', body: '# New body heading\n**Why:** Body rationale\n**How to apply:** Body application' } });
  await assertExportIdentity(target, join(target.root, 'output'), 'agents-md');
});

test('newly introduced invalid frontmatter refuses every canonical write before side effects', async t => {
  const target = await tracker(t); withoutGit(t, target.root); await importText(target, 'alpha.md', 'Plain source', 'cursor');
  const output = join(target.root, 'output'); await exportDir(output, { ...target.options, to: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(output, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  const file = join(output, manifest.guidance[0].path); const bytes = await readFile(file, 'utf8'); const marker = bytes.slice(0, bytes.indexOf('\n') + 1);
  const before = await snapshot(target.workspace);
  for (const invalid of ['type: unsupported', 'metadata: {type: unsupported}', 'custom: [', '- scalar', 'null']) {
    await writeFile(file, marker + `---\n${invalid}\n---\nPlain source`);
    await assert.rejects(importDir(output, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.remedy.length > 0);
    assert.deepEqual(await snapshot(target.workspace), before);
  }
});
