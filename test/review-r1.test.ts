import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, readHistoryEntries, PmClient } from '@unbrained/pm-cli/sdk';
import { consolidate, exportDir, importDir, recall, remember, verify } from '../index.ts';
import { privacy } from '../src/core.ts';
import { contradicts, proposals } from '../src/consolidate.ts';
import { Store } from '../src/store.ts';
import { rank } from '../src/memory.ts';
import { checkClaim, directoryEvidence, searchClaims } from '../src/verify.ts';
import { tracker, snapshot } from './helpers.ts';

// Each scanner must finish under an independent operating-system deadline.
for (const [label, input] of [['URL', 'http://!:' + '!:'.repeat(50000)], ['base64 email', 'aB+/'.repeat(50000)], ['JWT header', 'eyJ-'.repeat(50000)]]) test(`privacy scans adversarial ${label} characters within a fixed time bound`, { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./privacy-process.ts', import.meta.url))]);
  t.after(() => { child.kill('SIGKILL'); });
  const elapsed = await new Promise<number>((resolve, reject) => {
    let output = ''; let ready = false;
    const expire = () => { child.kill('SIGKILL'); reject(new Error('Adversarial scan exceeded its process deadline')); };
    let timer = setTimeout(expire, 15000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (!ready && output.includes('ready\n')) {
        ready = true; clearTimeout(timer); timer = setTimeout(expire, 2000); child.stdin.end(input);
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(Number(output.trim().split('\n').at(-1))); else reject(new Error('Adversarial scan process failed')); });
  });
  assert.ok(elapsed < 500, 'privacy scan exceeded 500ms');
  assert.throws(() => privacy('https://synthetic:fake000000000000@service.test/path'), /Credential/);
  privacy('https://service.test/path'); privacy('http://service.test:8000'); privacy('https://user@service.test', true);
});

/** Every raw remember field is scanned before schema registration or tracker writes. */
test('remember refuses quoted credentials in every field without persisting them', async t => {
  const { options } = await tracker(t); const before = await snapshot(options.workspace);
  const credential = 'password="synthetic-credential"';
  await assert.rejects(remember(credential, { ...options, kind: 'project' }), /Credential/);
  for (const field of ['why', 'how', 'slug', 'update'] as const) await assert.rejects(remember('Safe guidance', { ...options, kind: 'project', [field]: credential }), /Credential/);
  for (const field of ['tags', 'links'] as const) await assert.rejects(remember('Safe guidance', { ...options, kind: 'project', [field]: [credential] }), /Credential/);
  assert.deepEqual(await snapshot(options.workspace), before);
});

/** Archived facts cannot block new active facts, and exact-key revision explicitly reopens them. */
test('canceled duplicates do not block new memory and exact slug reuse reopens', async t => {
  const { options, store } = await tracker(t);
  const original = await remember('Retain reliable build context', { ...options, kind: 'project', slug: 'old' });
  await store.client.update(original.id, { status: 'canceled', closeReason: 'Synthetic archive' });
  await remember('Retain reliable build context', { ...options, kind: 'project', slug: 'replacement' });
  const reopened = await remember('Revised old context', { ...options, kind: 'feedback', update: 'old' });
  assert.equal(reopened.id, original.id); assert.equal((await store.read()).find(item => item.id === original.id)!.status, 'open');
  assert.ok((await recall('revised', options)).memories!.some(item => item.slug === 'old'));
});

/** Subject identity is required in addition to shared broad headings and opposite action words. */
test('consolidation requires matching subjects and retains active merge targets', async t => {
  const { options, store } = await tracker(t); await remember('Policy fixture', { ...options, kind: 'project', slug: 'base' });
  const base = (await store.read())[0];
  assert.equal(contradicts({ ...base, body: 'Enable audit logging' }, { ...base, body: 'Disable unsafe mode' }), false);
  assert.equal(contradicts({ ...base, body: 'Audit logging required' }, { ...base, body: 'Unsafe mode forbidden' }), false);
  assert.equal(contradicts({ ...base, body: 'Enable audit logging' }, { ...base, body: 'Disable audit logging' }), true);
  const older = { ...base, slug: 'older', updated: '2020-01-01', body: 'Retain the same build context' };
  const target = { ...older, slug: 'target', updated: '2021-01-01', verdict: 'stale' as const, reason: 'missing path src/removed.ts under roots' };
  const planned = proposals([older, target]);
  assert.ok(planned.some(proposal => proposal.action === 'merge'));
  assert.ok(!planned.some(proposal => proposal.action === 'archive' && proposal.slug === 'target'));
});

