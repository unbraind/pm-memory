import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HYBRID_WEIGHTS, hybridScored, scored } from '../src/memory.ts';
import { LexicalProvider, OllamaProvider } from '../src/embeddings.ts';
import type { EmbeddingProvider } from '../src/embeddings.ts';
import type { Memory } from '../src/types.ts';
import { isMainInvocation } from './main-invocation.ts';

/** Public synthetic evaluation corpus, with one or more relevant slugs per query. */
export interface RecallFixture {
  /** Retrieval documents with no identity or operational metadata. */
  memories: {
    /** Stable synthetic document identity. */
    slug: string;
    /** Retrieval heading. */
    title: string;
    /** Invented retrieval content. */
    body: string;
    /** Optional pin for controlled prior evaluations. */
    pinned?: boolean;
    /** Optional content timestamp for controlled age evaluations. */
    updated?: string;
  }[];
  /** Independently phrased questions and labelled relevant documents. */
  queries: { query: string; gold: string[] }[];
}
/** Mean retrieval metrics over full rankings before packet truncation. */
export interface Metrics {
  /** Fraction of labelled relevant documents retrieved in the first position. */
  recallAt1: number;
  /** Fraction of labelled relevant documents retrieved in the first five positions. */
  recallAt5: number;
  /** Reciprocal rank of the first relevant result, averaged over queries. */
  mrr: number;
}
/** Default to equal document ages while allowing controlled pin and age evaluations. */
export function fixtureMemories(fixture: RecallFixture): Memory[] {
  return fixture.memories.map(item => ({ ...item, id: item.slug, description: '', why: '', how: '', kind: 'project', pinned: item.pinned ?? false, source: 'synthetic', updated: item.updated ?? '2026-01-01T00:00:00.000Z', merge: '', recalls: 0, verdict: 'unknown', status: 'open', tags: [], path: '', original: '', edited: false, artifact: false, relationships: [], links: [] }));
}
/** Average true recall at k and reciprocal rank, including misses as zero. */
export function metrics(rankings: readonly string[][], queries: RecallFixture['queries']): Metrics {
  const totals = { recallAt1: 0, recallAt5: 0, mrr: 0 };
  queries.forEach(({ gold }, index) => {
    const relevant = new Set(gold); const ranking = rankings[index];
    totals.recallAt1 += ranking.slice(0, 1).filter(slug => relevant.has(slug)).length / relevant.size;
    totals.recallAt5 += ranking.slice(0, 5).filter(slug => relevant.has(slug)).length / relevant.size;
    const first = ranking.findIndex(slug => relevant.has(slug));
    totals.mrr += first < 0 ? 0 : 1 / (first + 1);
  });
  return { recallAt1: totals.recallAt1 / queries.length, recallAt5: totals.recallAt5 / queries.length, mrr: totals.mrr / queries.length };
}
/** Require complete semantic evidence unless the run explicitly permits fallback. */
export async function benchmark(fixture: RecallFixture, workspace: string, provider: EmbeddingProvider, fallback = false) {
  const memories = fixtureMemories(fixture);
  const lexical: string[][] = []; const hybrid: string[][] = []; const cosine: string[][] = [];
  const model = await provider.identity();
  for (const { query } of fixture.queries) {
    lexical.push(scored(memories, query).map(row => row.item.slug));
    const ranked = await hybridScored(memories, query, { workspace, provider, semantic: fallback ? 'auto' : 'on' });
    if (!fallback && ranked.incompleteVectors) throw new Error('Benchmark requires vectors for every document; clear the runtime cache after correcting input limits');
    if (await provider.identity() !== model) throw new Error('Embedding model changed during benchmark');
    hybrid.push(ranked.rows.map(row => row.item.slug));
    cosine.push((fallback ? ranked.rows : [...ranked.rows].sort((a, b) => b.cosine! - a.cosine! || a.item.slug.localeCompare(b.item.slug))).map(row => row.item.slug));
  }
  return { memories: memories.length, queries: fixture.queries.length, model, mode: fallback ? 'lexical-fallback' : 'hybrid', weights: HYBRID_WEIGHTS, lexical: metrics(lexical, fixture.queries), hybrid: metrics(hybrid, fixture.queries), cosine: metrics(cosine, fixture.queries), ranks: fixture.queries.map(({ query, gold }, index) => ({ query, gold, lexical: lexical[index].findIndex(slug => gold.includes(slug)) + 1, hybrid: hybrid[index].findIndex(slug => gold.includes(slug)) + 1, cosine: cosine[index].findIndex(slug => gold.includes(slug)) + 1 })) };
}
/** Run a reproducible local-only measurement; unavailable models fail explicitly. */
export async function runBench(args: string[]): Promise<void> {
  const fixture = JSON.parse(await readFile(new URL('../bench/recall.json', import.meta.url), 'utf8')) as RecallFixture;
  const fallback = args.includes('--lexical-only');
  const workspace = await mkdtemp(join(tmpdir(), 'pm-memory-bench-'));
  try {
    console.log(JSON.stringify(await benchmark(fixture, workspace, fallback ? new LexicalProvider() : new OllamaProvider(), fallback), null, 2));
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
if (isMainInvocation(process.argv, import.meta.url)) await runBench(process.argv.slice(2));
