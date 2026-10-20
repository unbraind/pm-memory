import { jaccardSimilarity } from '@unbrained/pm-cli/sdk';
import { active, DUPLICATE_THRESHOLD } from './memory.ts';
import { digest, words, MemoryError } from './core.ts';
import { metadata, Store } from './store.ts';
import type { Memory, MemoryOptions, Proposal } from './types.ts';

/** Precomputed lexical evidence reused across every consolidation pair. */
interface Signals {
  /** Original native memory metadata. */
  item: Memory;
  /** Normalized semantic body words. */
  body: Set<string>;
  /** Guidance words excluding standing frequency modifiers. */
  guidance: string[];
  /** Distinct title word sequence. */
  title: string[];
  /** Distinct slug word sequence. */
  slug: string[];
  /** Combined title and body word sequence. */
  content: string[];
}
/** Prepare each potentially large memory body once instead of once per pair. */
function signals(item: Memory): Signals {
  const normalized = item.body.replace(/\b(?:never|do not|don't|must not|should not)\s+(enable|disable)\b/gi, (_match, verb: string) => verb.toLowerCase() === 'enable' ? 'disable' : 'enable').replace(/\b(?:not|never)\s+(?:required|forbidden)\b/gi, '');
  const body = words(normalized);
  return { item, body, guidance: [...body].filter(word => word !== 'always' && word !== 'never'), title: [...words(item.title)], slug: [...words(item.slug)], content: [...words(`${item.title}\n${item.body}`)] };
}
/** Detect opposite explicit guidance using cached lexical evidence. */
function opposite(left: Signals, right: Signals): boolean {
  const overlap = jaccardSimilarity(left.title, right.title) >= 0.5 || jaccardSimilarity(left.slug, right.slug) >= 0.5;
  /** Require one unambiguous opposing signal in each memory. */
  const exclusive = (yes: string, no: string): boolean => (left.body.has(yes) && !left.body.has(no) && right.body.has(no) && !right.body.has(yes)) || (left.body.has(no) && !left.body.has(yes) && right.body.has(yes) && !right.body.has(no));
  return overlap && ([['enable', 'disable'], ['required', 'forbidden']].some(([yes, no]) => exclusive(yes, no) && jaccardSimilarity(left.guidance.filter(word => word !== yes && word !== no), right.guidance.filter(word => word !== yes && word !== no)) >= DUPLICATE_THRESHOLD) || (exclusive('always', 'never') && jaccardSimilarity(left.guidance, right.guidance) >= DUPLICATE_THRESHOLD));
}
/** Detect explicit opposite guidance only when headings or slug tokens overlap strongly. */
export function contradicts(left: Memory, right: Memory): boolean { return opposite(signals(left), signals(right)); }
/** Produce deterministic, non-destructive proposals from a certified in-memory snapshot. */
export function proposals(memories: readonly Memory[], minAgeDays = 30): Proposal[] {
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) throw new MemoryError('invalid', 'Invalid archive age', 'Use --min-age-days with a nonnegative number');
  const rows = active(memories).sort((a, b) => a.updated.localeCompare(b.updated) || a.slug.localeCompare(b.slug)).map(signals);
  const result: Proposal[] = [];
  for (let i = 0; i < rows.length; i++) {
    const older = rows[i].item;
    if (older.verdict === 'stale' && older.recalls === 0 && !older.pinned && /^(?:missing path \S+ under roots|Path \S+ not found under the given roots \(add --root if it lives elsewhere\)|symbol absent in \d+ files searched|Exact package version absent in registry|HTTP endpoint returned 404 or 410)(?:; |$)/.test(older.reason ?? '') && Date.now() - Date.parse(older.updated) >= minAgeDays * 86400000) result.push({ action: 'archive', slug: older.slug, reason: `Stale: ${older.reason}; never recalled, not pinned, at least ${minAgeDays} days old` });
    for (const candidate of rows.slice(i + 1)) {
      const newer = candidate.item;
      if (newer.supersedes?.includes(older.id)) continue;
      if (opposite(rows[i], candidate)) result.push({ action: 'supersedes', slug: older.slug, target: newer.slug, reason: 'Overlapping identity with explicit opposite guidance; review evidence before applying' });
      else if (jaccardSimilarity(rows[i].content, candidate.content) >= DUPLICATE_THRESHOLD) result.push({ action: 'merge', slug: older.slug, target: newer.slug, reason: 'Normalized title and body similarity meets duplicate threshold' });
    }
  }
  const superseded = new Set(result.filter(proposal => proposal.action === 'supersedes').flatMap(proposal => [proposal.slug, proposal.target]));
  for (const { item } of rows) for (const id of item.supersedes ?? []) {
    superseded.add(item.slug);
    const older = memories.find(memory => memory.id === id);
    if (older !== undefined) superseded.add(older.slug);
  }
  const merges = result.filter(proposal => proposal.action === 'merge' && !superseded.has(proposal.slug));
  const selected = new Map(merges.map(proposal => [proposal.slug, proposal]));
  const targets = new Set([...selected.values()].map(proposal => proposal.target));
  const archived = new Set(result.filter(proposal => proposal.action === 'archive' && !targets.has(proposal.slug)).map(proposal => proposal.slug));
  return result.filter(proposal => !(proposal.action === 'supersedes' && archived.has(proposal.target!)) && !(proposal.action === 'archive' && targets.has(proposal.slug)) && !(proposal.action === 'merge' && (archived.has(proposal.slug) || targets.has(proposal.slug) || selected.get(proposal.slug) !== proposal)));
}
/** Durable merge evidence binds replay to the original source and both target states. */
interface MergeReceipt {
  /** Stable destination slug. */
  target: string;
  /** Exact intended merged body. */
  body: string;
  /** Content revision assigned by publication. */
  changed_at: string;
  /** Semantic source revision before cancellation. */
  source_revision: string;
  /** Destination revision before publication. */
  target_before: string;
  /** Destination revision after publication. */
  target_after: string;
}
/** Ignore operational metadata while detecting every acknowledged semantic edit. */
function revision(item: Memory): string {
  return digest(JSON.stringify([item.slug, item.title, item.description, item.body, item.kind, item.why, item.how, item.pinned, item.tags, item.updated]));
}
/** Refuse unsafe or legacy replay before any planned action can mutate tracker state. */
function mergeReceipt(source: Memory, memories: readonly Memory[]): MergeReceipt {
  let receipt: MergeReceipt;
  try { receipt = JSON.parse(source.merge) as MergeReceipt; }
  catch { throw new MemoryError('conflict', `Invalid pending memory merge on ${source.slug}`, `Inspect memory_merge on ${source.slug}; reconcile or clear it through an audited pm update before retrying`); }
  const target = memories.find(item => item.slug === receipt?.target && item.status !== 'canceled');
  if (target === undefined || typeof receipt.body !== 'string' || typeof receipt.changed_at !== 'string' || receipt.source_revision !== revision(source) || ![receipt.target_before, receipt.target_after].includes(revision(target))) throw new MemoryError('conflict', `Pending memory merge ${source.slug} -> ${target?.slug ?? 'unavailable target'} revisions changed`, `Preserve intervening edits, then reconcile or clear memory_merge on ${source.slug} through an audited pm update before retrying`);
  return receipt;
}
/** Preview consolidation without writes; explicitly applied actions preserve all content and audited history. */
export async function consolidate(options: MemoryOptions & { apply?: boolean; minAgeDays?: number }): Promise<{ applied: boolean; proposals: Proposal[] }> {
  const store = new Store(options);
  return store.write(async () => {
    const memories = await store.read();
    const pending = memories.filter(item => item.merge !== '').map(item => ({ action: 'merge' as const, slug: item.slug, target: mergeReceipt(item, memories).target, reason: 'Resume recorded memory merge' }));
    const reserved = new Set<string | undefined>(pending.flatMap(proposal => [proposal.slug, proposal.target]));
    const planned = [...pending, ...proposals(memories, options.minAgeDays).filter(proposal => !reserved.has(proposal.slug) && !reserved.has(proposal.target))];
    if (options.apply === true && planned.length > 0) await store.register();
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
          let receipt: MergeReceipt;
          if (older.merge !== '') receipt = mergeReceipt(older, await store.read());
          else {
            const current = (await store.read()).find(item => item.id === target.id)!;
            const body = `${current.body}\n\n### Consolidated context (${older.slug})\n${older.body}\n\n**Why:** ${older.why}\n**How to apply:** ${older.how}`;
            const changed_at = new Date().toISOString();
            receipt = { target: target.slug, body, changed_at, source_revision: revision(older), target_before: revision(current), target_after: revision({ ...current, body: body.trim(), updated: changed_at }) };
            await store.fields(older.id, { merge: JSON.stringify(receipt) });
          }
          await store.client.run('update', { id: target.id, options: { body: receipt.body, ...metadata({ edited: true, verdict: 'unknown', verified_at: '', changed_at: receipt.changed_at }), message: 'Retain merged memory content' } });
          await store.client.update(older.id, { status: 'canceled', closeReason: `Merged context linked to ${target.slug}; content retained`, message: 'Consolidate duplicate memory' });
          await store.fields(older.id, { merge: '' });
        }
      }
    }
    return { applied: options.apply === true, proposals: planned };
  });
}