/** Native operational writes must not refresh content age, merge direction or retrieval recency. */
test('semantic age survives recall and verify and advances only on changed content', async t => {
  const { root, options, store } = await tracker(t);
  const first = await remember('Feature policy\nEnable audit logging', { ...options, kind: 'project', slug: 'first' });
  const second = await remember('Feature policy\nDisable audit logging', { ...options, kind: 'project', slug: 'second', forceNew: true });
  const stale = await remember('Read `src/gone.ts`', { ...options, kind: 'project', slug: 'stale' });
  await store.fields(first.id, { changed_at: '2020-01-01T00:00:00.000Z' });
  await store.fields(second.id, { changed_at: '2021-01-01T00:00:00.000Z' });
  await store.fields(stale.id, { changed_at: '2020-01-01T00:00:00.000Z' });
  const before = (await store.read()).filter(item => item.slug !== 'stale'); const order = rank(before, 'unmatched').map(item => item.slug);
  await recall('logging', { ...options, budget: 200 }); await verify({ ...options, root });
  const rows = await store.read();
  assert.equal(rows.find(item => item.id === first.id)!.updated, before.find(item => item.id === first.id)!.updated);
  assert.deepEqual(rank(rows.filter(item => item.slug !== 'stale'), 'unmatched').map(item => item.slug), order);
  assert.ok(proposals(rows).some(proposal => proposal.action === 'supersedes' && proposal.slug === 'first' && proposal.target === 'second'));
  // A fresh verify makes an old, unused stale memory immediately eligible.
  await store.fields(stale.id, { recalls: 0 });
  assert.ok(proposals(await store.read()).some(proposal => proposal.action === 'archive' && proposal.slug === 'stale'));
  await remember('Feature policy\nEnable audit logging', { ...options, kind: 'project', update: 'first' });
  assert.equal((await store.read()).find(item => item.id === first.id)!.updated, before.find(item => item.id === first.id)!.updated);
  await remember('Changed audit retention guidance', { ...options, kind: 'project', update: 'first' });
  assert.ok((await store.read()).find(item => item.id === first.id)!.updated > '2021');
});

/** Replay a receipt captured from a real merge, then exercise a failed cancellation using filesystem permissions. */
test('merge receipts resume after body publication without duplicate appends', { skip: process.getuid?.() === 0 ? 'root ignores permission bits' : false }, async t => {
  const { options, store, workspace } = await tracker(t);
  const older = await remember('Repeated build guidance', { ...options, kind: 'project', slug: 'old' });
  const target = await remember('Repeated build guidance', { ...options, kind: 'project', slug: 'new', forceNew: true });
  await consolidate({ ...options, apply: true });
  const history = await readFile(getHistoryPath(workspace, older.id), 'utf8');
  assert.ok(history.includes('memory_merge'), history);
  const events = await readHistoryEntries(getHistoryPath(workspace, older.id), older.id);
  const receipt = events.flatMap(entry => entry.patch).find(op => op.path.endsWith('/memory_merge') && 'value' in op && typeof op.value === 'string' && op.value !== '');
  assert.ok(receipt && 'value' in receipt && typeof receipt.value === 'string', JSON.stringify(events));
  await store.fields(older.id, { merge: receipt.value });
  await store.client.update(older.id, { status: 'open' });
  const body = String((await store.client.get(target.id, { full: true })).item.body);
  const pending = await consolidate(options); assert.ok(pending.proposals.some(proposal => proposal.slug === 'old' && proposal.target === 'new'));
  const directory = join(workspace, 'knowledge'); await chmod(directory, 0o500);
  try { await assert.rejects(consolidate({ ...options, apply: true })); } finally { await chmod(directory, 0o700); }
  await consolidate({ ...options, apply: true });
  assert.equal(String((await store.client.get(target.id, { full: true })).item.body), body);
  assert.equal((await store.read()).find(item => item.id === older.id)!.status, 'canceled');
  assert.equal((await store.read()).find(item => item.id === older.id)!.merge, '');
});

