import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { hashHistoryStream, listMutationEvents, replayHistoryToTarget, writeFileAtomic, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import type { Store } from './store.ts';
import type { Memory } from './types.ts';
import { validWriteReceipt } from './portable-write.ts';
import { MemoryError } from './core.ts';
type HistoryEntry = Parameters<typeof replayHistoryToTarget>[0][number];

/** Persistent package namespace, copied with tracker data rather than tied to a path or slug. */
export const TRACKER_ORIGIN_FILE = 'memory-origin.json';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Immutable logical origin carried by every exported guidance record and copied at creation. */
export interface PortableOrigin {
  /** Origin tracker UUID, or an immutable history fingerprint for older raw intake. */
  tracker: string;
  /** Originating SDK item id. */
  id: string;
  /** SDK hash of the authoritative creation entry. */
  creation: string;
}
/** One authoritative SDK creation subject, including subjects whose item was deleted. */
export interface OriginCreator {
  /** Failed, compensated creation is not an intentionally deleted origin. */
  compensated?: boolean;
  /** Local SDK subject id. */
  id: string;
  /** Immutable native creation metadata. */
  metadata: ReturnType<typeof replayHistoryToTarget>['metadata'];
  /** Logical lineage identity, independent of current names. */
  origin: PortableOrigin;
}
/** Validate identity metadata before it can authorize a write. */
export function validOrigin(value: unknown): value is PortableOrigin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'creation,id,tracker' && typeof row.tracker === 'string' && (UUID.test(row.tracker) || /^[a-f0-9]{64}$/.test(row.tracker)) && typeof row.id === 'string' && row.id.length > 0 && !/[\s/\\\0]/.test(row.id) && typeof row.creation === 'string' && /^[a-f0-9]{64}$/.test(row.creation);
}
/** Compare only immutable namespace, subject and creation lineage. */
export function sameOrigin(a: PortableOrigin, b: PortableOrigin): boolean { return a.tracker === b.tracker && a.id === b.id && a.creation === b.creation; }
/** Legacy history identities remain stable when a namespace is initialized later. */
export function creatorMatchesOrigin(actual: OriginCreator, expected: PortableOrigin): boolean {
  return sameOrigin(actual.origin, expected) || (actual.metadata.memory_origin === undefined && expected.tracker === expected.creation && actual.id === expected.id && actual.origin.creation === expected.creation);
}
/** Read package namespace without initializing a tracker during a refused import. */
export async function readTrackerOrigin(store: Store): Promise<string | undefined> {
  let value: unknown;
  try {
    const handle = await open(join(store.workspace, TRACKER_ORIGIN_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!(await handle.stat()).isFile()) throw new Error(); value = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new MemoryError('origin_missing', 'Tracker origin metadata is unavailable', 'Restore the package-owned memory-origin.json; foreign metadata was not overwritten'); }
  if (value === null || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'id,owner' || !('owner' in value) || value.owner !== 'pm-memory-origin:1' || !('id' in value) || typeof value.id !== 'string' || !UUID.test(value.id)) throw new MemoryError('origin_missing', 'Foreign tracker origin metadata retained', 'Restore the package-owned memory-origin.json before importing bound guidance');
  return value.id;
}
/** Publish one namespace with create-only CAS; competing successful publication wins truthfully. */
export async function ensureTrackerOrigin(store: Store, onStep?: (step: string) => void | Promise<void>): Promise<string> {
  if (store.leases.getStore() === undefined) return store.write(() => ensureTrackerOrigin(store, onStep));
  const known = await readTrackerOrigin(store); if (known !== undefined) return known;
  await onStep?.('origin-read');
  const id = randomUUID(); const directory = join(store.workspace, 'runtime'); await mkdir(directory, { recursive: true });
  const staging = join(directory, `memory-origin-${id}.json`);
  try {
    await store.fence(() => writeFileAtomic(staging, JSON.stringify({ owner: 'pm-memory-origin:1', id })));
    await onStep?.('origin-staged');
    try { await store.fence(() => link(staging, join(store.workspace, TRACKER_ORIGIN_FILE))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new MemoryError('origin_missing', 'Tracker origin publication interrupted', 'Retry initialization; retain the tracker namespace and foreign files'); }
    await onStep?.('origin-published');
    return (await readTrackerOrigin(store))!;
  } finally { await rm(staging, { force: true }); }
}
/** Decode only an SDK creation entry; later native provenance edits cannot replace its origin. */
export function creator(id: string, entry: HistoryEntry, tracker: string | undefined): OriginCreator | undefined {
  try {
  const metadata = replayHistoryToTarget([entry], 0).metadata;
  if (metadata.type !== 'Knowledge' || typeof metadata.memory_slug !== 'string') return undefined;
  let origin: unknown;
  if (metadata.memory_origin !== undefined) {
    try { origin = JSON.parse(String(metadata.memory_origin)); } catch { return undefined; }
    if (!validOrigin(origin)) return undefined;
  } else { const creation = hashHistoryStream([entry]); origin = { tracker: tracker ?? creation, id, creation }; }
  return { id, metadata, origin: origin as PortableOrigin };
  } catch { return undefined; }
}
/** Require forward progress before trusting a bounded SDK history continuation. */
export function originCursor(page: Pick<Awaited<ReturnType<typeof listMutationEvents>>, 'has_more' | 'next_cursor'>, previous?: string): string | undefined {
  if (!page.has_more) return undefined;
  if (page.next_cursor === undefined || page.next_cursor === previous) throw new MemoryError('origin_missing', 'Origin history continuation is unavailable', 'Check pm health and retry; no names were used as identity');
  return page.next_cursor;
}
/** Read every creation through SDK pagination, retaining tombstones without scanning files by hand. */
export async function originCatalog(store: Store, liveIds?: ReadonlySet<string>, limit = 1000): Promise<{ tracker?: string; creators: OriginCreator[] }> {
  const tracker = await readTrackerOrigin(store); const creators: OriginCreator[] = []; let since: string | undefined;
  for (;;) {
    const page = await listMutationEvents({ pmRoot: store.workspace, type: 'create', full: true, limit, ...(since === undefined ? {} : { since }) });
    for (const event of page.events) if (event.entry !== undefined) {
      const row = creator(event.item_id, event.entry, tracker);
      if (row === undefined) continue;
      if (liveIds !== undefined && !liveIds.has(row.id)) {
        const last = (await readHistoryEntries(getHistoryPath(store.workspace, row.id), row.id)).at(-1);
        row.compensated = last?.op === 'delete' && await compensatedOrigin(store, row.id, last.message);
      }
      creators.push(row);
    }
    const next = originCursor(page, since); if (next === undefined) break; since = next;
  }
  return { tracker, creators };
}
/** Read legacy deletion receipts for backward compatibility; current rollback only cancels. */
async function compensatedOrigin(store: Store, id: string, message: string | undefined): Promise<boolean> {
  const hint = /^bulk-item-transaction (memory-policy-(?:mutate-[a-f0-9]{24}|[a-f0-9]{40})-rollback) /.exec(message ?? '');
  if (hint === null) return false;
  try {
    const journal = JSON.parse(await readFile(join(store.workspace, 'transactions', 'sdk', `${hint[1]}.json`), 'utf8')) as { status?: unknown; results?: Record<string, { owner?: unknown; id?: unknown; writes?: unknown[] }> };
    if (journal.status !== 'committed' || journal.results === null || typeof journal.results !== 'object') return false;
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
    return Object.values(journal.results).some(result => result?.owner === 'pm-memory-policy-rollback:1' && result.id === id && Array.isArray(result.writes) && result.writes.some(value => validWriteReceipt(value) && value.id === id && value.after?.hash === null && value.after.length === entries.length && value.after.history === hashHistoryStream(entries)));
  } catch { return false; }
}
/** Resolve an exported origin before considering aliases; known deleted identities need explicit recreation. */
export function selectOrigin(origin: PortableOrigin, current: readonly Memory[], catalog: Awaited<ReturnType<typeof originCatalog>>, create: boolean): Memory | undefined {
  const matches = catalog.creators.filter(row => creatorMatchesOrigin(row, origin));
  const live = current.filter(item => matches.some(row => row.id === item.id));
  if (live.length > 1) throw new MemoryError('origin_missing', 'Origin has multiple live native copies', 'Export the intended native origin explicitly; aliases cannot resolve this ambiguity');
  if (live.length === 1) return live[0];
  if (!create && (catalog.tracker === origin.tracker || matches.some(row => !row.compensated) || (catalog.tracker === undefined && catalog.creators.some(row => row.id === origin.id && row.origin.creation === origin.creation)))) throw new MemoryError('origin_missing', 'The exported origin no longer exists', 'Restore the original item, or use memory import --create to explicitly create a new copy');
  return undefined;
}
/** Obtain an origin from immutable SDK creation history, never from a current display alias. */
export async function itemOrigin(store: Store, id: string, catalog?: Awaited<ReturnType<typeof originCatalog>>): Promise<PortableOrigin> {
  await ensureTrackerOrigin(store);
  const row = (catalog ?? await originCatalog(store)).creators.find(row => row.id === id);
  if (row === undefined) throw new MemoryError('origin_missing', 'Native creation identity is unavailable', 'Restore native history or explicitly create a new guidance origin');
  return row.origin;
}
