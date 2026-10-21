import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { digest, packetTokens } from '../src/core.ts';
import { cosine, embeddingInput, embeddingText, LexicalProvider, memoryVectors, OllamaProvider, semanticFailure, semanticMode, validateVectors } from '../src/embeddings.ts';
import type { EmbeddingProvider } from '../src/embeddings.ts';
import { hybridScored, recall, remember, scored } from '../src/memory.ts';
import { consolidate, semanticProposals } from '../src/consolidate.ts';
import { benchmark, fixtureMemories, metrics, runBench } from '../scripts/bench.ts';
import type { RecallFixture } from '../scripts/bench.ts';
import { tracker, snapshot } from './helpers.ts';

/** An invented local protocol fixture; native tracker and SDK calls remain real. */
async function daemon(t: TestContext) {
  const state = { invalidJson: false, status: 200, redirect: false, delay: 0, payload: undefined as unknown, tags: { models: [{ name: 'test:local', digest: 'a'.repeat(64) }] } as unknown, inputs: [] as string[][], embed: (inputs: string[]) => inputs.map(input => /other|banana/i.test(input) ? [0, 1, 0] : /OIDC|registry|ship a release|federated publication/i.test(input) ? [1, 0, 0] : [0, 0, 1]) };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (state.delay > 0) await new Promise(resolve => { setTimeout(resolve, state.delay); });
    res.statusCode = state.redirect ? 302 : state.status;
    res.setHeader('Location', 'http://192.0.2.1/forbidden');
    if (state.invalidJson) res.end('{invalid');
    else if (req.url === '/api/tags') res.end(JSON.stringify(state.tags));
    else {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[]; truncate: boolean; model: string; keep_alive: string };
      assert.equal(req.url, '/api/embed'); assert.equal(body.truncate, false); assert.equal(body.model, 'test:local'); assert.equal(body.keep_alive, '5m');
      state.inputs.push(body.input); res.end(JSON.stringify(state.payload ?? { embeddings: state.embed(body.input) }));
    }
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  return { state, endpoint, provider: new OllamaProvider('test:local', endpoint) };
}
/** Launch a real process asynchronously so the local fixture can answer requests. */
async function child(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const process = spawn(globalThis.process.execPath, args, { env, cwd });
  let stdout = ''; let stderr = '';
  process.stdout.on('data', chunk => { stdout += String(chunk); }); process.stderr.on('data', chunk => { stderr += String(chunk); });
  const status = await new Promise<number | null>(resolve => { process.on('close', resolve); });
  return { status, stdout, stderr };
}
/** Small independent relevance example used by metrics and deterministic rank tests. */
const fixture: RecallFixture = { memories: [{ slug: 'oidc', title: 'npm trusted publishing OIDC', body: 'Use the registry identity workflow' }, { slug: 'other', title: 'other ship a release', body: 'banana unrelated discussion' }], queries: [{ query: 'how do we ship a release', gold: ['oidc'] }] };

