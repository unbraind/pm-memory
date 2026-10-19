import { parseMutationReceipt } from '@unbrained/pm-cli/sdk';
import type { Memory, MemoryOptions, Packet, RememberOptions, RecallRow } from './types.ts';
import { budget, digest, kind, MemoryError, pack, privacy, similarity, slug, text, words } from './core.ts';
import { metadata, Store } from './store.ts';

/** Inclusive similarity threshold for a title-plus-body normalized token set. */
export const DUPLICATE_THRESHOLD = 0.82;
/** Create or update one fact under a process-safe uniqueness lock, preserving native history. */
export async function remember(fact: string, options: RememberOptions): Promise<{ id: string; slug: string; updated: boolean }> {
  text(fact); kind(options.kind);
  privacy(JSON.stringify({ fact, why: options.why, how: options.how, tags: options.tags, slug: options.slug, update: options.update, links: options.links }), options.allowEmail);
  if (options.update !== undefined && options.slug !== undefined && options.update !== options.slug) throw new MemoryError('invalid', 'Conflicting update and slug', 'Supply only the existing --update slug');
  const key = slug(options.update ?? options.slug ?? `memory-${digest(fact).slice(0, 16)}`);
  const store = new Store(options);
  return store.write(async () => {
    const memories = await store.read();
    const previous = memories.find(item => item.slug === key);
    if (options.update !== undefined && previous === undefined) throw new MemoryError('missing', 'Update slug does not exist', 'Use remember --slug to create a new memory');
    const title = fact.trim().split('\n')[0].slice(0, 160).toWellFormed();
    const duplicate = memories.find(item => item.slug !== key && !item.artifact && similarity(`${title}\n${fact}`, `${item.title}\n${item.body}`) >= DUPLICATE_THRESHOLD);
    if (previous === undefined && duplicate !== undefined && !options.forceNew) throw new MemoryError('duplicate', `Near duplicate of ${duplicate.slug}`, `Use --update ${duplicate.slug} or --force-new with a distinct --slug`);
    const targets: string[] = [];
    for (const reference of options.links ?? []) {
      const target = memories.find(item => item.slug === reference)?.id ?? reference;
      await store.client.get(target); targets.push(target);
    }
    await store.register();
    const fields = { slug: key, kind: options.kind, why: options.why ?? previous?.why ?? '', how: options.how ?? previous?.how ?? '', pinned: options.pin ?? previous?.pinned ?? false, source: previous?.source ?? 'native:item', verdict: 'unknown', verified_at: '', recalls: previous?.recalls ?? 0, edited: true };
    let id: string;
    if (previous === undefined) {
      const created = await store.client.run('create', { options: { title, body: fact, type: 'Knowledge', tags: (options.tags ?? []).join(','), allowDuplicate: true, ...metadata(fields) } });
      id = parseMutationReceipt(created).id;
    } else {
      await store.history(previous.id);
      await store.client.update(previous.id, { title, body: fact, ...(options.tags === undefined ? {} : { tags: options.tags.join(',') }), message: 'Revise durable agent memory' });
      await store.fields(previous.id, fields); id = previous.id;
    }
    for (const target of targets) await store.link(id, target);
    return { id, slug: key, updated: previous !== undefined };
  });
}
/** Filter archived memories and lossless index artifacts out of active retrieval. */
export function active(memories: readonly Memory[]): Memory[] { return memories.filter(item => item.status !== 'canceled' && !item.artifact); }
/** Rank normalized lexical evidence with inverse document frequency, length normalization and bounded priors. */
export function scored(memories: readonly Memory[], query: string): { item: Memory; score: number }[] {
  const now = Date.now();
  const terms = [...words(query)];
  const documents = memories.map(item => words([item.slug, item.title, item.description, item.body, item.why, item.how, ...item.tags].join(' ')));
  const scores = memories.map((item, index) => {
    const heading = words(item.title);
    const hook = words(item.description);
    const key = words(item.slug);
    const lexical = terms.reduce((sum, term) => sum + (documents[index].has(term) ? (heading.has(term) ? 5 : hook.has(term) ? 2 : key.has(term) ? 1.5 : 1) * Math.log(1 + memories.length / (1 + documents.filter(doc => doc.has(term)).length)) / (1 + Math.log(1 + documents[index].size) / 10) : 0), 0);
    const ageDays = Math.max(0, (now - Date.parse(item.updated)) / 86400000);
    return { item, score: lexical * 10 + (item.pinned ? 0.5 : 0) + 0.2 / (1 + ageDays) };
  });
  return scores.sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug));
}
/** Preserve the public ranking projection while exposing scores in recall rows. */
export function rank(memories: readonly Memory[], query: string): Memory[] { return scored(memories, query).map(entry => entry.item); }
/** Return a query-centered excerpt without charging oversized full memory bodies to the packet. */
function excerpt(item: Memory, query: string, size: number): string {
  const source = [item.body, item.why, item.how].filter(Boolean).join('\n');
  const match = [...words(query)].map(term => source.toLowerCase().indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, (match.length === 0 ? 0 : Math.min(...match)) - 100);
  return source.slice(start, start + size).toWellFormed();
}
/** Retrieve a bounded packet and atomically count only memories actually emitted. */
export async function recall(query: string, options: MemoryOptions & { budget?: number; kind?: Memory['kind'] }): Promise<Packet> {
  text(query); const limit = budget(options.budget ?? 800);
  if (options.kind !== undefined) kind(options.kind);
  const store = new Store(options);
  return store.write(async () => {
    const memories = active(await store.read()).filter(item => options.kind === undefined || item.kind === options.kind);
    const rows: RecallRow[] = scored(memories, query).map(({ item, score }) => ({ slug: item.slug, kind: item.kind, pinned: item.pinned, description: (item.description || item.why || item.body).replace(/\s+/g, ' ').slice(0, 60).toWellFormed(), score: Math.round(score * 1000) / 1000 }));
    const packet = recallPacket(rows, memories, query, limit);
    if (packet.memories!.length > 0) await store.register();
    for (const row of packet.memories!) {
      const item = memories.find(memory => memory.slug === row.slug)!;
      if (item.recalls === Number.MAX_SAFE_INTEGER) throw new MemoryError('counter', 'Recall counter exhausted', 'Archive this memory or migrate its counter before recalling again');
      await store.fields(item.id, { recalls: item.recalls + 1 });
    }
    return packet;
  });
}
/** Pack compact rows in rank order first, then spend spare tokens on marked excerpts. */
export function recallPacket(rows: RecallRow[], memories: readonly Memory[], query: string, limit: number): Packet {
  const render = (selected: RecallRow[], omitted: number) => ({ memories: selected, omitted, complete: true as const });
  // Compact even the first description until its row fits; never skip a higher-ranked row.
  const firstRender = (selected: RecallRow[]) => render(selected, rows.length - selected.length);
  const compact = rows.map(row => ({ ...row }));
  if (compact.length > 0) {
    while (pack([compact[0]], limit, firstRender).memories!.length === 0 && (compact[0].description ?? '').length > 0) compact[0].description = compact[0].description!.slice(0, -1);
    if (pack([compact[0]], limit, firstRender).memories!.length === 0) throw new MemoryError('budget', 'Budget cannot hold the top memory row', 'Increase --budget to at least 200');
  }
  let packet = pack([], limit, render);
  for (let length = 1; length <= compact.length; length++) {
    const next = pack(compact.slice(0, length), limit, (selected) => render(selected, rows.length - selected.length));
    if (next.memories!.length !== length) break;
    packet = next;
  }
  for (let index = 0; index < packet.memories!.length; index++) {
    const item = memories.find(item => item.slug === packet.memories![index].slug)!;
    const content = excerpt(item, query, 800);
    for (let size = content.length; size > 0; size = Math.floor(size / 2)) {
      const selected = packet.memories!.map(row => ({ ...row }));
      selected[index].text = content.slice(0, size).toWellFormed() + (size < [item.body, item.why, item.how].filter(Boolean).join('\n').length ? ' […truncated; use pm memory get]' : '');
      const next = pack(selected, limit, (rows) => render(rows, packet.omitted));
      if (next.memories!.length === selected.length) { packet = next; break; }
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
export async function index(options: MemoryOptions & { budget?: number }): Promise<Packet> {
  const limit = budget(options.budget ?? 1500);
  const memories = active(await new Store(options).read()).sort(indexOrder);
  const rows = memories.map(item => `- [${item.title.replace(/[[\]\r\n]/g, ' ')}](${item.slug}) — ${(item.why || item.body).replace(/\s+/g, ' ').slice(0, 100).toWellFormed()}`);
  return pack(rows, limit, (selected, omitted) => ({ text: [...selected, `<!-- omitted: ${omitted} memories -->`].join('\n'), omitted, complete: true }));
}

/** Order index rows deterministically even when imported timestamps are identical. */
export function indexOrder(a: Memory, b: Memory): number {
  return Number(b.pinned) - Number(a.pinned) || a.kind.localeCompare(b.kind) || b.updated.localeCompare(a.updated) || a.slug.localeCompare(b.slug);
}
