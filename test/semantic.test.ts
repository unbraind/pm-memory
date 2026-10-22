import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Store } from '../src/store.ts';
import { digest, packetTokens } from '../src/core.ts';
import { cosine, unitCosine, embeddingInput, embeddingText, LexicalProvider, memoryVectors, OllamaProvider, semanticFailure, semanticMode, validateVectors } from '../src/embeddings.ts';
import type { EmbeddingProvider } from '../src/embeddings.ts';
import { HYBRID_WEIGHTS, hybridScored, recall, remember, scored } from '../src/memory.ts';
import { consolidate, semanticProposals } from '../src/consolidate.ts';
import { benchmark, fixtureMemories, metrics, runBench } from '../scripts/bench.ts';
import type { RecallFixture } from '../scripts/bench.ts';
import { testEnvironment } from '../scripts/environment.ts';
import { tracker, snapshot } from './helpers.ts';

/** An invented local protocol fixture; native tracker and SDK calls remain real. */
async function daemon(t: TestContext) {
  const state = { rejectInput: '', rejectStatus: 400, invalidJson: false, status: 200, redirect: false, delay: 0, payload: undefined as unknown, model: 'test:local', tags: { models: [{ name: 'test:local', digest: 'a'.repeat(64) }] } as unknown, inputs: [] as string[][], embed: (inputs: string[]): number[][] | Promise<number[][]> => inputs.map(input => /other|banana/i.test(input) ? [0, 1, 0] : /OIDC|registry|ship a release|federated publication/i.test(input) ? [1, 0, 0] : [0, 0, 1]) };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (state.delay > 0) await new Promise(resolve => { setTimeout(resolve, state.delay); });
    res.statusCode = state.redirect ? 302 : state.status;
    res.setHeader('Location', 'http://192.0.2.1/forbidden');
    if (state.invalidJson) res.end('{invalid');
    else if (req.url === '/api/tags') res.end(JSON.stringify(state.tags));
    else {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[]; truncate: boolean; model: string; keep_alive: string };
      assert.equal(req.url, '/api/embed'); assert.equal(body.truncate, false); assert.equal(body.model, state.model); assert.equal(body.keep_alive, '5m');
      state.inputs.push(body.input);
      if (state.rejectInput && body.input.some(input => input.includes(state.rejectInput))) { res.statusCode = state.rejectStatus; res.end(JSON.stringify({ error: 'input length exceeds context window' })); return; }
      res.end(JSON.stringify(state.payload ?? { embeddings: await state.embed(body.input) }));
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
/** Bound a concurrency assertion while callers retain responsibility for unblocking cleanup. */
async function whileEmbedding<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Writer blocked while embedding response is withheld')), 45000);
    })]);
  } finally { clearTimeout(timer!); }
}
/** Small independent relevance example used by metrics and deterministic rank tests. */
const fixture: RecallFixture = { memories: [{ slug: 'oidc', title: 'npm trusted publishing OIDC', body: 'Use the registry identity workflow' }, { slug: 'other', title: 'other ship a release', body: 'banana unrelated discussion' }], queries: [{ query: 'how do we ship a release', gold: ['oidc'] }] };

test('embedding assertion tolerates the writer wait and still bounds a blocked writer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writer = Promise.withResolvers<string>();
  let finished = false;
  const pending = whileEmbedding(writer.promise).finally(() => { finished = true; });
  // Attach rejection handling before advancing time, including during the revert proof.
  const result = pending.then(value => ({ value }), error => ({ error }));
  t.mock.timers.tick(30001);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(finished, false, 'the assertion must allow the entire 30-second writer wait');
  writer.resolve('completed');
  assert.deepEqual(await result, { value: 'completed' });
  const blocked = whileEmbedding(new Promise<never>(() => {}));
  const rejection = assert.rejects(blocked, /Writer blocked while embedding response is withheld/);
  t.mock.timers.tick(45000);
  await rejection;
});