test('local adapter validates loopback, installed model identity and vector protocol', async t => {
  const { state, endpoint, provider } = await daemon(t);
  assert.match(await provider.identity(), /ollama:v2:test:local:a{64}/);
  assert.deepEqual(await provider.embed(['OIDC', 'banana']), [[1, 0, 0], [0, 1, 0]]);
  const direct = new OllamaProvider('test:local', endpoint);
  assert.deepEqual(await direct.embed(['OIDC']), [[1, 0, 0]]);
  state.tags = { models: [{ name: 'test:local', digest: 'b'.repeat(64) }] };
  const sent = state.inputs.length;
  await assert.rejects(direct.embed(['not sent after retagging']), /changed during operation/);
  state.tags = { models: [{ name: 'test:local', digest: 'a'.repeat(64), remote_host: 'cloud' }] };
  await assert.rejects(new OllamaProvider('test:local', endpoint).embed(['not sent to a cloud alias']));
  assert.equal(state.inputs.length, sent);
  state.tags = { models: [{ name: 'test:local', digest: 'a'.repeat(64) }] };

  assert.equal(new OllamaProvider('test:local', endpoint.replace('127.0.0.1', 'localhost')).endpoint, endpoint);
  assert.equal(new OllamaProvider('test:local', 'http://[::1]:11434').endpoint, 'http://[::1]:11434');
  for (const url of ['https://127.0.0.1', 'http://192.0.2.1', 'http://user@127.0.0.1', 'http://:pass@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?x=1', 'http://127.0.0.1#x']) assert.throws(() => new OllamaProvider('test:local', url));
  for (const tags of [{}, { models: [] }, { models: [{ name: 'test:local', digest: 1 }] }, { models: [{ name: 'test:local', digest: 'bad' }] }, { models: [{ name: 'test:local', digest: 'a'.repeat(64), remote_host: 'cloud' }] }, { models: [{ name: 'test:local', digest: 'a'.repeat(64), remote_model: 'remote' }] }]) {
    state.tags = tags; await assert.rejects(provider.identity());
  }
  state.tags = { models: [{ name: 'test:cloud', digest: 'a'.repeat(64) }] }; await assert.rejects(new OllamaProvider('test:cloud', endpoint).identity());
  state.invalidJson = true; await assert.rejects(provider.identity()); state.invalidJson = false;
  state.status = 503; await assert.rejects(provider.embed(['x']));
  state.status = 200; state.redirect = true; await assert.rejects(provider.identity());
  state.redirect = false; state.delay = 30; await assert.rejects(new OllamaProvider('test:local', endpoint, 1).identity());
  assert.equal(new OllamaProvider().model, process.env.PM_MEMORY_MODEL ?? 'embeddinggemma-2:latest');
});

test('vector validation rejects corrupt, zero, non-finite and inconsistent dimensions', () => {
  for (const value of [undefined, null, {}, [], [null], [[]], [[0, 0]], [['x']], [[NaN]], [[Infinity]], [[Number.MAX_VALUE, Number.MAX_VALUE]]]) assert.throws(() => validateVectors(value, 1));
  assert.throws(() => validateVectors([[1], [1, 2]], 2));
  assert.deepEqual(validateVectors([], 0), []);
  assert.equal(cosine([1, 0], [1, 0]), 1); assert.equal(cosine([1, 0], [-1, 0]), -1); assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(embeddingInput('embeddinggemma-2:latest', 'question', 'query'), 'task: search result | query: question');
  assert.equal(embeddingInput('embeddinggemma-2:latest', 'document', 'document'), 'title: none | text: document');
  assert.match(embeddingInput('qwen3-embedding:local', 'question', 'query'), /Instruct:.*\nQuery:question/);
  assert.equal(embeddingInput('qwen3-embedding:local', 'document', 'document'), 'document');
  assert.equal(embeddingInput('other', 'question', 'query'), 'question');
  assert.equal(semanticMode(), 'off'); for (const mode of ['auto', 'on', 'off'] as const) assert.equal(semanticMode(mode), mode);
  assert.throws(() => semanticMode('onn')); assert.throws(() => semanticFailure('on'), /unavailable/); assert.match(semanticFailure('auto'), /lexical/);
});

