import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic, commitItemMutations, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation } from '@unbrained/pm-cli/sdk';
import { digest, MemoryError } from './core.ts';
import type { PortableImportResult, PortableImportOptions } from './portable.ts';
import { metadata } from './store.ts';
import type { Store } from './store.ts';
import { snapshotDigest, portableRelationships } from './portable.ts';

/** Frozen SDK batch bound to the target history positions that it replaces. */
export interface ImportPlan {
  /** Input bytes and metadata, independent of the target generation. */
  input: string;
  /** Attributed SDK operation identity. */
  author: string;
  /** Target-revision-and-content identity. */
  transactionId: string;
  /** Exact ordered batch retained across interruptions. */
  mutations: BulkItemMutation[];
  /** Package-owned graph members needed to resolve portable relationship identities. */
  members: string[];
  /** Receipt for the operation being recovered. */
  result: PortableImportResult;
}
/** Resolve the single pending import slot under the package writer lease. */
function intentPath(store: Store): string { return join(store.workspace, 'runtime', 'memory-policy-import.json'); }
/** Read a regular JSON file, leaving absent state absent. */
async function optionalJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new MemoryError('history', 'Unreadable portable import journal', 'Preserve the pending import journal and restore a verified copy before retrying'); }
}
/** Recover only checksummed package-owned plans; completed plans never suppress a later import. */
export async function pendingImport(store: Store): Promise<ImportPlan | undefined | 'foreign'> {
  let value: unknown;
  try { value = await optionalJson(intentPath(store)); } catch { return 'foreign'; }
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || !('owner' in value) || value.owner !== 'pm-memory-policy-plan:1') return 'foreign';
  if (!('payload' in value) || typeof value.payload !== 'string' || !('checksum' in value) || digest(value.payload) !== value.checksum) throw new MemoryError('history', 'Invalid portable import plan checksum', 'Preserve and restore the pending import journal before retrying');
  let plan: ImportPlan;
  try {
    plan = JSON.parse(value.payload) as ImportPlan;
    if (!/^memory-policy-[a-f0-9]{40}$/.test(plan.transactionId) || typeof plan.input !== 'string' || typeof plan.author !== 'string' || !Array.isArray(plan.members) || !plan.members.every(id => typeof id === 'string')) throw new Error();
    if (!Array.isArray(plan.mutations) || !plan.mutations.every(row => (row.op === 'create' || row.op === 'update') && typeof row.id === 'string' && typeof row.options === 'object' && row.options !== null)) throw new Error();
  } catch { throw new MemoryError('history', 'Invalid portable import plan', 'Preserve and restore the pending import journal before retrying'); }
  const journal = await optionalJson(join(store.workspace, 'transactions', 'sdk', `${plan.transactionId}-snapshot.json`));
  if (typeof journal === 'object' && journal !== null && 'status' in journal && journal.status === 'committed') { await rm(intentPath(store)); return undefined; }
  return plan;
}
/** Persist the frozen plan before the SDK's first write, then remove only that owned intent after commit. */
export async function applyImport(store: Store, plan: ImportPlan, options: PortableImportOptions): Promise<PortableImportResult> {
  await mkdir(join(store.workspace, 'runtime'), { recursive: true });
  const payload = JSON.stringify(plan);
  await writeFileAtomic(intentPath(store), JSON.stringify({ owner: 'pm-memory-policy-plan:1', payload, checksum: digest(payload) }));
  await options.onStep?.('intent');
  await store.fence(() => commitItemMutations({ pmRoot: store.workspace, author: plan.author, transactionId: plan.transactionId, mutations: plan.mutations, onTransition: options.onTransition }));
  const current = await store.read(new Set(plan.members));
  const mutations: BulkItemMutation[] = [];
  for (const mutation of plan.mutations) {
    const item = current.find(item => item.id === mutation.id)!;
    const last = (await readHistoryEntries(getHistoryPath(store.workspace, item.id), item.id)).at(-1)!;
    if (!(last.message?.includes(plan.transactionId) || (mutation.op === 'create' && last.op === 'create'))) throw new MemoryError('conflict', 'Native edit interrupted portable provenance capture', 'Preserve the pending plan and reconcile the native edit before retrying');
    mutations.push({ op: 'update', id: item.id, options: metadata({ import_snapshot: snapshotDigest(item, item.body, portableRelationships(item, current)) }) });
  }
  await options.onStep?.('readback');
  await store.fence(() => commitItemMutations({ pmRoot: store.workspace, author: plan.author, transactionId: `${plan.transactionId}-snapshot`, mutations, onTransition: options.onTransition }));
  await options.onStep?.('published');
  await rm(intentPath(store));
  return plan.result;
}