test('local adapter bypasses environment proxies in a real child process', async t => {
  const { endpoint, state } = await daemon(t);
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', NO_PROXY: '', no_proxy: '' };
  const script = `import { OllamaProvider } from './src/embeddings.ts'; const provider = new OllamaProvider('test:local', process.argv[1]); await provider.identity(); console.log(JSON.stringify(await provider.embed(['OIDC'])));`;
  const result = await child(['--input-type=module', '-e', script, endpoint], env, join(import.meta.dirname, '..'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [[1, 0, 0]]);
  assert.deepEqual(state.inputs, [['OIDC']]);
});

test('local adapter canonicalizes untagged names including registry ports', async t => {
  const { state, endpoint } = await daemon(t);
  for (const [name, canonical] of [['embeddinggemma', 'embeddinggemma:latest'], ['namespace/model', 'namespace/model:latest'], ['localhost:5000/namespace/model', 'localhost:5000/namespace/model:latest'], ['test:local', 'test:local'], ['localhost:5000/namespace/model:v2', 'localhost:5000/namespace/model:v2']]) {
    state.model = canonical;
    state.tags = { models: [{ name: canonical, digest: 'a'.repeat(64) }] };
    const provider = new OllamaProvider(name, endpoint);
    assert.equal(provider.model, canonical);
    assert.equal(await provider.identity(), `ollama:v2:${canonical}:${'a'.repeat(64)}`);
    await provider.embed(['OIDC']);
    assert.equal(state.inputs.at(-1)!.length, 1);
  }
});

test('benchmark rejects model revisions changing between queries', async t => {
  const { workspace } = await tracker(t);
  const corpus = { ...fixture, queries: [...fixture.queries, ...fixture.queries] };
  let revision = 'first'; let queries = 0;
  const provider: EmbeddingProvider = {
    identity: async () => revision,
    embed: async (inputs, purpose) => {
      if (purpose === 'query' && ++queries === 2) revision = 'second';
      return inputs.map(() => [1, 0]);
    },
  };
  await assert.rejects(benchmark(corpus, workspace, provider), /Embedding model changed during benchmark/);
  assert.equal(queries, 2);
});

test('semantic comparisons normalize each vector once and preserve cosine proposals', async t => {
  const { workspace } = await tracker(t);
  const vectors = [[1e200, 1e200], [2e200, 2e200], [-1e200, -1e200], [1, 0], [0.9, Math.sqrt(0.19)], [0.89, Math.sqrt(1 - 0.89 ** 2)]];
  const memories = vectors.map((_vector, index) => ({ ...fixtureMemories(fixture)[0], slug: `vector-${index}` }));
  const provider: EmbeddingProvider = { identity: async () => 'norm-regression', embed: async (inputs, purpose) => inputs.map(input => purpose === 'query' ? [1, 0] : vectors[Number(input.split('\n')[0].slice('vector-'.length))]) };
  await memoryVectors(memories, workspace, provider);
  const norm = t.mock.method(Math, 'hypot');
  const preview = await semanticProposals(memories, { workspace, provider, semantic: 'on' });
  assert.ok(norm.mock.callCount() <= 5 * memories.length, 'cached validation plus one normalization per row must be linear');
  norm.mock.resetCalls();
  await hybridScored(memories, 'query', { workspace, provider, semantic: 'on' });
  assert.ok(norm.mock.callCount() <= 7 * memories.length + 5, 'recall must also reuse the query norm');
  norm.mock.restore();
  const expected = vectors.flatMap((left, i) => vectors.slice(i + 1).flatMap((right, offset) => {
    const score = cosine(left, right);
    return score >= 0.9 ? [{ action: 'merge', slug: memories[i].slug, target: memories[i + offset + 1].slug, previewOnly: true, reason: `Possible paraphrase (cosine ${score.toFixed(3)}); review meaning and contradictions; dry-run only` }] : [];
  }));
  assert.deepEqual(preview.proposals, expected);
  assert.equal(unitCosine([1, 1e-7], [1, 1e-7]), 1);
  assert.equal(unitCosine([-1, -1e-7], [1, 1e-7]), -1);
});

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
  const configured = process.env.PM_MEMORY_MODEL ?? 'embeddinggemma-2:latest';
  assert.equal(new OllamaProvider().model, configured.lastIndexOf(':') > configured.lastIndexOf('/') ? configured : `${configured}:latest`);
});