test('content hashes reuse vectors across counter writes and rebuild for edits and model revisions', async t => {
  const { workspace } = await tracker(t); const { state, provider } = await daemon(t);
  const memories = fixtureMemories(fixture);
  const initial = await memoryVectors(memories, workspace, provider); assert.equal(state.inputs.flat().length, 2);
  assert.equal(await readFile(join(workspace, 'runtime', 'memory-embeddings', '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(await memoryVectors(memories, workspace, provider), initial); assert.equal(state.inputs.flat().length, 2);
  memories[0].recalls++; memories[0].updated = '2026-01-02'; memories[0].verdict = 'verified';
  await memoryVectors(memories, workspace, provider); assert.equal(state.inputs.flat().length, 2);
  memories[0].body += ' changed content'; await memoryVectors(memories, workspace, provider); assert.equal(state.inputs.flat().length, 3);
  const directory = join(workspace, 'runtime', 'memory-embeddings', digest(await provider.identity()));
  const cache = join(directory, `${digest(embeddingText(memories[0]))}.json`);
  await writeFile(cache, 'broken json'); await memoryVectors(memories, workspace, provider); assert.equal(state.inputs.flat().length, 4);
  await writeFile(cache, '[0,0]'); await memoryVectors(memories, workspace, provider); assert.equal(state.inputs.flat().length, 5);
  state.tags = { models: [{ name: 'test:local', digest: 'b'.repeat(64) }] };
  await memoryVectors(memories, workspace, provider); assert.equal(state.inputs.flat().length, 7);
  assert.equal(await memoryVectors(memories, workspace, new LexicalProvider()), undefined);
  assert.deepEqual(await new LexicalProvider().embed(['one', 'two']), [[], []]);
  await memoryVectors(Array.from({ length: 17 }, (_, index) => ({ ...memories[0], slug: `batch-${index}` })), workspace, provider);
  assert.deepEqual(state.inputs.slice(-2).map(batch => batch.length), [16, 1]);
});

test('failed cache publication cleans temporary files and auto falls back without changing lexical scores', async t => {
  const { workspace } = await tracker(t); const { provider, state } = await daemon(t); const memories = fixtureMemories(fixture);
  const directory = join(workspace, 'runtime', 'memory-embeddings', digest(await provider.identity()));
  const cache = join(directory, `${digest(embeddingText(memories[0]))}.json`);
  const original = state.embed;
  // Create a destination directory to force atomic rename refusal, even for privileged runners.
  await mkdir(cache, { recursive: true });
  const result = await hybridScored(memories, fixture.queries[0].query, { workspace, provider, semantic: 'auto' });
  assert.match(result.note!, /using lexical/); assert.deepEqual(result.rows.map(row => row.item.slug), ['other', 'oidc']);
  assert.deepEqual((await readdir(directory)).filter(name => name.includes('.json.')), []);
  await rm(cache, { recursive: true }); state.embed = original;
  state.payload = { embeddings: [[1]] }; await assert.rejects(hybridScored(memories, 'x', { workspace, provider, semantic: 'on' }), /Local embedding model unavailable/);
});

test('hybrid ranking promotes paraphrases while off and unavailable providers preserve lexical output', async t => {
  const instant = Date.now(); t.mock.method(Date, 'now', () => instant);
  const { workspace } = await tracker(t); const { provider, state } = await daemon(t); const memories = fixtureMemories(fixture);
  const options = { workspace, provider, semantic: 'on' as const };
  const hybrid = await hybridScored(memories, fixture.queries[0].query, options); assert.equal(hybrid.rows[0].item.slug, 'oidc'); assert.equal(hybrid.note, undefined);
  assert.ok(hybrid.rows.every(row => row.score >= 0 && row.score <= 1));
  const off = await hybridScored(memories, 'release', { ...options, semantic: 'off' });
  assert.deepEqual(off.rows, scored(memories, 'release'));
  assert.deepEqual((await hybridScored([], 'x', options)).rows, []);
  const fallback = await hybridScored(memories, 'release', { ...options, semantic: 'auto', provider: new LexicalProvider() });
  assert.deepEqual(fallback.rows, scored(memories, 'release')); assert.match(fallback.note!, /lexical/);
  await assert.rejects(hybridScored(memories, 'x', { ...options, provider: new LexicalProvider() }));
  const negative: EmbeddingProvider = { identity: async () => 'negative', embed: async inputs => inputs.map(input => input === 'query' ? [-1, 0] : [1, 0]) };
  const equal = memories.map(memory => ({ ...memory, title: '', slug: memory.slug, body: '', updated: 'invalid' }));
  // A far-future timestamp underflows the age prior to zero, reaching zero lexical normalization.
  t.mock.method(Date, 'now', () => Infinity);
  try { const zero = await hybridScored(memories, 'query', { ...options, provider: negative }); assert.equal(zero.rows[0].score, 0); }
  finally { t.mock.restoreAll(); }
  state.payload = { embeddings: [[1, 0]] };
  await assert.rejects(hybridScored(memories, 'x', options));
  const tie = await hybridScored([...equal].reverse().map(memory => ({ ...memory, updated: '2026-01-01' })), 'none', { ...options, provider: { identity: async () => 'tie', embed: async inputs => inputs.map(() => [1]) } });
  assert.deepEqual(tie.rows.map(row => row.item.slug), ['oidc', 'other']);
});

test('real tracker semantic recall keeps token and omission receipts plus emitted-only counters', async t => {
  const { options, store, workspace } = await tracker(t); const { provider, state } = await daemon(t);
  await remember('npm trusted publishing OIDC', { ...options, kind: 'reference', slug: 'oidc' });
  await remember('other ship a release', { ...options, kind: 'project', slug: 'other' });
  for (const limit of [200, 800]) {
    const packet = await recall('how do we ship a release', { ...options, provider, semantic: 'on', budget: limit });
    assert.equal(packet.memories![0].slug, 'oidc'); assert.equal(packet.omitted + packet.memories!.length, 2);
    assert.ok(packetTokens(packet) <= limit); assert.equal(packet.estimated_tokens, packetTokens(packet));
  }
  state.status = 503;
  const packet = await recall('release', { ...options, provider, semantic: 'auto', budget: 200 });
  assert.match(packet.note!, /^[^\n]*lexical[^\n]*$/); assert.ok(packetTokens(packet) <= 200);
  const lexical = await recall('release', { ...options, semantic: 'off', budget: 200 }); assert.equal(lexical.note, undefined);
  const filtered = await recall('release', { ...options, provider, semantic: 'auto', kind: 'reference' }); assert.equal(filtered.memories!.length, 1);
  const total = (await store.read()).reduce((sum, memory) => sum + memory.recalls, 0);
  assert.equal(total, 2 * 2 + packet.memories!.length + lexical.memories!.length + 1);
  await assert.rejects(recall('release', { workspace, provider, semantic: 'on' }), /unavailable/);
});

test('semantic consolidation shares vectors, is advisory and refuses apply before writes', async t => {
  const { options, workspace, store } = await tracker(t); const { provider, state } = await daemon(t);
  await remember('npm trusted publishing OIDC', { ...options, kind: 'reference', slug: 'first' });
  await remember('Federated publication uses registry identity', { ...options, kind: 'reference', slug: 'second' });
  await remember('Other banana', { ...options, kind: 'project', slug: 'other' });
  const before = await snapshot(workspace);
  const result = await consolidate({ ...options, provider, semantic: 'on' }); assert.equal(result.applied, false);
  assert.equal(result.proposals.length, 1); assert.equal(result.proposals[0].previewOnly, true); assert.match(result.proposals[0].reason, /dry-run only/);
  assert.deepEqual(await snapshot(workspace), before);
  const calls = state.inputs.length; await consolidate({ ...options, provider, semantic: 'on' }); assert.equal(state.inputs.length, calls);
  await assert.rejects(consolidate({ ...options, provider, semantic: 'auto', apply: true }), /dry-run only/); assert.deepEqual(await snapshot(workspace), before);
  assert.deepEqual(await semanticProposals(await store.read(), options), { proposals: [] });
  assert.match((await consolidate({ ...options, provider: new LexicalProvider(), semantic: 'auto' })).note!, /lexical/);
  await assert.rejects(semanticProposals(await store.read(), { ...options, provider: new LexicalProvider(), semantic: 'on' }));
  state.status = 503; assert.match((await semanticProposals(await store.read(), { ...options, provider, semantic: 'auto' })).note!, /lexical/);
  state.status = 200;
  await remember('Identical registry OIDC guidance', { ...options, kind: 'reference', slug: 'duplicate-one' });
  await remember('Identical registry OIDC guidance', { ...options, kind: 'reference', slug: 'duplicate-two', forceNew: true });
  const duplicatePreview = await consolidate({ ...options, provider, semantic: 'on' });
  const pair = duplicatePreview.proposals.filter(proposal => [proposal.slug, proposal.target].sort().join(':') === 'duplicate-one:duplicate-two');
  assert.equal(pair.length, 1); assert.equal(pair[0].previewOnly, undefined);

});

test('benchmark corpus is public synthetic, sufficiently large, and metrics include misses and multiple golds', async t => {
  const corpus = JSON.parse(await readFile(new URL('../bench/recall.json', import.meta.url), 'utf8')) as RecallFixture;
  assert.ok(corpus.memories.length >= 60); assert.ok(corpus.queries.length >= 40);
  assert.equal(new Set(corpus.memories.map(memory => memory.slug)).size, corpus.memories.length);
  for (const query of corpus.queries) { assert.ok(query.gold.length > 0); for (const slug of query.gold) assert.ok(corpus.memories.some(memory => memory.slug === slug)); }
  const values = metrics([['a', 'b'], ['miss'], ['x', 'a']], [{ query: 'x', gold: ['a', 'b'] }, { query: 'y', gold: ['a'] }, { query: 'z', gold: ['a'] }]);
  assert.equal(values.recallAt1, 1 / 6); assert.equal(values.recallAt5, 2 / 3); assert.equal(values.mrr, 0.5);
  const { workspace } = await tracker(t); const { provider } = await daemon(t);
  const result = await benchmark(fixture, workspace, provider); assert.equal(result.lexical.recallAt1, 0); assert.equal(result.hybrid.recallAt1, 1);
  assert.equal(result.ranks[0].lexical, 2); assert.equal(result.ranks[0].hybrid, 1);
  const fallback = await benchmark(fixture, workspace, new LexicalProvider(), true); assert.deepEqual(fallback.lexical, fallback.hybrid); assert.equal(fallback.mode, 'lexical-fallback');
  const log = console.log; const output: string[] = []; console.log = value => { output.push(String(value)); };
  try {
    await runBench(['--lexical-only']);
    t.mock.method(OllamaProvider.prototype, 'identity', async () => 'fixture-cli-model');
    t.mock.method(OllamaProvider.prototype, 'embed', async (inputs: readonly string[]) => inputs.map(() => [1]));
    await runBench([]);
  } finally { console.log = log; t.mock.restoreAll(); }
  assert.equal(JSON.parse(output[0]).mode, 'lexical-fallback'); assert.equal(JSON.parse(output[1]).mode, 'hybrid');
  const executable = await child([join(import.meta.dirname, '../scripts/bench.ts'), '--lexical-only'], process.env, join(import.meta.dirname, '..'));
  assert.equal(executable.status, 0, executable.stderr); assert.equal(JSON.parse(executable.stdout).queries, 64);
});

test('non-git process runs real SDK semantic recall with no git executable and native CLI flags degrade clearly', async t => {
  const { workspace, root, options } = await tracker(t); const { endpoint } = await daemon(t);
  await remember('npm trusted publishing OIDC', { ...options, kind: 'reference', slug: 'oidc' });
  const noGit = join(root, 'empty-path'); await mkdir(noGit);
  const env = { ...process.env, PATH: noGit, GIT_CEILING_DIRECTORIES: dirname(root), PM_PATH: workspace, PM_AUTHOR: 'memory-test', PM_MEMORY_MODEL: 'pm-memory-test:missing' };
  const processFile = join(import.meta.dirname, 'semantic-process.ts');
  const direct = await child([processFile, workspace, endpoint], env, root); assert.equal(direct.status, 0, direct.stderr); assert.equal(JSON.parse(direct.stdout).memories[0].slug, 'oidc');
  const extension = join(workspace, 'extensions', 'pm-memory'); await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ name: 'pm-memory', version: '2026.10.19', entry: 'entry.js', capabilities: ['commands', 'schema'] }));
  await writeFile(join(extension, 'entry.js'), `export { default } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};\n`);
  const cli = join(import.meta.dirname, '../node_modules/.bin/pm');
  for (const mode of ['auto', 'off']) {
    const result = await child([cli, 'memory', 'recall', 'release', '--semantic', mode, '--budget', '200', '--json'], env, root);
    assert.equal(result.status, 0, result.stderr); const packet = JSON.parse(result.stdout); assert.ok(packetTokens(packet) <= 200);
    assert.equal(packet.note !== undefined, mode === 'auto');
  }
  for (const args of [['recall', 'x', '--semantic', 'onn'], ['recall', 'x', '--semantic', 'on'], ['consolidate', '--semantic', 'on', '--apply']]) {
    const result = await child([cli, 'memory', ...args], env, root); assert.equal(result.status, 2, result.stderr); assert.match(result.stderr + result.stdout, /semantic|Semantic/);
  }
  const preview = await child([cli, 'memory', 'consolidate', '--semantic', 'auto', '--json'], env, root); assert.equal(preview.status, 0, preview.stderr); assert.match(JSON.parse(preview.stdout).note, /lexical/);
});
