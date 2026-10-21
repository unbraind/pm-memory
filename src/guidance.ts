import type { GuidanceOptions, GuidanceState, GuidanceWindow, Memory, RenewOptions } from './types.ts';
import { digest, MemoryError, privacy, slug, text } from './core.ts';
import { Store } from './store.ts';

/** Require canonical UTC instants, rejecting rollover dates and ambiguous local time. */
export function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new MemoryError('validity', 'Invalid guidance timestamp', 'Use a real UTC instant in YYYY-MM-DDTHH:mm:ss.sssZ format');
  return value;
}
/** Bind renewal evidence to semantic content without treating recall or verification as edits. */
export function guidanceHash(item: Memory): string {
  return digest(JSON.stringify([item.title, item.body, item.kind, item.why, item.how, item.tags]));
}
/** Validate persisted metadata before any retrieval or renewal, refusing malformed windows. */
export function readWindow(value: unknown): GuidanceWindow | undefined {
  if (value === undefined) return undefined;
  try {
    const entry: unknown = JSON.parse(text(value));
    if (entry === null || typeof entry !== 'object') throw new Error();
    const window = entry as Record<string, unknown>;
    const from = instant(window.from); const until = instant(window.until); const recordedAt = instant(window.recordedAt);
    if (from >= until || typeof window.evidence !== 'string' || window.evidence.trim() === '' || typeof window.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(window.contentHash) || typeof window.revision !== 'number' || !Number.isSafeInteger(window.revision) || window.revision < 1) throw new Error();
    return { from, until, recordedAt, evidence: window.evidence, contentHash: window.contentHash, revision: window.revision };
  } catch { throw new MemoryError('schema', 'Invalid guidance window metadata', 'Restore a valid memory_validity field from audited item history'); }
}
/** Evaluate the latest authored policy window, independently of claim verification and pin ranking. */
export function guidanceState(item: Memory, now: number): GuidanceState | undefined {
  const window = item.validity;
  if (window === undefined) return undefined;
  if (!item.pinned || guidanceHash(item) !== window.contentHash) return 'needs-renewal';
  if (now < Date.parse(window.from)) return 'scheduled';
  return now >= Date.parse(window.until) ? 'expired' : 'current';
}
/** Validate the explicit retrieval policy before reading or mutating a tracker. */
export function guidancePolicy(value: unknown): NonNullable<GuidanceOptions['validity']> {
  if (value === undefined) return 'exclude';
  if (value !== 'exclude' && value !== 'label') throw new MemoryError('validity', 'Unknown guidance retrieval policy', 'Use --validity exclude or --validity label');
  return value;
}
/** Apply a safe default to both lexical and semantic recall and to the agent index. */
export function eligibleGuidance(items: readonly Memory[], policy: NonNullable<GuidanceOptions['validity']>, now: number): Memory[] {
  return items.filter(item => { const state = guidanceState(item, now); return policy === 'label' || state === undefined || state === 'current'; });
}
/** Append an evidence-backed renewal through one native mutation under the shared process lock. */
export async function renew(key: string, options: RenewOptions): Promise<{ id: string; slug: string; validity: GuidanceWindow }> {
  slug(key); const from = instant(options.from); const until = instant(options.until);
  if (from >= until) throw new MemoryError('validity', 'Guidance window must end after it starts', 'Supply --valid-from earlier than --valid-until');
  const evidence = text(options.evidence).trim(); privacy(evidence);
  const store = new Store(options);
  return store.write(async () => {
    const item = (await store.read()).find(item => item.slug === key && item.status !== 'canceled' && !item.artifact);
    if (item === undefined) throw new MemoryError('missing', 'Memory slug does not exist', 'Use memory index to select an active slug');
    if (!item.pinned) throw new MemoryError('validity', 'Validity windows require pinned standing guidance', 'Use memory remember --update with --pin before renewing');
    const revision = (item.validity?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new MemoryError('validity', 'Guidance revision exhausted', 'Create a successor memory and retain this item history');
    await store.history(item.id); await store.register();
    const validity = { from, until, evidence, recordedAt: new Date().toISOString(), contentHash: guidanceHash(item), revision };
    await store.fields(item.id, { validity: JSON.stringify(validity) });
    return { id: item.id, slug: key, validity };
  });
}