test('default model assertion accepts isolated environment model names', async () => {
  for (const model of [undefined, 'embeddinggemma', 'namespace/model', 'localhost:5000/namespace/model', 'test:local', 'localhost:5000/namespace/model:v2']) {
    const env = testEnvironment(process.env);
    if (model === undefined) delete env.PM_MEMORY_MODEL; else env.PM_MEMORY_MODEL = model;
    const result = await child(['--test', '--test-name-pattern=^local adapter validates loopback, installed model identity and vector protocol$', 'test/semantic.test.ts'], env, join(import.meta.dirname, '..'));
    assert.equal(result.status, 0, `${model ?? 'unset'}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /\bpass 1\b/);
  }
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

test('hybrid priors benchmark preserves relevance across pins and varied ages', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-21T00:00:00Z'));
  const { workspace } = await tracker(t);
  const corpus: RecallFixture = {
    memories: [
      { slug: 'relevant', title: 'Durable guidance', body: 'Alpha', updated: '2020-01-01' },
      { slug: 'pinned', title: 'Standing guidance', body: 'Beta', updated: '2026-10-21', pinned: true },
      { slug: 'distractor', title: 'Unrelated guidance', body: 'Gamma', updated: '2025-01-01' },
    ],
    queries: [{ query: 'question', gold: ['relevant'] }, { query: 'tie', gold: ['pinned'] }],
  };
  const provider: EmbeddingProvider = {
    identity: async () => 'controlled-prior-benchmark',
    embed: async (inputs, purpose) => inputs.map(input => {
      if (purpose === 'query') return input === 'tie' ? [0, 0, 1] : [1, 0, 0];
      const cosine = input.includes('Alpha') ? 0.75 : input.includes('Beta') ? 0.45 : 0.2;
      return [cosine, Math.sqrt(0.75 - cosine ** 2), 0.5];
    }),
  };
  const result = await benchmark(corpus, workspace, provider);
  assert.deepEqual(result.hybrid, { recallAt1: 1, recallAt5: 1, mrr: 1 });
  assert.deepEqual(result.ranks.map(row => row.hybrid), [1, 1]);
  assert.equal(result.weights.prior, 0.01);
  const memories = fixtureMemories(corpus);
  const lexical = scored(memories, 'question');
  assert.ok(lexical.every(row => row.lexical === 0));
  assert.equal(lexical[0].item.slug, 'pinned');
  const ranked = await hybridScored(memories, 'question', { workspace, provider, semantic: 'on' });
  for (const { item, score } of ranked.rows) {
    const cosine = item.slug === 'relevant' ? 0.75 : item.slug === 'pinned' ? 0.45 : 0.2;
    const prior = lexical.find(row => row.item.slug === item.slug)!.prior;
    assert.ok(Math.abs(score - (0.7 * cosine + 0.01 * prior)) < 1e-12);
  }
  // Perfect relevance plus a fresh pin is bounded by the documented 1.007 ceiling.
  const perfect = await hybridScored([memories[1]], 'Standing', { workspace, semantic: 'on', provider: { identity: async () => 'perfect', embed: async inputs => inputs.map(() => [1]) } });
  assert.equal(perfect.rows[0].score, 1.007);
});

test('lexical recall uses one real corpus read and critical section per call', async t => {
  const { options, store } = await tracker(t);
  await remember('Registry guidance', { ...options, kind: 'reference', slug: 'reference' });
  await remember('Other project', { ...options, kind: 'project', slug: 'project' });
  const original = Store.prototype.read;
  const reads = t.mock.method(Store.prototype, 'read', function (this: Store) { return original.call(this); });
  const writes = t.mock.method(Store.prototype, 'write');
  const provider: EmbeddingProvider = { identity: async () => { throw new Error('Lexical path must not contact a model'); }, embed: async () => { throw new Error('No embeddings'); } };
  for (const semantic of [undefined, 'off'] as const) {
    reads.mock.resetCalls(); writes.mock.resetCalls();
    const packet = await recall('registry', { ...options, semantic, provider, kind: 'reference', budget: 200 });
    assert.equal(reads.mock.callCount(), 1);
    assert.equal(writes.mock.callCount(), 1);
    assert.deepEqual(packet.memories!.map(row => row.slug), ['reference']);
    assert.equal(packet.omitted, 0); assert.equal(packet.note, undefined);
    assert.equal(packet.estimated_tokens, packetTokens(packet)); assert.ok(packetTokens(packet) <= 200);
  }
  t.mock.restoreAll();
  const memories = await store.read();
  assert.equal(memories.find(row => row.slug === 'reference')!.recalls, 2);
  assert.equal(memories.find(row => row.slug === 'project')!.recalls, 0);
});

test('semantic consolidation skips models when fewer than two active memories exist', async t => {
  const { options, store, workspace } = await tracker(t);
  let calls = 0;
  const provider: EmbeddingProvider = { identity: async () => { calls++; throw new Error('Unavailable'); }, embed: async () => { calls++; throw new Error('Unavailable'); } };
  for (const count of [0, 1]) {
    if (count === 1) await remember('Only active fact', { ...options, kind: 'reference', slug: 'only' });
    const before = await snapshot(workspace);
    for (const semantic of ['on', 'auto'] as const) {
      assert.deepEqual(await consolidate({ ...options, provider, semantic }), { applied: false, proposals: [] });
      const rows = await store.read();
      assert.deepEqual(await semanticProposals([...rows, ...fixtureMemories(fixture).map(item => ({ ...item, status: 'canceled' })), { ...fixtureMemories(fixture)[0], artifact: true }], { ...options, provider, semantic }), { proposals: [] });
    }
    assert.equal(calls, 0); assert.deepEqual(await snapshot(workspace), before);
  }
});

test('benchmark entrypoint isolates synthetic caches and cleans success and failure', async t => {
  const { root, workspace } = await tracker(t);
  const previousDirectory = process.cwd(); const previousTmp = process.env.TMPDIR;
  const before = await readdir(workspace, { recursive: true });
  const workspaces: string[] = [];
  t.mock.method(OllamaProvider.prototype, 'identity', async () => {
    const directories = (await readdir(root)).filter(name => name.startsWith('pm-memory-bench-'));
    assert.equal(directories.length, 1, 'benchmark must create a dedicated temporary workspace');
    workspaces.push(join(root, directories[0])); return 'isolated-benchmark';
  });
  const embedding = t.mock.method(OllamaProvider.prototype, 'embed', async (inputs: readonly string[]) => inputs.map(() => [1]));
  const log = t.mock.method(console, 'log', () => {});
  /** Verify that the benchmark removed its cache and left the real tracker untouched. */
  async function assertClean(): Promise<void> {
    assert.ok(workspaces.length > 0); await assert.rejects(readdir(workspaces.at(-1)!), { code: 'ENOENT' });
    assert.deepEqual(await readdir(workspace, { recursive: true }), before);
  }
  process.chdir(root); process.env.TMPDIR = root;
  try {
    await runBench([]);
    await assertClean();
    assert.equal(log.mock.callCount(), 1);
    embedding.mock.mockImplementation(async () => { throw new Error('Unavailable'); });
    const completed = workspaces.length;
    await assert.rejects(runBench([]), /Local embedding model unavailable/);
    assert.ok(workspaces.length > completed);
    await assertClean();
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('pm-memory-bench-')), []);
  } finally {
    process.chdir(previousDirectory);
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    t.mock.restoreAll();
  }
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

test('semantic preview releases the writer lock throughout every embedding batch', async t => {
  const { options, workspace, root, store } = await tracker(t); const { provider, state } = await daemon(t);
  for (let index = 0; index < 17; index++) await remember(`Registry guidance batch ${index}`, { ...options, kind: 'reference', slug: `batch-${index}`, forceNew: true });
  const lexical = await consolidate(options);
  const captured = await store.read();
  const before = await snapshot(workspace);
  let expected = before;
  const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const responses = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  state.embed = async inputs => {
    const index = state.inputs.length - 1; ready[index].resolve();
    await responses[index].promise;
    return inputs.map(() => [1, 0]);
  };
  let finished = false;
  const preview = consolidate({ ...options, provider, semantic: 'on' }).finally(() => { finished = true; });
  const writers: ReturnType<typeof child>[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      await whileEmbedding(ready[index].promise);
      assert.deepEqual(await snapshot(workspace), expected);
      const writer = child([join(import.meta.dirname, 'semantic-writer.ts'), workspace, `concurrent-${index}`], process.env, root);
      writers.push(writer);
      const result = await whileEmbedding(writer);
      assert.equal(result.status, 0, result.stderr); assert.equal(finished, false);
      assert.ok((await store.read()).some(item => item.slug === `concurrent-${index}`));
      expected = await snapshot(workspace);
      responses[index].resolve();
    }
    const result = await preview;
    assert.equal(result.applied, false); assert.equal(result.note, undefined);
    assert.deepEqual(result.proposals.filter(proposal => !proposal.previewOnly), lexical.proposals);
    assert.equal(result.proposals.length, 17 * 16 / 2);
    assert.ok(result.proposals.every(proposal => [proposal.slug, proposal.target].every(slug => captured.some(item => item.slug === slug))));
    assert.deepEqual(state.inputs.map(inputs => inputs.length), [16, 1]);
    assert.deepEqual(await snapshot(workspace), expected);
  } finally {
    for (const response of responses) response.resolve();
    await Promise.allSettled([preview, ...writers]);
  }
});

test('semantic recall releases the writer lock and retries changed snapshots without losing counters', async t => {
  const { options, workspace, root, store } = await tracker(t); const { provider, state } = await daemon(t);
  await remember('Original registry guidance', { ...options, kind: 'reference', slug: 'original' });
  const ready = Promise.withResolvers<void>(); const response = Promise.withResolvers<void>();
  const embed = state.embed;
  state.embed = async inputs => { ready.resolve(); await response.promise; return embed(inputs); };
  const pending = recall('registry', { ...options, provider, semantic: 'on', budget: 800 });
  const writers: ReturnType<typeof child>[] = [];
  try {
    await whileEmbedding(ready.promise);
    const writer = child([join(import.meta.dirname, 'semantic-writer.ts'), workspace, 'concurrent'], process.env, root); writers.push(writer);
    const result = await whileEmbedding(writer); assert.equal(result.status, 0, result.stderr);
    await whileEmbedding(remember('Revised registry guidance', { ...options, kind: 'reference', update: 'original' }));
    // The original snapshot must retry after this insertion. A concurrent lexical recall
    // also increments counters before the semantic recall commits its emitted rows.
    const lexical = await whileEmbedding(recall('registry', { ...options, budget: 800 }));
    response.resolve();
    const packet = await pending;
    assert.deepEqual(new Set(packet.memories!.map(item => item.slug)), new Set(['original', 'concurrent']));
    const memories = await store.read();
    for (const item of memories) assert.equal(item.recalls, Number(lexical.memories!.some(row => row.slug === item.slug)) + Number(packet.memories!.some(row => row.slug === item.slug)));
    assert.equal(state.inputs.flat().filter(input => input.includes('Original registry guidance')).length, 1);
    assert.ok(state.inputs.flat().some(input => input.includes('Revised registry guidance')));
    assert.ok(state.inputs.flat().some(input => input.includes('Concurrent registry guidance')));
  } finally { response.resolve(); await Promise.allSettled([pending, ...writers]); }

  const queryReady = Promise.withResolvers<void>(); const queryResponse = Promise.withResolvers<void>();
  state.embed = async inputs => { queryReady.resolve(); await queryResponse.promise; return embed(inputs); };
  const before = await store.read(); const calls = state.inputs.length;
  const counterOnly = recall('registry', { ...options, provider, semantic: 'on', budget: 800 });
  try {
    await whileEmbedding(queryReady.promise);
    await whileEmbedding(recall('registry', { ...options, budget: 800 }));
    queryResponse.resolve();
    await counterOnly;
    for (const item of await store.read()) assert.equal(item.recalls, before.find(previous => previous.id === item.id)!.recalls + 2);
    // Counter-only drift reuses the ranked snapshot without a second query request.
    assert.equal(state.inputs.length, calls + 1);
  } finally { queryResponse.resolve(); await Promise.allSettled([counterOnly]); }
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
  /** Exercise the native CLI preview for both singleton and pair-capable corpora. */
  async function preview(): Promise<{ note?: string }> {
    const result = await child([cli, 'memory', 'consolidate', '--semantic', 'auto', '--json'], env, root);
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout) as { note?: string };
  }
  assert.equal((await preview()).note, undefined);
  await remember('Other unrelated banana', { ...options, kind: 'project', slug: 'other' });
  assert.match((await preview()).note!, /lexical/);
});


test('review benchmark reports the shared immutable production weights and matching scores', async t => {
  const instant = Date.now(); t.mock.method(Date, 'now', () => instant);
  const { workspace } = await tracker(t);
  const provider: EmbeddingProvider = { identity: async () => 'shared-weights', embed: async inputs => inputs.map(() => [1, 0]) };
  const result = await benchmark(fixture, workspace, provider);
  assert.equal(result.weights, HYBRID_WEIGHTS);
  assert.ok(Object.isFrozen(result.weights));
  assert.deepEqual(result.weights, { lexical: 0.3, cosine: 0.7, prior: 0.01 });
  const memories = fixtureMemories(fixture);
  const lexical = scored(memories, fixture.queries[0].query);
  const maximum = Math.max(...lexical.map(row => row.lexical));
  const ranked = await hybridScored(memories, fixture.queries[0].query, { workspace, provider, semantic: 'on' });
  for (const row of ranked.rows) {
    const source = lexical.find(entry => entry.item.slug === row.item.slug)!;
    assert.equal(row.score, result.weights.lexical * (source.lexical / maximum) + result.weights.cosine + result.weights.prior * source.prior);
  }
});

test('review semantic pairs always use older sources and deterministic equal-age slugs', async t => {
  const { workspace } = await tracker(t);
  const provider: EmbeddingProvider = { identity: async () => 'age-order', embed: async inputs => inputs.map(() => [1, 0]) };
  const base = fixtureMemories(fixture)[0];
  const memories = [
    { ...base, slug: 'newer', updated: '2026-10-21' },
    { ...base, slug: 'older-z', updated: '2026-01-01' },
    { ...base, slug: 'older-a', updated: '2026-01-01' },
  ];
  const before = structuredClone(memories);
  const preview = await semanticProposals(memories, { workspace, provider, semantic: 'on' });
  assert.deepEqual(preview.proposals.map(({ slug, target }) => [slug, target]), [['older-a', 'older-z'], ['older-a', 'newer'], ['older-z', 'newer']]);
  assert.deepEqual(memories, before);
  assert.deepEqual(await semanticProposals([...memories].reverse(), { workspace, provider, semantic: 'on' }), preview);
});

test('review pin-only updates preserve content age and semantic source ordering', async t => {
  const { options, workspace, store } = await tracker(t);
  const older = await remember('Durable registry guidance', { ...options, kind: 'reference', slug: 'older' });
  const newer = await remember('Independent publication guidance', { ...options, kind: 'reference', slug: 'newer' });
  await store.fields(older.id, { changed_at: '2026-01-01T00:00:00.000Z', verdict: 'verified', verified_at: '2026-02-01T00:00:00.000Z', edited: false });
  await store.fields(newer.id, { changed_at: '2026-02-01T00:00:00.000Z' });
  const provider: EmbeddingProvider = { identity: async () => 'pin-content-age', embed: async inputs => inputs.map(() => [1, 0]) };
  for (const pin of [true, false]) {
    await remember('Durable registry guidance', { ...options, kind: 'reference', update: 'older', pin });
    const memory = (await store.read()).find(item => item.slug === 'older')!;
    assert.equal(memory.pinned, pin);
    assert.equal(memory.updated, '2026-01-01T00:00:00.000Z');
    assert.equal(memory.verdict, 'unknown'); assert.equal(memory.edited, true);
    assert.deepEqual((await semanticProposals(await store.read(), { workspace, provider, semantic: 'on' })).proposals.map(({ slug, target }) => [slug, target]), [['older', 'newer']]);
  }
  await remember('Revised registry content', { ...options, kind: 'reference', update: 'older', pin: true });
  const revised = (await store.read()).find(item => item.slug === 'older')!;
  assert.notEqual(revised.updated, '2026-01-01T00:00:00.000Z');
  assert.deepEqual({ verdict: revised.verdict, edited: revised.edited }, { verdict: 'unknown', edited: true });
  const changedOrder = await semanticProposals(await store.read(), { workspace, provider, semantic: 'on' });
  assert.equal(changedOrder.proposals[0].slug, 'newer'); assert.equal(changedOrder.proposals[0].target, 'older');
});

test('review rejection markers skip repeated documents and invalidate on content model or corruption', async t => {
  const { workspace } = await tracker(t); const { provider, state } = await daemon(t);
  const memories = fixtureMemories(fixture);
  state.rejectInput = 'oidc';
  const initial = await memoryVectors(memories, workspace, provider);
  assert.deepEqual(initial, [undefined, [0, 1, 0]]);
  const directory = join(workspace, 'runtime', 'memory-embeddings', digest(await provider.identity()));
  const marker = join(directory, `${digest(embeddingText(memories[0]))}.json.rejected`);
  assert.equal(await readFile(marker, 'utf8'), 'null');
  assert.equal((await stat(marker)).mode & 0o777, 0o600);
  const calls = state.inputs.length;
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await memoryVectors(memories, workspace, provider), initial);
  memories[0].recalls++; memories[0].pinned = true; memories[0].verdict = 'verified';
  assert.deepEqual(await memoryVectors(memories, workspace, provider), initial);
  assert.equal(state.inputs.length, calls, 'no rejected or healthy document should be resubmitted');
  await writeFile(marker, 'corrupt');
  assert.deepEqual(await memoryVectors(memories, workspace, provider), initial);
  assert.equal(state.inputs.length, calls + 1);
  assert.equal(await readFile(marker, 'utf8'), 'null');
  memories[0].body += ' revised';
  assert.deepEqual(await memoryVectors(memories, workspace, provider), initial);
  assert.equal(state.inputs.length, calls + 2);
  state.rejectInput = ''; state.tags = { models: [{ name: 'test:local', digest: 'b'.repeat(64) }] };
  const rebuilt = await memoryVectors(memories, workspace, provider);
  assert.ok(rebuilt!.every(vector => vector !== undefined));
  assert.equal(state.inputs.length, calls + 3);
  assert.equal(state.inputs.at(-1)!.length, 2);
});

test('review rejected documents retain zero-cosine lexical evidence and healthy semantic pairs', async t => {
  const instant = Date.now(); t.mock.method(Date, 'now', () => instant);
  const { options, workspace, store } = await tracker(t); const { provider, state } = await daemon(t);
  await remember('oversized imported memory', { ...options, kind: 'reference', slug: 'oversized' });
  await remember('npm trusted publishing OIDC', { ...options, kind: 'reference', slug: 'oidc' });
  await remember('Federated publication registry identity', { ...options, kind: 'reference', slug: 'registry' });
  state.rejectInput = 'oversized';
  const memories = await store.read();
  const vectors = await memoryVectors(memories, workspace, provider);
  assert.ok(vectors);
  assert.equal(vectors[memories.findIndex(item => item.slug === 'oversized')], undefined);
  assert.equal(vectors.filter(vector => vector !== undefined).length, 2);
  assert.deepEqual(state.inputs.map(inputs => inputs.length), [3, 1, 1, 1]);
  const directory = join(workspace, 'runtime', 'memory-embeddings', digest(await provider.identity()));
  assert.equal((await readdir(directory)).length, 3);
  const before = await snapshot(workspace);
  const preview = await semanticProposals(memories, { workspace, provider, semantic: 'on' });
  assert.equal(preview.note, undefined);
  assert.deepEqual(preview.proposals.map(({ slug, target }) => [slug, target]), [['oidc', 'registry']]);
  assert.deepEqual(await snapshot(workspace), before);
  for (const semantic of ['on', 'auto'] as const) {
    const ranked = await hybridScored(memories, 'imported memory', { workspace, provider, semantic });
    const lexical = scored(memories, 'imported memory');
    const maximum = Math.max(...lexical.map(row => row.lexical));
    const rejected = lexical.find(row => row.item.slug === 'oversized')!;
    assert.equal(ranked.note, undefined);
    assert.equal(ranked.rows.find(row => row.item.slug === 'oversized')!.score, HYBRID_WEIGHTS.lexical * (rejected.lexical / maximum) + HYBRID_WEIGHTS.prior * rejected.prior);
    const packet = await recall('registry', { ...options, provider, semantic, budget: 800 });
    assert.equal(packet.note, undefined); assert.ok(packetTokens(packet) <= 800);
    assert.ok(packet.memories!.some(row => row.slug === 'oversized'));
  }
  assert.deepEqual(state.inputs.slice(4), [['imported memory'], ['registry'], ['imported memory'], ['registry']], 'only transient queries may be embedded after documents and rejections are cached');
  for (const item of await store.read()) assert.equal(item.recalls, 2);
});

test('review document rejection isolation preserves daemon model protocol and query failures', async t => {
  const { workspace } = await tracker(t); const { provider, state } = await daemon(t);
  const memories = fixtureMemories(fixture);
  state.rejectInput = ''; state.rejectStatus = 400;
  for (const status of [400, 413]) {
    memories[0].body += ` status-${status}`;
    state.rejectInput = 'oidc'; state.rejectStatus = status;
    assert.deepEqual(await memoryVectors([memories[0]], workspace, provider), [undefined]);
  }
  // Every rejected document contributes zero cosine; neither endpoint may form a pair.
  const all = memories.map(item => ({ ...item, body: 'rejected' }));
  state.rejectInput = 'rejected';
  assert.deepEqual(await memoryVectors(all, workspace, provider), [undefined, undefined]);
  assert.deepEqual(await semanticProposals(all, { workspace, provider, semantic: 'on' }), { proposals: [] });
  const ranked = await hybridScored(all, 'absent', { workspace, provider, semantic: 'on' });
  assert.equal(ranked.note, undefined);
  // Fresh misses keep the failure-policy assertions independent of rejection markers.
  await rm(join(workspace, 'runtime'), { recursive: true, force: true });
  state.rejectInput = '';
  state.status = 503;
  await assert.rejects(memoryVectors(memories, workspace, provider));
  state.status = 200; state.rejectInput = 'oidc'; state.rejectStatus = 503;
  const calls = state.inputs.length;
  await assert.rejects(memoryVectors(memories, workspace, provider));
  assert.equal(state.inputs.length, calls + 1, 'daemon errors must not fan out into per-row retries');
  state.rejectInput = ''; state.payload = { embeddings: [[1]] };
  await assert.rejects(memoryVectors(memories, workspace, provider), /Invalid embedding vectors/);
  state.payload = undefined;
  await memoryVectors(memories, workspace, provider);
  state.rejectInput = 'query-rejection'; state.rejectStatus = 400;
  await assert.rejects(hybridScored(memories, 'query-rejection', { workspace, provider, semantic: 'on' }), /unavailable/);
  assert.match((await hybridScored(memories, 'query-rejection', { workspace, provider, semantic: 'auto' })).note!, /lexical/);
});

test('review semantic recall stops after five content conflicts without incrementing counters', async t => {
  const { options, store } = await tracker(t);
  await remember('Initial registry guidance', { ...options, kind: 'reference', slug: 'registry' });
  for (const semantic of ['on', 'auto'] as const) {
    const before = (await store.read())[0].recalls;
    let queries = 0;
    const provider: EmbeddingProvider = {
      identity: async () => 'bounded-conflicts',
      embed: async (inputs, purpose) => {
        if (purpose === 'query' && ++queries <= 5) await remember(`Registry guidance revision ${semantic} ${queries}`, { ...options, kind: 'reference', update: 'registry' });
        return inputs.map(() => [1, 0]);
      },
    };
    await assert.rejects(recall('registry', { ...options, provider, semantic }), { code: 'conflict', message: /Memory corpus kept changing/ });
    assert.equal(queries, 5);
    assert.equal((await store.read())[0].recalls, before);
    const packet = await recall('registry', { ...options, provider, semantic: 'off' });
    assert.equal(packet.memories![0].slug, 'registry');
  }
});
