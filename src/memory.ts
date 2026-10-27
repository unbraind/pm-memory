import { randomBytes } from 'node:crypto';
import { parseMutationReceipt, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import type { Memory, MemoryOptions, Packet, RememberOptions, RecallRow, GuidanceOptions } from './types.ts';
import { accounted, budget, digest, kind, MemoryError, pack, privacy, similarity, slug, text, words } from './core.ts';
import { unitVector, unitCosine, memoryVectors, OllamaProvider, semanticFailure, semanticMode, validateVectors, INCOMPLETE_EMBEDDINGS } from './embeddings.ts';
import type { SemanticOptions } from './embeddings.ts';
import { memoryRevision, readUtility } from './utility.ts';
import { eligibleGuidance, guidancePolicy, guidanceState } from './guidance.ts';
import { metadata, Store } from './store.ts';

/** Inclusive similarity threshold for a title-plus-body normalized token set. */
export const DUPLICATE_THRESHOLD = 0.82;
/** Create or update one fact under a process-safe uniqueness lock, preserving native history. */
export async function remember(fact: string, options: RememberOptions): Promise<{ id: string; slug: string; updated: boolean }> {
  text(fact); kind(options.kind);
  for (const value of [fact, options.why, options.how, options.slug, options.update, ...(options.tags ?? []), ...(options.links ?? [])]) {
    if (value !== undefined) privacy(value, options.allowEmail);
  }
  if (options.update !== undefined && options.slug !== undefined && options.update !== options.slug) throw new MemoryError('invalid', 'Conflicting update and slug', 'Supply only the existing --update slug');
  const key = slug(options.update ?? options.slug ?? `memory-${digest(fact).slice(0, 16)}`);
  const store = new Store(options);
  return store.write(async () => {
    const memories = await store.read();
    const previous = memories.find(item => item.slug === key);
    if (options.update !== undefined && previous === undefined) throw new MemoryError('missing', 'Update slug does not exist', 'Use remember --slug to create a new memory');
    if (previous?.artifact === true) throw new MemoryError('conflict', `Slug ${key} belongs to an imported index artifact`, 'Choose a different --slug; index artifacts are not editable memories');
    const title = fact.trim().split(/\r?\n/)[0].slice(0, 160).toWellFormed();
    const duplicate = active(memories).find(item => item.slug !== key && similarity(`${title}\n${fact}`, `${item.title}\n${item.body}`) >= DUPLICATE_THRESHOLD);
    if (previous === undefined && duplicate !== undefined && !options.forceNew) throw new MemoryError('duplicate', `Near duplicate of ${duplicate.slug}`, `Use --update ${duplicate.slug} or --force-new with a distinct --slug`);
    const targets: string[] = [];
    for (const reference of options.links ?? []) {
      const target = memories.find(item => item.slug === reference)?.id ?? reference;
      await store.client.get(target); targets.push(target);
    }
    await store.register();
    const why = options.why ?? previous?.why ?? ''; const how = options.how ?? previous?.how ?? ''; const pinned = options.pin ?? previous?.pinned ?? false;
    const unchanged = previous !== undefined && previous.title === title && previous.body === fact.trim() && previous.kind === options.kind && previous.why === why && previous.how === how && (options.tags === undefined || JSON.stringify(previous.tags) === JSON.stringify(options.tags));
    const fields: Record<string, string | number | boolean> = { slug: key, kind: options.kind, why, how, pinned, source: previous?.source ?? 'native:item', recalls: previous?.recalls ?? 0, changed_at: unchanged ? previous.updated : new Date().toISOString() };
    if (!unchanged || previous.pinned !== pinned) Object.assign(fields, { verdict: 'unknown', verified_at: '', edited: true });
    let id: string;
    if (previous === undefined) {
      const created = await store.client.run('create', { options: { title, body: fact, type: 'Knowledge', ...itemDocumentToMutationOptions(JSON.stringify({ tags: options.tags ?? [] }), 'create'), allowDuplicate: true, ...metadata(fields) } });
      id = parseMutationReceipt(created).id;
    } else {
      await store.history(previous.id);
      await store.client.update(previous.id, { title, body: fact, ...(previous.status === 'canceled' ? { status: 'open' } : {}), ...(options.tags === undefined ? {} : itemDocumentToMutationOptions(JSON.stringify({ tags: options.tags }), 'update')), message: 'Revise durable agent memory' });
      await store.fields(previous.id, fields); id = previous.id;
    }
    for (const target of targets) await store.link(id, target);
    return { id, slug: key, updated: previous !== undefined };
  });
}
/** Filter archived memories and lossless index artifacts out of active retrieval. */
export function active(memories: readonly Memory[]): Memory[] { return memories.filter(item => item.status !== 'canceled' && !item.artifact); }
/** Rank normalized lexical evidence with inverse document frequency, length normalization and bounded priors. */
export function scored(memories: readonly Memory[], query: string): { item: Memory; score: number; lexical: number; prior: number }[] {
  const now = Date.now();
  const terms = [...words(query)];
  const documents = memories.map(item => words([item.slug, item.title, item.description, item.body, item.why, item.how, ...item.tags].join(' ')));
  const idf = new Map(terms.map(term => [term, Math.log(1 + memories.length / (1 + documents.filter(doc => doc.has(term)).length))]));
  const scores = memories.map((item, index) => {
    const heading = words(item.title);
    const hook = words(item.description);
    const key = words(item.slug);
    const lexical = terms.reduce((sum, term) => sum + (documents[index].has(term) ? (heading.has(term) ? 5 : hook.has(term) ? 2 : key.has(term) ? 1.5 : 1) * idf.get(term)! / (1 + Math.log(1 + documents[index].size) / 10) : 0), 0);
    const ageDays = Math.max(0, (now - Date.parse(item.updated)) / 86400000);
    const prior = (item.pinned ? 0.5 : 0) + 0.2 / (1 + ageDays);
    return { item, score: lexical * 10 + prior, lexical, prior };
  });
  return scores.sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug));
}
/** Preserve the public ranking projection while exposing scores in recall rows. */
export function rank(memories: readonly Memory[], query: string): Memory[] { return scored(memories, query).map(entry => entry.item); }
/** Shared production coefficients reported by the retrieval benchmark. */
export const HYBRID_WEIGHTS = Object.freeze({ lexical: 0.3, cosine: 0.7, prior: 0.01 });
/** Blend relevance and cosine with a bounded prior, exposing incomplete document vectors. */
export async function hybridScored(memories: readonly Memory[], query: string, options: MemoryOptions & SemanticOptions): Promise<{ rows: { item: Memory; score: number; cosine?: number }[]; note?: string; incompleteVectors?: true }> {
  const rows = scored(memories, query); const mode = semanticMode(options.semantic);
  if (mode === 'off' || memories.length === 0) return { rows };
  try {
    const provider = options.provider ?? new OllamaProvider();
    const vectors = await memoryVectors(memories, options.workspace, provider);
    if (vectors === undefined) return { rows, note: semanticFailure(mode) };
    const [queryVector] = validateVectors(await provider.embed([query], 'query'), 1);
    const available = vectors.filter(vector => vector !== undefined);
    validateVectors([...available, queryVector], available.length + 1);
    const unit = vectors.map(vector => vector === undefined ? undefined : unitVector(vector)); const queryUnit = unitVector(queryVector);
    const maximum = Math.max(...rows.map(row => row.lexical));
    const positions = new Map(memories.map((item, index) => [item.slug, index]));
    return { ...(available.length < vectors.length ? { incompleteVectors: true as const, note: INCOMPLETE_EMBEDDINGS } : {}), rows: rows.map(({ item, lexical, prior }) => {
      const cosine = unitCosine(unit[positions.get(item.slug)!] ?? [], queryUnit);
      return { item, cosine, score: HYBRID_WEIGHTS.lexical * (maximum === 0 ? 0 : lexical / maximum) + HYBRID_WEIGHTS.cosine * Math.max(0, cosine) + HYBRID_WEIGHTS.prior * prior };
    }).sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug)) };
  } catch (error) { return { rows, note: semanticFailure(mode, error) }; }
}
/** Return a query-centered excerpt without charging oversized full memory bodies to the packet. */
function excerpt(item: Memory, query: string, size: number): string {
  const source = [item.body, item.why, item.how].filter(Boolean).join('\n');
  const match = [...words(query)].map(term => source.toLowerCase().indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, (match.length === 0 ? 0 : Math.min(...match)) - 100);
  return source.slice(start, start + size).toWellFormed();
}
/** Compare corpus snapshots independently of ordering and concurrent recall counters. */
function recallRevision(memories: readonly Memory[]): string {
  return JSON.stringify(memories.map(item => ({ ...item, recalls: 0 })).sort((a, b) => a.id.localeCompare(b.id)));
}
/** Build a bounded packet and increment current counters while the caller holds the writer lock. */
async function commitRecall(store: Store, current: readonly Memory[], ranked: Awaited<ReturnType<typeof hybridScored>>, query: string, limit: number, policy: NonNullable<GuidanceOptions['validity']>): Promise<Packet> {
  const now = Date.now();
  const visible = new Set(eligibleGuidance(ranked.rows.map(row => row.item), policy, now).map(item => item.id));
  const rankedRows = ranked.rows.filter(row => visible.has(row.item.id));
  const memories = rankedRows.map(row => row.item);
  const rows: RecallRow[] = rankedRows.map(({ item, score }) => ({ ...(item.validity === undefined ? {} : { validity: guidanceState(item, now), valid_from: item.validity.from, valid_until: item.validity.until }), slug: item.slug, kind: item.kind, pinned: item.pinned, source: item.source, description: (item.description || item.why || item.body).replace(/\s+/g, ' ').slice(0, 60).toWellFormed(), score: Math.round(score * 1000) / 1000 }));
  const receipt = randomBytes(12).toString('hex');
  const packet = recallPacket(rows, memories, query, limit, ranked.note, receipt);
  const emitted = packet.memories!.map(row => current.find(memory => memory.slug === row.slug)!);
  if (emitted.some(item => item.recalls === Number.MAX_SAFE_INTEGER)) throw new MemoryError('counter', 'Recall counter exhausted', 'Archive this memory or migrate its counter before recalling again');
  const ledgers = await Promise.all(emitted.map(item => readUtility(store, item)));
  if (emitted.length > 0) await store.register();
  for (const [position, item] of emitted.entries()) {
    const ledger = ledgers[position];
    ledger.exposures.push({ recall: receipt, revision: memoryRevision(item), at: new Date().toISOString() });
    await store.fields(item.id, { recalls: item.recalls + 1, utility: JSON.stringify(ledger) });
  }
  return packet;
}
/** Use one critical section for lexical recall; embed outside it and validate snapshots for semantic recall. */
export async function recall(query: string, options: MemoryOptions & SemanticOptions & GuidanceOptions & { budget?: number; kind?: Memory['kind'] }): Promise<Packet> {
  text(query); const limit = budget(options.budget ?? 800); const policy = guidancePolicy(options.validity);
  if (options.kind !== undefined) kind(options.kind);
  const store = new Store(options);
  /** Keep kind and active filtering identical in both recall modes. */
  const eligible = (memories: readonly Memory[]) => eligibleGuidance(active(memories).filter(item => item.consent === undefined), policy, Date.now()).filter(item => options.kind === undefined || item.kind === options.kind);
  const mode = semanticMode(options.semantic);
  if (mode === 'off') return store.write(async () => {
    const current = await store.read();
    return commitRecall(store, current, await hybridScored(eligible(current), query, options), query, limit, policy);
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = await store.write(() => store.read());
    const ranked = await hybridScored(eligible(snapshot), query, options);
    const packet = await store.write(async () => {
      const current = await store.read();
      if (recallRevision(snapshot) !== recallRevision(current)) return undefined;
      return commitRecall(store, current, ranked, query, limit, policy);
    });
    if (packet !== undefined) return packet;
  }
  if (mode === 'auto') return store.write(async () => {
    const current = await store.read();
    return commitRecall(store, current, { rows: scored(eligible(current), query), note: 'Memory corpus kept changing; using lexical ranking.' }, query, limit, policy);
  });
  throw new MemoryError('conflict', 'Memory corpus kept changing during semantic recall', 'Retry when concurrent memory writes settle, or use --semantic off');
}
/** Pack compact rows in rank order first, then spend spare tokens on marked excerpts. */
export function recallPacket(rows: RecallRow[], memories: readonly Memory[], query: string, limit: number, note?: string, receipt?: string): Packet {
  const render = (selected: RecallRow[], omitted: number) => ({ memories: selected, omitted, complete: true as const, ...(receipt === undefined ? {} : { recall: receipt }), ...(note === undefined ? {} : { note }) });
  // Compact even the first description until its row fits; never skip a higher-ranked row.
  const firstRender = (selected: RecallRow[]) => render(selected, rows.length - selected.length);
  const compact = rows.map(row => ({ ...row }));
  if (compact.length > 0) {
    while (pack([compact[0]], limit, firstRender).memories!.length === 0 && (compact[0].description ?? '').length > 0) compact[0].description = compact[0].description!.slice(0, -1);
    if (pack([compact[0]], limit, firstRender).memories!.length === 0) throw new MemoryError('budget', 'Budget cannot hold the top memory row', 'Increase --budget to at least 200');
  }
  let packet = pack([], limit, render);
  /** Account each complete candidate once, retaining its stabilized token receipt. */
  const fit = (selected: RecallRow[], omitted: number): Packet | undefined => {
    const candidate = accounted({ ...render(selected, omitted), estimated_tokens: 0 });
    return candidate.estimated_tokens <= limit ? candidate : undefined;
  };
  const chosen: RecallRow[] = [];
  for (const row of compact) {
    const next = fit([...chosen, row], rows.length - chosen.length - 1);
    if (next === undefined) break;
    chosen.push(row);
    packet = next;
  }
  for (let index = 0; index < packet.memories!.length; index++) {
    const item = memories.find(item => item.slug === packet.memories![index].slug)!;
    const content = excerpt(item, query, 800);
    for (let size = content.length; size > 0; size = Math.floor(size / 2)) {
      const selected = packet.memories!.map(row => ({ ...row }));
      selected[index].text = content.slice(0, size).toWellFormed() + (size < [item.body, item.why, item.how].filter(Boolean).join('\n').length ? ' […truncated; use pm memory get]' : '');
      const next = fit(selected, packet.omitted);
      if (next !== undefined) { packet = next; break; }
    }
  }
  return packet;
}
/** Read a complete active memory by its stable slug without incrementing recall counters. */
export async function get(key: string, options: MemoryOptions): Promise<Memory> {
  slug(key);
  const item = active(await new Store(options).read()).find(item => item.slug === key);
  if (item === undefined) throw new MemoryError('missing', 'Memory slug does not exist', 'Use memory index to select an active slug');
  return item;
}
/** Render a MEMORY.md-style bounded index with a terminal omission receipt. */
export async function index(options: MemoryOptions & GuidanceOptions & { budget?: number }): Promise<Packet> {
  const limit = budget(options.budget ?? 1500);
  const now = Date.now(); const policy = guidancePolicy(options.validity);
  const memories = eligibleGuidance(active(await new Store(options).read()).filter(item => item.consent === undefined), policy, now).sort(indexOrder);
  const rows = memories.map(item => `- ${item.validity === undefined ? '' : `[${guidanceState(item, now)}; ${item.validity.from}..${item.validity.until})] `}[${item.title.replace(/[[\]\r\n]/g, ' ')}](${item.slug}) — ${(item.why || item.body).replace(/\s+/g, ' ').slice(0, 100).toWellFormed()}`);
  return pack(rows, limit, (selected, omitted) => ({ text: [...selected, `<!-- omitted: ${omitted} memories -->`].join('\n'), omitted, complete: true }));
}

/** Order index rows deterministically even when imported timestamps are identical. */
export function indexOrder(a: Memory, b: Memory): number {
  return Number(b.pinned) - Number(a.pinned) || a.kind.localeCompare(b.kind) || b.updated.localeCompare(a.updated) || a.slug.localeCompare(b.slug);
}
