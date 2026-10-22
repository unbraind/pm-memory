import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, request as httpRequest } from 'node:http';
import { digest, MemoryError } from './core.ts';
import type { Memory } from './types.ts';

/** Direct connections never inherit environment proxies from the global agent. */
const LOOPBACK_AGENT = new Agent({ keepAlive: false });
/** Distinguish confirmed input rejections from legacy status-only cache markers. */
const REJECTION_MARKER = 'document-input:v1';

/** Explicit semantic opt-in; off preserves the original ranking exactly. */
export type SemanticMode = 'auto' | 'on' | 'off';
/** Retrieval role controls model-specific query versus document task instructions. */
export type EmbeddingPurpose = 'query' | 'document';
/** Provider contract: identity must change with model weights or input preprocessing. */
export interface EmbeddingProvider {
  /** Resolve an installed, local model revision before using cached vectors. */
  identity(): Promise<string>;
  /** Embed in order; throw EmbeddingInputError only for input rejection, never for daemon failures. */
  embed(inputs: readonly string[], purpose?: EmbeddingPurpose): Promise<number[][]>;
}
/** Deterministic no-model adapter; callers retain the lexical ranking. */
export class LexicalProvider implements EmbeddingProvider {
  /** A stable sentinel for the no-model path. */
  async identity(): Promise<string> { return 'lexical'; }
  /** Empty vectors explicitly indicate that there is no semantic evidence. */
  async embed(inputs: readonly string[]): Promise<number[][]> { return inputs.map(() => []); }
}
/** Validate CLI and SDK mode values without silently accepting misspellings. */
export function semanticMode(value: unknown = 'off'): SemanticMode {
  if (value !== 'auto' && value !== 'on' && value !== 'off') throw new MemoryError('invalid', 'Invalid semantic mode', 'Use --semantic auto, on or off');
  return value;
}
/** A document rejection may be isolated; transport and model failures must remain strict. */
export class EmbeddingInputError extends Error {}
/** Local Ollama adapter using only installed models and literal loopback addresses. */
export class OllamaProvider implements EmbeddingProvider {
  /** Model tag selected explicitly or through the package-specific environment variable. */
  readonly model: string;
  /** Validated loopback origin; redirects and URL credentials are forbidden. */
  readonly endpoint: string;
  /** Per-embedding request deadline; discovery is capped at 1500 ms. */
  readonly timeoutMs: number;
  /** Last explicitly resolved revision, used to refuse mid-operation retagging. */
  private revision?: string;
  /** Bind a loopback daemon; never honor OLLAMA_HOST or proxy configuration. */
  constructor(model = process.env.PM_MEMORY_MODEL ?? 'embeddinggemma-2:latest', endpoint = 'http://127.0.0.1:11434', timeoutMs = 30000) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new MemoryError('semantic', 'Embedding endpoint must be a loopback HTTP origin', 'Use a local Ollama daemon');
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    this.model = model.lastIndexOf(':') > model.lastIndexOf('/') ? model : `${model}:latest`; this.endpoint = url.origin; this.timeoutMs = timeoutMs;
  }
  /** Read JSON from a bounded local request without following redirects. */
  private async request(path: string, input?: readonly string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(this.endpoint + path, { agent: LOOPBACK_AGENT, method: input === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(input === undefined ? Math.min(1500, this.timeoutMs) : this.timeoutMs), ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }) }, response => {
        if (response.statusCode !== 200 && !(input !== undefined && response.statusCode === 400)) { response.resume(); reject(new (input !== undefined && response.statusCode === 413 ? EmbeddingInputError : Error)('Local embedding request failed')); return; }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown } | null;
            if (response.statusCode === 400) {
              const inputRejected = typeof result?.error === 'string' && /^(?:the )?input length exceeds (?:the )?context (?:length|window)$/i.test(result.error);
              reject(new (inputRejected ? EmbeddingInputError : Error)('Local embedding request failed'));
            } else resolve(result);
          } catch (error) { reject(response.statusCode === 400 ? new Error('Local embedding request failed') : error); }
        });
      });
      request.on('error', reject);
      request.end(input === undefined ? undefined : JSON.stringify({ model: this.model, input, truncate: false, keep_alive: '5m' }));
    });
  }
  /** Reject missing tags and cloud-backed aliases even when a daemon is reachable. */
  async identity(): Promise<string> {
    const result = await this.request('/api/tags') as { models?: { name: string; digest: string; remote_host?: string; remote_model?: string }[] };
    const model = result.models?.find(entry => entry.name === this.model);
    if (model === undefined || typeof model.digest !== 'string' || !/^[a-f0-9]{64}$/.test(model.digest) || model.remote_host !== undefined || model.remote_model !== undefined || /cloud/i.test(model.name)) throw new Error('Installed local embedding model unavailable');
    this.revision = `ollama:v2:${this.model}:${model.digest}`;
    return this.revision;
  }
  /** Generate complete vectors using the documented batch endpoint. */
  async embed(inputs: readonly string[], purpose: EmbeddingPurpose = 'document'): Promise<number[][]> {
    const expected = this.revision;
    const current = await this.identity();
    if (expected !== undefined && expected !== current) throw new Error('Embedding model changed during operation');
    const result = await this.request('/api/embed', inputs.map(input => embeddingInput(this.model, input, purpose))) as { embeddings: number[][] };
    return validateVectors(result.embeddings, inputs.length);
  }
}
/** Apply published model-card retrieval prompts; unknown local models receive raw text. */
export function embeddingInput(model: string, input: string, purpose: EmbeddingPurpose): string {
  if (model.startsWith('embeddinggemma')) return purpose === 'query' ? `task: search result | query: ${input}` : `title: none | text: ${input}`;
  if (model.startsWith('qwen3-embedding') && purpose === 'query') return `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:${input}`;
  return input;
}
/** Require finite, nonzero and dimensionally consistent evidence before cosine ranking. */
export function validateVectors(value: unknown, count: number): number[][] {
  if (!Array.isArray(value) || value.length !== count || value.some(row => !Array.isArray(row) || row.length === 0 || row.some(entry => typeof entry !== 'number' || !Number.isFinite(entry)) || !Number.isFinite(Math.hypot(...row)) || Math.hypot(...row) === 0 || row.length !== value[0].length)) throw new Error('Invalid embedding vectors');
  return value as number[][];
}
/** Normalize validated finite nonzero evidence once before comparing multiple pairs. */
export function unitVector(vector: readonly number[]): number[] {
  const norm = Math.hypot(...vector);
  return vector.map(value => value / norm);
}
/** Compare unit vectors while preserving the cosine range despite rounding error. */
export function unitCosine(left: readonly number[], right: readonly number[]): number {
  return Math.max(-1, Math.min(1, left.reduce((sum, value, index) => sum + value * right[index], 0)));
}
/** Compare validated vectors; normalization avoids overflow in unnormalized providers. */
export function cosine(left: readonly number[], right: readonly number[]): number {
  return unitCosine(unitVector(left), unitVector(right));
}
/** Stable embedding input includes every retrieval field, excluding operational counters. */
export function embeddingText(item: Memory): string {
  return [item.slug, item.title, item.description, item.body, item.why, item.how, ...item.tags].join('\n');
}
/** Classify filesystem failures without leaking local paths or suggesting daemon repair. */
async function cacheIO<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new MemoryError('cache', 'Local embedding cache unavailable', 'Check tracker runtime permissions, file types and free disk space; retry or use --semantic off'); }
}
/** Missing runtime files are cache misses; other filesystem errors remain actionable. */
async function readCache(path: string): Promise<string | undefined> {
  return cacheIO(() => readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }));
}
/** Rebuild corrupt or missing cache entries while retaining filesystem error classification. */
async function cached(path: string): Promise<number[] | undefined> {
  const content = await readCache(path);
  try { return validateVectors([JSON.parse(content ?? '') as unknown], 1)[0]; }
  catch { return undefined; }
}
/** Atomically publish private runtime vectors or rejection markers, cleaning failed publications. */
async function publish(path: string, vector: number[] | typeof REJECTION_MARKER): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  try { await writeFile(temporary, JSON.stringify(vector), { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
/** Retry only explicit input rejections individually, preserving daemon and protocol failures. */
async function embedDocuments(provider: EmbeddingProvider, inputs: readonly string[]): Promise<(number[] | undefined)[]> {
  try { return validateVectors(await provider.embed(inputs), inputs.length); }
  catch (error) {
    if (!(error instanceof EmbeddingInputError)) throw error;
    if (inputs.length === 1) return [undefined];
    const result: (number[] | undefined)[] = [];
    for (const input of inputs) result.push(...await embedDocuments(provider, [input]));
    return result;
  }
}
/** Resolve content-addressed vectors; clear runtime/memory-embeddings after daemon context-window changes. */
export async function memoryVectors(memories: readonly Memory[], workspace: string, provider: EmbeddingProvider): Promise<(number[] | undefined)[] | undefined> {
  const identity = await provider.identity();
  if (identity === 'lexical') return undefined;
  const directory = join(workspace, 'runtime', 'memory-embeddings', digest(identity));
  await cacheIO(async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, '..', '.gitignore'), '*\n', { mode: 0o600 });
  });
  const inputs = memories.map(embeddingText);
  const paths = inputs.map(input => join(directory, `${digest(input)}.json`));
  const vectors: (number[] | undefined)[] = []; const rejected: boolean[] = [];
  const marker = JSON.stringify(REJECTION_MARKER);
  for (let start = 0; start < paths.length; start += 16) {
    const entries = await Promise.all(paths.slice(start, start + 16).map(async path => ({ vector: await cached(path), rejected: await readCache(`${path}.rejected`) === marker })));
    vectors.push(...entries.map(entry => entry.vector)); rejected.push(...entries.map(entry => entry.rejected));
  }
  const missing = vectors.flatMap((vector, index) => vector === undefined && !rejected[index] ? [index] : []);
  for (let start = 0; start < missing.length; start += 16) {
    const batch = missing.slice(start, start + 16);
    const embedded = await embedDocuments(provider, batch.map(index => inputs[index]));
    for (let offset = 0; offset < batch.length; offset++) {
      const index = batch[offset]; const vector = embedded[offset];
      vectors[index] = vector;
      await cacheIO(() => publish(vector === undefined ? `${paths[index]}.rejected` : paths[index], vector ?? REJECTION_MARKER));
    }
  }
  const available = vectors.filter(vector => vector !== undefined);
  validateVectors(available, available.length);
  return vectors;
}
/** Semantic controls shared by recall and preview-only consolidation. */
export interface SemanticOptions {
  /** Defaults to off; auto falls back with an accounted note, on fails explicitly. */
  semantic?: SemanticMode;
  /** Optional in-process local provider; CLI always uses the loopback Ollama adapter. */
  provider?: EmbeddingProvider;
}
/** Keep unavailable-provider diagnostics concise and free of memory content or topology. */
export const SEMANTIC_FALLBACK = 'Semantic model unavailable; using lexical ranking.';
/** Account partial document evidence and its recovery action in every emitted packet. */
export const INCOMPLETE_EMBEDDINGS = 'Some memories lack embeddings and use lexical evidence only. Increase daemon context limits and clear runtime/memory-embeddings/, or use --semantic off.';
/** Apply strict on versus graceful auto failure policy. */
export function semanticFailure(mode: SemanticMode, error?: unknown): string {
  if (error instanceof MemoryError && error.code === 'cache') {
    if (mode === 'on') throw error;
    return 'Local embedding cache unavailable; using lexical ranking. Check tracker runtime permissions, file types and free disk space.';
  }
  if (mode === 'on') throw new MemoryError('semantic', 'Local embedding model unavailable', 'Start local Ollama with an installed embedding model, or use --semantic off');
  return SEMANTIC_FALLBACK;
}
