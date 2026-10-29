import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, MemoryError, POLICY_MANIFEST, parsePolicy, remember } from '../index.ts';
import type { HarnessDocument, PortablePolicyManifest } from '../index.ts';
import { documentPatch, readDocument } from '../src/portable-source.ts';
import { validOwnedTarget } from '../src/portable-ownership.ts';
import { policyPayload, policyBody } from '../src/portable.ts';
import { digest } from '../src/core.ts';
import { tracker, crashAtStep, exportedPolicy, snapshot, importHarness } from './helpers.ts';

/** The oracle reads complete source bytes through the SDK, independently of importer projections. */
async function nativeDocument(target: Awaited<ReturnType<typeof tracker>>, slug: string): Promise<HarnessDocument> {
  const item = (await target.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === slug)!;
  return JSON.parse(String(item.memory_document)) as HarnessDocument;
}
/** Persist the released legacy shape without any newer document or transaction ownership fields. */
async function releasedSource(target: Awaited<ReturnType<typeof tracker>>, original: string): Promise<string> {
  await target.store.register();
  await target.client.run('create', { options: { title: 'alpha', body: 'Body', type: 'Knowledge', memorySlug: 'alpha', memoryKind: 'reference', memorySource: 'agents-md:relative-file', memoryPath: 'AGENTS.md', memoryOriginal: Buffer.from(original).toString('base64'), memoryEdited: false } });
  return (await target.client.listAllComplete()).items[0].id;
}
/** Keep a checksummed older companion that predates complete document snapshots. */
async function companionWithoutSnapshots(directory: string): Promise<void> {
  const file = join(directory, 'pm-memory-origins.json'); const envelope = JSON.parse(await readFile(file, 'utf8')) as { payload: string; checksum: string };
  const records = JSON.parse(envelope.payload) as { guidance: PortablePolicyManifest['guidance'][number] }[];
  for (const record of records) delete record.guidance.document;
  envelope.payload = JSON.stringify(records); envelope.checksum = digest(envelope.payload); await writeFile(file, JSON.stringify(envelope));
}
/** Produce an older policy body projection without claiming ownership of the native source snapshot. */
async function policyWithoutSnapshot(directory: string, body: string): Promise<void> {
  const file = join(directory, POLICY_MANIFEST); const manifest = JSON.parse(await readFile(file, 'utf8')) as PortablePolicyManifest;
  delete manifest.guidance[0].document; await writeFile(file, JSON.stringify(manifest));
  await writeFile(join(directory, manifest.guidance[0].path), policyBody(manifest.guidance[0], body));
}

test('unknown frontmatter edits update exactly one document through raw and companion imports', async t => {
  for (const from of ['agents-md', 'claude-code'] as const) for (const companion of [false, true]) {
    const target = await tracker(t);
    const first = '---\r\nname: alpha\r\ncustom: old-value\r\nnested: {key: [1, false, null]}\r\n---\r\n\r\n# Guidance\r\n\r\n## Unrecognized section\r\n\tKeep every byte.  \r\n';
    const { directory: source, name } = await importHarness(target, from, first);
    const input = companion ? join(target.root, 'companion') : source;
    if (companion) await exportDir(input, { ...target.options, to: from });
    const before = (await target.client.listAllComplete({ includeBody: true })).items;
    const second = first.replace('old-value', 'new-value'); await writeFile(join(input, name), second);
    const result = await importDir(input, { ...target.options, from });
    assert.equal(result.updated, 1, `${from}/${companion}`); assert.equal(result.imported, 0);
    assert.equal((await nativeDocument(target, 'alpha')).original, Buffer.from(second).toString('base64'));
    const after = (await target.client.listAllComplete({ includeBody: true })).items;
    for (const item of before) {
      const actual = after.find(row => row.id === item.id)!;
      assert.deepEqual(actual, item.memory_slug === 'alpha' ? { ...item, memory_document: actual.memory_document, updated_at: actual.updated_at } : item);
    }
    const output = join(target.root, 'output'); await exportDir(output, { ...target.options, to: from });
    assert.deepEqual(await readFile(join(output, name)), Buffer.from(second));
    assert.equal((await importDir(input, { ...target.options, from })).updated, 0);
    await importDir(output, { ...target.options, from });
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, after);
  }
});