/** Export indexes track actual emitted paths and current lifecycle across imported and native facts. */
test('exports refresh stale indexes, nested paths and canceled imported facts', async t => {
  const { root, options, store } = await tracker(t); const source = join(root, 'source'); await mkdir(join(source, 'nested'), { recursive: true });
  await writeFile(join(source, 'MEMORY.md'), '- [obsolete](obsolete.md)\n');
  await writeFile(join(source, 'nested/standing.md'), '---\nname: Standing guidance\n---\nRetain context.');
  await importDir(source, { ...options, from: 'claude-code' });
  const native = await remember('New memory context', { ...options, kind: 'project', slug: 'native' });
  const out = join(root, 'out'); await exportDir(out, { ...options, to: 'claude-code' });
  const index = await readFile(join(out, 'MEMORY.md'), 'utf8');
  assert.match(index, /\(nested\/standing.md\)/); assert.match(index, /\(native.md\)/); assert.doesNotMatch(index, /obsolete/);
  const imported = (await store.read()).find(item => item.slug === 'nested-standing')!;
  await store.client.update(imported.id, { status: 'canceled', closeReason: 'Synthetic archive' });
  await store.client.update(native.id, { status: 'canceled', closeReason: 'Synthetic native archive' });
  const archived = join(root, 'archived'); await exportDir(archived, { ...options, to: 'claude-code' });
  await assert.rejects(readFile(join(archived, 'nested/standing.md')), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(join(archived, 'MEMORY.md'), 'utf8'), /standing|native/);
  const agentsSource = join(root, 'agents'); await mkdir(agentsSource); await writeFile(join(agentsSource, 'AGENTS.md'), '# Standing context\nExisting guidance.\n');
  const next = await tracker(t); await importDir(agentsSource, { ...next.options, from: 'agents-md' });
  await remember('New native instructions', { ...next.options, kind: 'feedback', slug: 'added' });
  const agentsOut = join(root, 'agents-out'); await exportDir(agentsOut, { ...next.options, to: 'agents-md' });
  assert.match(await readFile(join(agentsOut, 'AGENTS.md'), 'utf8'), /Existing guidance/);
  assert.match(await readFile(join(agentsOut, 'AGENTS.md'), 'utf8'), /New native instructions/);
});

/** Planning refuses all conflicts before directory creation; publication failures leave no destination. */
test('refused and failed exports leave filesystem snapshots intact', async t => {
  const { root, options, store } = await tracker(t);
  await remember('First export fixture', { ...options, kind: 'reference', slug: 'first' });
  const second = await remember('Second export fixture', { ...options, kind: 'reference', slug: 'second' });
  const out = join(root, 'out'); await mkdir(out); await writeFile(join(out, 'AGENTS.md'), 'conflicting bytes');
  const before = await snapshot(root); await assert.rejects(exportDir(out, { ...options, to: 'agents-md' })); assert.deepEqual(await snapshot(root), before);
  const empty = join(root, 'empty-export'); await mkdir(empty);
  await exportDir(empty, { ...options, to: 'claude-code' });
  assert.match(await readFile(join(empty, 'MEMORY.md'), 'utf8'), /first.md/);
  const occupied = join(root, 'occupied'); await mkdir(occupied); await writeFile(join(occupied, 'unrelated.txt'), 'retain');
  const occupiedBefore = await snapshot(occupied);
  await assert.rejects(exportDir(occupied, { ...options, to: 'claude-code' }), /nonempty directory/);
  assert.deepEqual(await snapshot(occupied), occupiedBefore);
  // A parent/file name collision fails partway through staging, exercising cleanup of already written bytes.
  const first = (await store.read()).find(item => item.slug === 'first')!;
  await store.fields(first.id, { source: 'claude-code:relative-file', path: 'one.md', original: Buffer.from(first.body).toString('base64'), edited: false });
  await store.fields(second.id, { source: 'claude-code:relative-file', path: 'one.md/nested.md', original: Buffer.from('Second export fixture').toString('base64'), edited: false });
  const beforeFailure = await readdir(root);
  await assert.rejects(exportDir(join(root, 'failed'), { ...options, to: 'claude-code' }));
  assert.deepEqual(await readdir(root), beforeFailure);
});

/** Search uses indexed files, streams chunk boundaries, ignores exported prose and refuses incomplete evidence. */
test('in-process verification needs no PATH tools and honors byte and file bounds', async t => {
  const { root, options } = await tracker(t); await writeFile(join(root, 'source.ts'), ' '.repeat(65530) + 'crossChunkSymbol() --custom-option');
  await remember('Use `source.ts` crossChunkSymbol() --custom-option', { ...options, kind: 'project', slug: 'source' });
  const prior = process.env.PATH; process.env.PATH = ''; t.after(() => { process.env.PATH = prior; });
  assert.equal((await verify({ ...options, root })).results[0].verdict, 'verified');
  const source = { roots: [root], files: [['source.ts']], directories: [[]], suffixes: new Map<string, string>(), matches: undefined as Map<string, boolean | undefined> | undefined };
  await searchClaims([{ type: 'symbol', value: 'absent()' }], source, 1); assert.equal(source.matches!.get('absent'), undefined);
  await searchClaims([{ type: 'symbol', value: 'absent()' }], source, 1000000, 1); assert.equal(source.matches!.get('absent'), undefined);
  await searchClaims([{ type: 'flag', value: '-' }], source); assert.equal(source.matches!.get('-'), true);
  await assert.rejects(directoryEvidence(root, 0), /bounded search limit/);
  assert.ok((await directoryEvidence(root)).includes('.agents'));
  const regularOnly = join(root, 'regular-only'); await mkdir(regularOnly); await writeFile(join(regularOnly, 'only.ts'), 'source');
  await assert.rejects(directoryEvidence(regularOnly, 0), /bounded search limit/);
});

