import { jaccardSimilarity } from '@unbrained/pm-cli/sdk';
import { active, DUPLICATE_THRESHOLD } from './memory.ts';
import { words } from './core.ts';
import { Store } from './store.ts';
import type { Memory, MemoryOptions, Proposal } from './types.ts';

/** Precomputed lexical evidence reused across every consolidation pair. */
interface Signals {
  /** Original native memory metadata. */
  item: Memory;
  /** Normalized semantic body words. */
  body: Set<string>;
  /** Distinct title word sequence. */
  title: string[];
  /** Distinct slug word sequence. */
  slug: string[];
  /** Combined title and body word sequence. */
  content: string[];
}
/** Prepare each potentially large memory body once instead of once per pair. */
function signals(item: Memory): Signals {
  return { item, body: words(item.body), title: [...words(item.title)], slug: [...words(item.slug)], content: [...words(`${item.title}\n${item.body}`)] };
}
/** Detect opposite explicit guidance using cached lexical evidence. */
function opposite(left: Signals, right: Signals): boolean {
  const overlap = jaccardSimilarity(left.title, right.title) >= 0.5 || jaccardSimilarity(left.slug, right.slug) >= 0.5;
  return overlap && [['enable', 'disable'], ['always', 'never'], ['required', 'forbidden']].some(([yes, no]) => (left.body.has(yes) && right.body.has(no)) || (left.body.has(no) && right.body.has(yes)));
}
/** Detect explicit opposite guidance only when headings or slug tokens overlap strongly. */
export function contradicts(left: Memory, right: Memory): boolean { return opposite(signals(left), signals(right)); }
/** Produce deterministic, non-destructive proposals from a certified in-memory snapshot. */
export function proposals(memories: readonly Memory[]): Proposal[] {
  const rows = active(memories).sort((a, b) => a.updated.localeCompare(b.updated) || a.slug.localeCompare(b.slug)).map(signals);
  const result: Proposal[] = [];
  for (let i = 0; i < rows.length; i++) {
    const older = rows[i].item;
    if (older.verdict === 'stale' && older.recalls === 0 && !older.pinned) result.push({ action: 'archive', slug: older.slug, reason: 'Stale, never recalled and not pinned' });
    for (const candidate of rows.slice(i + 1)) {
      const newer = candidate.item;
      if (opposite(rows[i], candidate)) result.push({ action: 'supersedes', slug: older.slug, target: newer.slug, reason: 'Overlapping identity with explicit opposite guidance; review evidence before applying' });
      else if (jaccardSimilarity(rows[i].content, candidate.content) >= DUPLICATE_THRESHOLD) result.push({ action: 'merge', slug: older.slug, target: newer.slug, reason: 'Normalized title and body similarity meets duplicate threshold' });
    }
  }
  return result;
}
/** Preview consolidation without writes; explicitly applied actions preserve all content and audited history. */
export async function consolidate(options: MemoryOptions & { apply?: boolean }): Promise<{ applied: boolean; proposals: Proposal[] }> {
  const store = new Store(options);
  return store.write(async () => {
    const memories = await store.read(); const planned = proposals(memories);
    if (options.apply === true) for (const proposal of planned) {
      const older = memories.find(item => item.slug === proposal.slug)!;
      await store.history(older.id);
      if (proposal.action === 'archive') {
        await store.client.comments(older.id, { add: `Memory archive: ${proposal.reason}`, ifAbsent: true });
        await store.client.update(older.id, { status: 'canceled', closeReason: proposal.reason, message: 'Archive unused stale memory' });
      } else {
        const target = memories.find(item => item.slug === proposal.target)!;
        await store.history(target.id);
        await store.link(target.id, older.id, proposal.action === 'supersedes' ? 'supersedes' : 'related');
        await store.client.comments(target.id, { add: `Memory ${proposal.action}: ${older.slug}; ${proposal.reason}. Original content retained in its Knowledge item and append-only history.`, ifAbsent: true });
        if (proposal.action === 'merge') {
          const current = (await store.client.get(target.id, { full: true })).item;
          await store.client.update(target.id, { body: `${String(current.body)}\n\n### Consolidated context (${older.slug})\n${older.body}\n\n**Why:** ${older.why}\n**How to apply:** ${older.how}`, message: 'Retain merged memory content' });
          await store.fields(target.id, { edited: true, verdict: 'unknown', verified_at: '' });
          await store.client.update(older.id, { status: 'canceled', closeReason: `Merged context linked to ${target.slug}; content retained`, message: 'Consolidate duplicate memory' });
        }
      }
    }
    return { applied: options.apply === true, proposals: planned };
  });
}