test('complete source bytes survive canonical policy exports and journal-free tracker clones', async t => {
  const target = await tracker(t); const source = join(target.root, 'alpha.md');
  const first = '---\nname: alpha\ncustom: old-value\n---\nBody'; const second = first.replace('old-value', 'new-value');
  await writeFile(source, first); await importDir(source, { ...target.options, from: 'cursor' });
  await writeFile(source, second); assert.equal((await importDir(source, { ...target.options, from: 'cursor' })).updated, 1);
  const output = join(target.root, 'policy'); await exportDir(output, { ...target.options, to: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(output, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  assert.equal(manifest.guidance[0].document!.original, Buffer.from(second).toString('base64'));
  const payload = await readFile(join(output, manifest.guidance[0].path), 'utf8');
  assert.equal(payload.slice(payload.indexOf('\n') + 1), second, 'Unknown frontmatter remains visible in the exported harness file');
  delete manifest.guidance[0].baseline!.bodyHash; delete manifest.guidance[0].baseline!.sourceFields;
  await writeFile(join(output, POLICY_MANIFEST), JSON.stringify(manifest));
  await writeFile(join(output, manifest.guidance[0].path), policyBody(manifest.guidance[0], second));
  const fresh = await tracker(t); await importDir(output, { ...fresh.options, from: 'agents-md' });
  assert.equal((await nativeDocument(fresh, 'alpha')).original, Buffer.from(second).toString('base64'));
  const edited = second.replace('new-value', 'compatibility-value');
  await writeFile(join(output, manifest.guidance[0].path), policyBody(manifest.guidance[0], edited));
  const older = await tracker(t); await importDir(output, { ...older.options, from: 'agents-md' });
  assert.equal((await nativeDocument(older, 'alpha')).original, Buffer.from(edited).toString('base64'));
  const clone = await tracker(t); await rm(clone.workspace, { recursive: true });
  await cp(target.workspace, clone.workspace, { recursive: true, filter: path => !['transactions', 'runtime', 'locks', 'search', 'checkpoints'].includes(relative(target.workspace, path).split('/')[0]) });
  assert.deepEqual(await nativeDocument(clone, 'alpha'), await nativeDocument(target, 'alpha'));
  const again = join(clone.root, 'output'); await exportDir(again, { ...clone.options, to: 'claude-code' });
  const copied = JSON.parse(await readFile(join(again, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  assert.equal(copied.guidance[0].document!.original, Buffer.from(second).toString('base64'));
});

test('full canonical documents preserve native semantic overrides and older manifest replays', async t => {
  const target = await tracker(t); const file = join(target.root, 'alpha.md');
  const first = '---\ncustom: old-value\n---\n# Source title\n**Why:** Source rationale';
  await writeFile(file, first); await importDir(file, { ...target.options, from: 'cursor' });
  const id = (await target.client.listAllComplete()).items[0].id;
  await target.client.run('update', { id, options: { title: 'Native title', memoryWhy: 'Native rationale', memoryHow: 'Native instructions', body: 'Body heading\n**Why:** Body rationale\n**How to apply:** Body instructions' } });
  const exported = await exportedPolicy(target, 'canonical'); const native = (await target.client.listAllComplete({ includeBody: true })).items;
  assert.equal((await importDir(exported.path, { ...target.options, from: 'agents-md' })).updated, 0);
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, native);
  const payload = join(exported.path, exported.manifest.guidance[0].path); const content = await readFile(payload, 'utf8');
  assert.ok(content.includes('custom: old-value'));
  await writeFile(payload, content.replace('old-value', 'new-value'));
  assert.equal((await importDir(exported.path, { ...target.options, from: 'agents-md' })).updated, 1);
  const next = (await target.client.get(id, { full: true })).item;
  assert.equal(next.title, 'Native title'); assert.equal(next.memory_why, 'Native rationale'); assert.equal(next.memory_how, 'Native instructions');
  await writeFile(payload, content);
  assert.equal((await importDir(exported.path, { ...target.options, from: 'agents-md' })).updated, 1, 'A/B/A is a real document update');
  const final = await exportedPolicy(target, 'final');
  assert.equal((await readFile(join(final.path, final.manifest.guidance[0].path), 'utf8')).split('\n').slice(1).join('\n'), content.split('\n').slice(1).join('\n'));
});

test('exact policy bytes survive whitespace edits without restoring a stale native body', async t => {
  for (const from of ['agents-md', 'claude-code'] as const) {
    const target = await tracker(t); await remember('Initial body', { ...target.options, slug: 'alpha', kind: 'reference' });
    const initial = await exportedPolicy(target, 'initial'); initial.manifest.harness = from;
    await writeFile(join(initial.path, POLICY_MANIFEST), JSON.stringify(initial.manifest));
    const file = join(initial.path, initial.manifest.guidance[0].path); const content = await readFile(file, 'utf8');
    const first = '\n---\r\ncustom: old-value\r\n---\r\n\r\nBody  \r\n';
    await writeFile(file, content.slice(0, content.indexOf('\n') + 1) + first);
    assert.equal((await importDir(initial.path, { ...target.options, from })).updated, 1);
    const firstOutput = join(target.root, 'first-output'); await exportDir(firstOutput, { ...target.options, to: from });
    const raw = await readFile(join(firstOutput, initial.manifest.guidance[0].path), 'utf8'); assert.equal(raw.slice(raw.indexOf('\n') + 1), first);
    const id = (await target.client.listAllComplete()).items[0].id; await target.client.update(id, { body: 'Native C', author: 'peer-agent' });
    const nativeOutput = join(target.root, 'native-output'); await exportDir(nativeOutput, { ...target.options, to: from });
    const before = (await target.client.listAllComplete({ includeBody: true })).items;
    assert.equal((await importDir(nativeOutput, { ...target.options, from })).updated, 0);
    assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
    const nativeFile = join(nativeOutput, initial.manifest.guidance[0].path); const nativeContent = await readFile(nativeFile, 'utf8');
    const second = '\nNative C\r\n  \n'; await writeFile(nativeFile, nativeContent.slice(0, nativeContent.indexOf('\n') + 1) + second);
    assert.equal((await importDir(nativeOutput, { ...target.options, from })).updated, 1);
    const final = join(target.root, 'final-output'); await exportDir(final, { ...target.options, to: from });
    const finalBytes = await readFile(join(final, initial.manifest.guidance[0].path), 'utf8'); assert.equal(finalBytes.slice(finalBytes.indexOf('\n') + 1), second);
    assert.equal((await importDir(final, { ...target.options, from })).updated, 0);
    assert.equal((await importDir(initial.path, { ...target.options, from })).updated, 1, 'An older body snapshot is a real update');
    const replayed = join(target.root, 'replayed'); await exportDir(replayed, { ...target.options, to: from });
    const replayedBytes = await readFile(join(replayed, initial.manifest.guidance[0].path), 'utf8'); assert.equal(replayedBytes.slice(replayedBytes.indexOf('\n') + 1), first);
  }
});

test('older policy projections preserve omitted native document metadata during body edits', async t => {
  const target = await tracker(t); const file = join(target.root, 'alpha.md');
  const original = '---\ncustom: old-value\n---\nBody'; await writeFile(file, original);
  await importDir(file, { ...target.options, from: 'cursor' }); const exported = await exportedPolicy(target);
  const item = (await target.client.listAllComplete()).items[0];
  const native = { ...await nativeDocument(target, 'alpha'), original: Buffer.from(original.replace('old-value', 'native-value')).toString('base64') };
  await target.client.run('update', { id: item.id, options: { memoryDocument: JSON.stringify(native), author: 'peer-agent' } });
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  const unchanged = await importDir(exported.path, { ...target.options, from: 'agents-md' });
  assert.ok('skipped' in unchanged && unchanged.skipped.some(row => row.reason.includes('document')));
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  delete exported.manifest.guidance[0].document;
  await writeFile(join(exported.path, POLICY_MANIFEST), JSON.stringify(exported.manifest));
  const body = join(exported.path, exported.manifest.guidance[0].path); const previous = await readFile(body, 'utf8');
  await writeFile(body, previous.slice(0, previous.indexOf('\n') + 1) + '\nHarness body B  \n');
  assert.equal((await importDir(exported.path, { ...target.options, from: 'agents-md' })).updated, 1);
  assert.deepEqual(await nativeDocument(target, 'alpha'), native);
  const next = await exportedPolicy(target, 'again'); assert.deepEqual(next.manifest.guidance[0].document, native);
});

test('native policy payload ownership wins until a fresh export authorizes another edit', async t => {
  const target = await tracker(t); await remember('Initial body', { ...target.options, slug: 'alpha', kind: 'reference' });
  const { path, manifest } = await exportedPolicy(target); const file = join(path, manifest.guidance[0].path);
  const initial = await readFile(file, 'utf8'); const marker = initial.slice(0, initial.indexOf('\n') + 1);
  await writeFile(file, marker + '\nBody A  \n'); await importDir(path, { ...target.options, from: 'agents-md' });
  const exported = await exportedPolicy(target, 'before-peer'); const row = (await target.client.listAllComplete()).items[0];
  const cache = JSON.parse(String(row.memory_policy_body)) as HarnessDocument;
  await target.client.run('update', { id: row.id, options: { memoryPolicyBody: JSON.stringify({ ...cache, original: Buffer.from('Native policy bytes').toString('base64') }), author: 'peer-agent' } });
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  const edited = join(exported.path, exported.manifest.guidance[0].path); const old = await readFile(edited, 'utf8');
  await writeFile(edited, old.slice(0, old.indexOf('\n') + 1) + '\nHarness B  \n');
  const refused = await importDir(exported.path, { ...target.options, from: 'agents-md' });
  assert.ok('skipped' in refused && refused.skipped.some(entry => entry.reason.includes('body')));
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  const fresh = await exportedPolicy(target, 'fresh'); const next = join(fresh.path, fresh.manifest.guidance[0].path); const bytes = await readFile(next, 'utf8');
  await writeFile(next, bytes.slice(0, bytes.indexOf('\n') + 1) + '\nApproved C  \n');
  assert.equal((await importDir(fresh.path, { ...target.options, from: 'agents-md' })).updated, 1);
});

test('native document edits win and malformed foreign document records are skipped', async t => {
  const target = await tracker(t); const source = join(target.root, 'alpha.md');
  const first = '---\ncustom: old-value\n---\nBody'; await writeFile(source, first);
  await importDir(source, { ...target.options, from: 'agents-md' });
  const item = (await target.client.listAllComplete({ includeBody: true })).items[0];
  const native = { ...await nativeDocument(target, 'alpha'), original: Buffer.from(first.replace('old-value', 'native-value')).toString('base64') };
  await target.client.run('update', { id: item.id, options: { memoryDocument: JSON.stringify(native), author: 'native-agent' } });
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  await writeFile(source, first.replace('old-value', 'harness-value'));
  await assert.rejects(importDir(source, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict');
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  await writeFile(source, Buffer.from(native.original, 'base64'));
  assert.equal((await importDir(source, { ...target.options, from: 'agents-md' })).unchanged, 1);
  await target.client.run('update', { id: item.id, options: { memoryDocument: '{foreign' } });
  const foreign = (await target.client.listAllComplete({ includeBody: true })).items;
  const result = await importDir(source, { ...target.options, from: 'agents-md' }); assert.ok('skipped' in result && result.skipped.length > 0);
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, foreign);
  const output = join(target.root, 'foreign-export'); const exported = await exportDir(output, { ...target.options, to: 'agents-md' });
  assert.ok(exported.skipped!.length > 0); assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, foreign);
});

test('complete document validation and decoded privacy refuse before any tracker write', async t => {
  const source = await tracker(t); await remember('Guidance', { ...source.options, slug: 'alpha', kind: 'reference' });
  const { path, manifest } = await exportedPolicy(source);
  const document: HarnessDocument = { version: 1, format: 'legacy', harness: 'agents-md', path: 'alpha.md', original: Buffer.from('---\ncustom: contact@example.invalid\n---\nBody').toString('base64') };
  for (const value of [null, {}, { ...document, version: 2 }, { ...document, original: 'invalid base64' }, { ...document, path: '../outside' }]) {
    assert.throws(() => parsePolicy({ ...manifest, guidance: [{ ...manifest.guidance[0], document: value }] }), MemoryError);
  }
  for (const key of ['bodyHash', 'documentHash', 'policyBodyHash', 'sourceFields']) for (const value of [null, 1, '', 'invalid', {}]) {
    assert.throws(() => parsePolicy({ ...manifest, guidance: [{ ...manifest.guidance[0], baseline: { ...manifest.guidance[0].baseline, [key]: value } }] }), MemoryError);
  }
  manifest.guidance[0].document = document;
  await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
  const target = await tracker(t); const before = await snapshot(target.workspace);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'privacy');
  assert.deepEqual(await snapshot(target.workspace), before);
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md', allowEmail: true })).imported, 1);
});

test('unrecognized index frontmatter survives raw companion edits and has explicit policy loss receipts', async t => {
  const target = await tracker(t); const source = join(target.root, 'source'); await mkdir(source);
  const first = '---\ncustom: old-value\n---\n- [Alpha](alpha.md)\n';
  await writeFile(join(source, 'MEMORY.md'), first); await writeFile(join(source, 'alpha.md'), 'Alpha');
  await importDir(source, { ...target.options, from: 'claude-code' });
  const output = join(target.root, 'output'); await exportDir(output, { ...target.options, to: 'claude-code' });
  const second = first.replace('old-value', 'new-value'); await writeFile(join(output, 'MEMORY.md'), second);
  assert.equal((await importDir(output, { ...target.options, from: 'claude-code' })).updated, 1);
  const final = join(target.root, 'final'); await exportDir(final, { ...target.options, to: 'claude-code' });
  assert.equal(await readFile(join(final, 'MEMORY.md'), 'utf8'), second);
  await remember('Native guidance forces canonical policy output', { ...target.options, slug: 'native', kind: 'reference' });
  const canonical = await exportDir(join(target.root, 'canonical'), { ...target.options, to: 'claude-code' });
  assert.ok(canonical.lossy!.some(row => row.fields.includes('artifact') && row.fields.includes('document')));
});

test('complete document updates converge at every observed import step without duplicates', async t => {
  const probe = await tracker(t); const file = join(probe.root, 'alpha.md');
  const first = '---\ncustom: old-value\n---\nBody'; const second = first.replace('old-value', 'new-value');
  await writeFile(file, first); await importDir(file, { ...probe.options, from: 'agents-md' });
  await writeFile(file, second); const steps = new Set<string>();
  await importDir(file, { ...probe.options, from: 'agents-md', onStep: step => { steps.add(step); } });
  for (const boundary of steps) {
    const target = await tracker(t); const input = join(target.root, 'alpha.md');
    await writeFile(input, first); await importDir(input, { ...target.options, from: 'agents-md' }); await writeFile(input, second);
    await assert.rejects(importDir(input, { ...target.options, from: 'agents-md', onStep: crashAtStep(boundary) }), WorkspaceTransactionInterruptedError);
    await importDir(input, { ...target.options, from: 'agents-md' });
    const rows = (await target.client.listAllComplete({ includeBody: true })).items;
    assert.equal(rows.length, 1); assert.equal((await nativeDocument(target, 'alpha')).original, Buffer.from(second).toString('base64'), boundary);
    assert.equal((await importDir(input, { ...target.options, from: 'agents-md' })).unchanged, 1);
  }
  t.diagnostic(`Complete document update crash boundaries=${steps.size}`);
});

test('document envelopes validate complete bytes and preserve earlier absent snapshots', () => {
  const document: HarnessDocument = { version: 1, format: 'legacy', harness: 'agents-md', path: 'alpha.md', original: Buffer.from('---\ncustom: [1, {x: true}]\n---\nBody').toString('base64') };
  assert.deepEqual(readDocument(document), document); assert.deepEqual(readDocument(JSON.stringify(document)), document);
  for (const value of [undefined, null, 1, [], '{', {}, { ...document, version: 2 }, { ...document, harness: 'unknown' }, { ...document, format: 'unknown' }, { ...document, path: '' }, { ...document, path: '../outside' }, { ...document, path: '/outside' }, { ...document, original: 1 }, { ...document, original: 'not base64' }, { ...document, original: Buffer.from([255]).toString('base64') }, { ...document, original: Buffer.from('---\ncustom: [\n---\nBody').toString('base64') }, { ...document, extra: true }]) assert.equal(readDocument(value), undefined);
  assert.deepEqual(readDocument({ ...document, format: 'policy' }), { ...document, format: 'policy' });
  assert.deepEqual(documentPatch({ document }, document, undefined), { options: {}, conflict: false });
  assert.deepEqual(documentPatch({}, document, document.original), { options: {}, conflict: false });
  assert.ok(documentPatch({}, document, undefined).options.memoryDocument);
  const edited = { ...document, original: Buffer.from('---\ncustom: changed\n---\nBody').toString('base64') };
  assert.deepEqual(documentPatch({ document }, edited, undefined, true), { options: {}, conflict: true });
  assert.deepEqual(documentPatch({}, edited, undefined, true), { options: {}, conflict: true });
  assert.ok(documentPatch({ document }, edited, document.original).options.memoryDocument);
});

test('document receipt fingerprints reject foreign invalid values independently of known fields', async t => {
  const target = await tracker(t); await remember('Body', { ...target.options, slug: 'alpha', kind: 'reference' });
  const exported = await exportedPolicy(target); const fields = exported.manifest.guidance[0].baseline!.fields;
  const receipt = { id: 'memory-example', fields, relationships: [], graph: [] };
  assert.equal(validOwnedTarget(receipt), true);
  for (const key of ['documentHash', 'policyBodyHash']) {
    assert.equal(validOwnedTarget({ ...receipt, [key]: digest('complete document') }), true);
    for (const value of [null, 1, '', 'invalid', {}]) assert.equal(validOwnedTarget({ ...receipt, [key]: value }), false);
  }
  const memory = (await target.store.read())[0];
  const raw = '\nBody  \n'; const document: HarnessDocument = { version: 1, format: 'policy', harness: 'agents-md', path: 'alpha.md', original: Buffer.from(raw).toString('base64') };
  assert.equal(policyPayload({ ...memory, document }), raw);
  assert.equal(policyPayload({ ...memory, document, body: 'Native edit' }), 'Native edit');
  assert.equal(policyPayload({ ...memory, document, policyBody: { ...document, original: Buffer.from('Native edit').toString('base64') } }), memory.body);
});

test('companion recovery distinguishes successive unknown-only input documents', async t => {
  const target = await tracker(t); const input = join(target.root, 'AGENTS.md');
  const first = '---\nname: alpha\ncustom: A\n---\nBody'; await writeFile(input, first);
  await importDir(input, { ...target.options, from: 'agents-md' });
  const output = join(target.root, 'output'); await exportDir(output, { ...target.options, to: 'agents-md' });
  const file = join(output, 'AGENTS.md'); const interrupted = first.replace('custom: A', 'custom: B'); await writeFile(file, interrupted);
  await assert.rejects(importDir(output, { ...target.options, from: 'agents-md', onStep: crashAtStep('intent') }), WorkspaceTransactionInterruptedError);
  const final = first.replace('custom: A', 'custom: C'); await writeFile(file, final);
  await assert.rejects(importDir(output, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'conflict');
  await writeFile(file, interrupted); await importDir(output, { ...target.options, from: 'agents-md' });
  await writeFile(file, final);
  await importDir(output, { ...target.options, from: 'agents-md' });
  assert.equal((await nativeDocument(target, 'alpha')).original, Buffer.from(final).toString('base64'));
  const again = join(target.root, 'again'); await exportDir(again, { ...target.options, to: 'agents-md' });
  assert.equal(await readFile(join(again, 'AGENTS.md'), 'utf8'), final);
});

test('policy snapshots remove historical whitespace and preserve policy-format native documents', async t => {
  const target = await tracker(t); const file = join(target.root, 'alpha.md');
  await writeFile(file, '---\ncustom: retained\n---\n\nBody A  \n');
  await importDir(file, { ...target.options, from: 'cursor' });
  const exported = await exportedPolicy(target); delete exported.manifest.guidance[0].document;
  const payload = join(exported.path, exported.manifest.guidance[0].path); const bytes = await readFile(payload, 'utf8');
  await writeFile(payload, bytes.slice(0, bytes.indexOf('\n') + 1) + 'Body A');
  await writeFile(join(exported.path, POLICY_MANIFEST), JSON.stringify(exported.manifest));
  await importDir(exported.path, { ...target.options, from: 'agents-md' });
  const retained = await exportedPolicy(target, 'retained-native-document'); const retainedBytes = await readFile(join(retained.path, retained.manifest.guidance[0].path), 'utf8');
  assert.equal(retainedBytes.slice(retainedBytes.indexOf('\n') + 1), '---\ncustom: retained\n---\nBody A');
  const fresh = await tracker(t); await importDir(exported.path, { ...fresh.options, from: 'agents-md' });
  const output = await exportedPolicy(fresh); const full = await readFile(join(output.path, output.manifest.guidance[0].path), 'utf8');
  assert.equal(full.slice(full.indexOf('\n') + 1), 'Body A');
  const item = (await fresh.client.listAllComplete()).items[0];
  const document: HarnessDocument = { version: 1, format: 'policy', harness: 'agents-md', path: 'alpha.md', original: Buffer.from('\nBody A  \n').toString('base64') };
  await fresh.client.run('update', { id: item.id, options: { memoryDocument: JSON.stringify(document), body: 'Body A' } });
  const before = (await fresh.client.listAllComplete({ includeBody: true })).items;
  const native = await exportedPolicy(fresh, 'native-policy');
  assert.equal((await importDir(native.path, { ...fresh.options, from: 'agents-md' })).updated, 0);
  assert.deepEqual((await fresh.client.listAllComplete({ includeBody: true })).items, before);
  const portable = structuredClone(native.manifest); portable.guidance[0].document = document;
  const whitespace = join(native.path, portable.guidance[0].path); const current = await readFile(whitespace, 'utf8');
  await writeFile(whitespace, current.slice(0, current.indexOf('\n') + 1) + 'Body A');
  await writeFile(join(native.path, POLICY_MANIFEST), JSON.stringify(portable));
  const older = await tracker(t); await importDir(native.path, { ...older.options, from: 'agents-md' });
  const restored = await exportedPolicy(older); const actual = await readFile(join(restored.path, restored.manifest.guidance[0].path), 'utf8');
  assert.equal(actual.slice(actual.indexOf('\n') + 1), 'Body A', 'A fresh canonical body must override historical snapshot whitespace');
  await writeFile(whitespace, current.slice(0, current.indexOf('\n') + 1) + 'Later body');
  const later = await tracker(t); await importDir(native.path, { ...later.options, from: 'agents-md' });
  const latest = await exportedPolicy(later); const replaced = await readFile(join(latest.path, latest.manifest.guidance[0].path), 'utf8');
  assert.equal(replaced.slice(replaced.indexOf('\n') + 1), 'Later body', 'Historical policy document bytes cannot replace a newer semantic body');
});

test('raw imports synchronize owned policy bytes and retain foreign exact-body edits', async t => {
  for (const from of ['agents-md', 'claude-code'] as const) {
    const target = await tracker(t); const file = join(target.root, from === 'agents-md' ? 'AGENTS.md' : 'alpha.md');
    const first = '---\nname: alpha\ncustom: A\n---\nBody A'; await writeFile(file, first);
    await importDir(file, { ...target.options, from });
    const policy = join(target.root, 'older-policy'); await exportDir(policy, { ...target.options, to: 'claude-code' });
    await policyWithoutSnapshot(policy, '\nBody B  \n');
    assert.equal((await importDir(policy, { ...target.options, from: 'claude-code' })).updated, 1);
    const revised = first.replace('custom: A', 'custom: C').replace('Body A', '\nBody C  \n'); await writeFile(file, revised);
    assert.equal((await importDir(file, { ...target.options, from })).updated, 1);
    const item = (await target.client.listAllComplete({ includeBody: true })).items[0];
    assert.equal(item.body, 'Body C');
    const cache = JSON.parse(String(item.memory_policy_body)) as HarnessDocument;
    assert.equal(Buffer.from(cache.original, 'base64').toString('utf8'), '\nBody C  \n');
    assert.equal((await importDir(file, { ...target.options, from })).unchanged, 1);
    const foreign = { ...cache, original: Buffer.from('Peer exact-body bytes').toString('base64') };
    await target.client.run('update', { id: item.id, options: { memoryPolicyBody: JSON.stringify(foreign), author: 'peer-agent' } });
    await writeFile(file, revised.replace('custom: C', 'custom: D').replace('Body C', 'Body D'));
    const before = (await target.client.get(item.id, { full: true })).item;
    const result = await importDir(file, { ...target.options, from });
    assert.equal(result.updated, 0); assert.ok('skipped' in result && result.skipped.some(row => row.reason.includes('body')));
    assert.deepEqual((await target.client.get(item.id, { full: true })).item, before);
    await writeFile(file, revised.replace('custom: C', 'custom: D').replace('\nBody C  \n', 'Body C'));
    assert.equal((await importDir(file, { ...target.options, from })).updated, 1);
    const actual = (await target.client.get(item.id, { full: true })).item;
    assert.equal(actual.body, 'Body C'); assert.deepEqual(JSON.parse(String(actual.memory_policy_body)), foreign);
    assert.equal(Buffer.from((await nativeDocument(target, 'alpha')).original, 'base64').toString('utf8').includes('custom: D'), true);
  }
});

test('released legacy records without document snapshots retain unknown source bytes on their first update', async t => {
  const target = await tracker(t);
  const first = '---\r\nname: alpha\r\ncustom: old-value\r\n---\r\nBody';
  const id = await releasedSource(target, first);
  const before = (await target.client.get(id, { full: true })).item;
  assert.equal(before.memory_document, undefined);
  const output = join(target.root, 'old-export'); await exportDir(output, { ...target.options, to: 'agents-md' });
  assert.deepEqual(await readFile(join(output, 'AGENTS.md')), Buffer.from(first));
  assert.deepEqual((await target.client.get(id, { full: true })).item, before);
  const file = join(target.root, 'AGENTS.md'); const second = first.replace('old-value', 'new-value'); await writeFile(file, second);
  assert.equal((await importDir(file, { ...target.options, from: 'agents-md' })).updated, 1);
  assert.equal((await nativeDocument(target, 'alpha')).original, Buffer.from(second).toString('base64'));
  const final = join(target.root, 'old-updated'); await exportDir(final, { ...target.options, to: 'agents-md' });
  assert.deepEqual(await readFile(join(final, 'AGENTS.md')), Buffer.from(second));
  await companionWithoutSnapshots(final);
  const third = second.replace('new-value', 'older-companion-value'); await writeFile(join(final, 'AGENTS.md'), third);
  assert.equal((await importDir(final, { ...target.options, from: 'agents-md' })).updated, 1);
  assert.equal((await nativeDocument(target, 'alpha')).original, Buffer.from(third).toString('base64'));
});

test('released source ownership survives canonical handoffs and snapshot-free companion replays', async t => {
  const target = await tracker(t); const first = '---\nname: alpha\n---\nBody'; const id = await releasedSource(target, first);
  const legacy = join(target.root, 'legacy'); await exportDir(legacy, { ...target.options, to: 'agents-md' });
  await companionWithoutSnapshots(legacy);
  const policy = join(target.root, 'policy'); await exportDir(policy, { ...target.options, to: 'claude-code' });
  await policyWithoutSnapshot(policy, 'Canonical body B');
  assert.equal((await importDir(policy, { ...target.options, from: 'claude-code' })).updated, 1);
  const original = (await target.client.get(id, { full: true })).item;
  assert.equal(original.memory_document, undefined); assert.equal(original.memory_policy_body, undefined);
  const raw = join(target.root, 'AGENTS.md'); await writeFile(raw, first);
  assert.equal((await importDir(raw, { ...target.options, from: 'agents-md' })).updated, 1);
  assert.equal((await target.client.get(id, { full: true })).item.memory_document, undefined);
  assert.equal((await importDir(policy, { ...target.options, from: 'claude-code' })).updated, 1);
  assert.equal((await importDir(legacy, { ...target.options, from: 'agents-md' })).updated, 1);
  const after = (await target.client.get(id, { full: true })).item;
  assert.ok(Date.parse(String(after.memory_changed_at)) >= Date.parse(String(original.memory_changed_at)));
  assert.deepEqual(after, { ...original, body: 'Body', memory_changed_at: after.memory_changed_at, updated_at: after.updated_at });
});

test('snapshot-free legacy adapters bind native origins without inventing prior source receipts', async t => {
  const target = await tracker(t); const item = await remember('Alpha baseline', { ...target.options, slug: 'alpha', kind: 'reference' });
  const exported = await exportedPolicy(target); const guidance = exported.manifest.guidance[0];
  const payload = JSON.stringify([{ file: 'alpha.md', guidance, decoded: guidance.baseline!.fields, links: [], artifact: false }]);
  const directory = join(target.root, 'legacy-adapter'); await mkdir(directory);
  await writeFile(join(directory, 'pm-memory-origins.json'), JSON.stringify({ version: 1, format: 'pm-memory-origins', harness: 'agents-md', payload, checksum: digest(payload) }));
  await writeFile(join(directory, 'alpha.md'), 'Alpha revised');
  const before = (await target.client.get(item.id, { full: true })).item;
  assert.equal((await importDir(directory, { ...target.options, from: 'agents-md' })).updated, 1);
  const actual = (await target.client.get(item.id, { full: true })).item;
  const document = JSON.stringify({ format: 'legacy', harness: 'agents-md', original: Buffer.from('Alpha revised').toString('base64'), path: 'alpha.md', version: 1 });
  const { memory_verified_at: _verification, memory_reason: _reason, ...preserved } = before;
  assert.deepEqual([actual.memory_reason, actual.memory_verified_at], [undefined, undefined]);
  assert.ok(Date.parse(String(actual.memory_changed_at)) >= Date.parse(String(before.memory_changed_at)));
  assert.deepEqual(actual, { ...preserved, body: 'Alpha revised', title: 'Alpha revised', memory_document: document, memory_changed_at: actual.memory_changed_at, updated_at: actual.updated_at });
});