/** Permission failures are reported explicitly when directory traversal is denied. */
test('directory evidence rejects unreadable directories', { skip: process.getuid?.() === 0 ? 'root ignores permission bits' : false }, async t => {
  const { root } = await tracker(t);
  const denied = join(root, 'denied'); await mkdir(denied); await chmod(denied, 0);
  try { await assert.rejects(directoryEvidence(denied), /could not be read/); } finally { await chmod(denied, 0o700); }
});

/** Permission failures cannot be mistaken for evidence that a source symbol is absent. */
test('source search rejects unreadable files', { skip: process.getuid?.() === 0 ? 'root ignores permission bits' : false }, async t => {
  const { root } = await tracker(t); await writeFile(join(root, 'source.ts'), 'crossChunkSymbol()');
  const source: Parameters<typeof searchClaims>[1] = { roots: [root], files: [['source.ts']], directories: [[]], suffixes: new Map() };
  await chmod(join(root, 'source.ts'), 0);
  try { await assert.rejects(searchClaims([{ type: 'symbol', value: 'absent()' }], source), /could not be read/); } finally { await chmod(join(root, 'source.ts'), 0o600); }
});

/** Exported harness text is never independent evidence that a source symbol still exists. */
test('verification excludes every harness export convention from source evidence', async t => {
  const { root } = await tracker(t); await writeFile(join(root, 'source.ts'), 'export const current = true;');
  await mkdir(join(root, 'memories')); await mkdir(join(root, 'nested'));
  for (const name of ['AGENTS.md', 'MEMORY.md', 'native.md', 'nested/imported.md', 'memories/note.md', 'rules.mdc']) await writeFile(join(root, name), 'removedSymbol() --removed-option');
  const result = await checkClaim({ type: 'symbol', value: 'removedSymbol()', context: 'source.ts' }, root, false);
  assert.equal(result.verdict, 'stale'); assert.match(result.reason!, /symbol absent/);
  const missing = await checkClaim({ type: 'file', value: 'src/gone.ts' }, root, false);
  assert.match(missing.reason!, /not found under the given roots \(add --root if it lives elsewhere\)/);
});

/** Real injected SDK clients keep identity precedence across default, explicit and per-call paths. */
test('in-process injected client keeps author precedence and content-only timestamps', async t => {
  const { workspace, options, root, store } = await tracker(t);
  const client = new PmClient({ pmRoot: workspace, author: 'host-fallback', noExtensions: true });
  const prior = process.env.PM_AUTHOR; process.env.PM_AUTHOR = 'environment-agent';
  t.after(() => { if (prior === undefined) delete process.env.PM_AUTHOR; else process.env.PM_AUTHOR = prior; });
  const injected = { workspace, client };
  const first = await remember('Injected attribution fixture', { ...injected, kind: 'project', slug: 'injected', tags: ['context'] });
  const history = await readHistoryEntries(getHistoryPath(workspace, first.id), first.id);
  assert.ok(history.every(entry => entry.author === 'environment-agent'));
  const rebound = new Store(injected); assert.ok(await rebound.client.run('list'));
  await rebound.client.run('update', { id: first.id, author: 'per-call-agent', options: { description: 'A new hook' } });
  assert.equal((await readHistoryEntries(getHistoryPath(workspace, first.id), first.id)).at(-1)!.author, 'per-call-agent');
  await remember('Injected attribution fixture', { ...injected, kind: 'project', update: 'injected', tags: ['context'] });
  const beforeTags = (await store.read()).find(item => item.id === first.id)!.updated;
  await remember('Injected attribution fixture', { ...injected, kind: 'project', update: 'injected', tags: ['context'] });
  assert.equal((await store.read()).find(item => item.id === first.id)!.updated, beforeTags);
  await remember('Injected attribution fixture', { ...injected, kind: 'project', update: 'injected', tags: ['revised'] });
  assert.ok((await store.read()).find(item => item.id === first.id)!.updated > beforeTags);
  const source = join(root, 'format.md'); await writeFile(source, '---\nname: Formatting fixture\n---\nUnchanged semantic guidance.\n');
  await importDir(source, { ...options, from: 'claude-code' });
  const imported = (await store.read()).find(item => item.slug === 'format')!;
  await store.fields(imported.id, { changed_at: '2020-01-01T00:00:00.000Z' });
  await writeFile(source, '---\nname: "Formatting fixture"\n---\nUnchanged semantic guidance.\n');
  assert.equal((await importDir(source, { ...options, from: 'claude-code' })).updated, 1);
  assert.equal((await store.read()).find(item => item.id === imported.id)!.updated, '2020-01-01T00:00:00.000Z');
});
