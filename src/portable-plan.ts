import { mkdir, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic, deriveMutationTransactionId, WorkspaceTransactionInterruptedError, commitWorkspaceTransaction, appendWorkspaceAuditEvent, getItemAt, getHistoryPath, readHistoryEntries, hashHistoryStream } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation, ItemDocument } from '@unbrained/pm-cli/sdk';
import { commitPortableBatch, nativeState, publishPending, validNativeProof } from './portable-write.ts';
import type { Publication } from './portable-write.ts';
import { digest, MemoryError } from './core.ts';
import type { PortableImportResult, PortableImportOptions } from './portable.ts';
import type { Store } from './store.ts';
import { relationshipPatch, validOwnedTarget } from './portable-ownership.ts';
import type { OwnedTarget } from './portable-ownership.ts';
import { validOrigin } from './portable-origin.ts';
import type { PortableOrigin } from './portable-origin.ts';
import { previewOwnedItems, prepareImportNodes, captureBirths, sealBirths } from './portable-preview.ts';

const IMPORT_ID = /^memory-policy-(?:mutate-[a-f0-9]{24}|[a-f0-9]{40})$/;
/** Last observed token makes private intent replacement conditional on exact ownership. */
const intentTokens = new WeakMap<ImportPlan, string>();
/** Reserve a unique invocation identity; completed journals can never suppress another import. */
export async function importIdentity(store: Store, input: string, candidate: string = randomUUID()): Promise<{ attempt: string; transactionId: string }> {
  for (;;) {
    const transactionId = `memory-policy-${deriveMutationTransactionId(JSON.stringify([input, candidate]))}`;
    const occupied = await Promise.all(['', '-nodes', '-snapshot'].map(async suffix => {
      try { await access(join(store.workspace, 'transactions', 'sdk', `${transactionId}${suffix}.json`)); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new MemoryError('transaction', 'Portable transaction namespace is unavailable', 'Restore access to transactions/sdk and retry'); }
    }));
    if (!occupied.some(Boolean)) return { attempt: candidate, transactionId };
    candidate = randomUUID();
  }
}
/** SDK revision identity plus immutable history prefix captured while planning. */
export interface ExpectedTarget {
  /** Native target identity reserved before a planned creation exists. */
  id: string;
  /** Complete SDK-normalized base for the fields the mutation changes. */
  document?: ItemDocument | null;
  /** Unique portable identity also guarded against a new competing owner. */
  slug: string;
  /** Exported immutable lineage, never resolved from a mutable alias. */
  origin?: PortableOrigin;
  /** Observed SDK revision, used for diagnostics rather than native-writer isolation. */
  version: string | null;
  /** Expected number of immutable history entries. */
  length: number;
  /** SDK hash of the expected immutable history prefix. */
  history: string;
}
/** Capture SDK-normalized field bases while the package lease is held. */
export async function expectedTargets(store: Store, targets: readonly Pick<ExpectedTarget, 'id' | 'slug' | 'origin'>[], _observed?: readonly { id: string; updated_at: string }[]): Promise<ExpectedTarget[]> {
  return Promise.all(targets.map(async target => {
    const { document, proof } = await nativeState(store, target.id);
    const observed = _observed?.find(row => row.id === target.id);
    if (_observed !== undefined && observed === undefined) return { ...target, document: null, version: null, length: 0, history: hashHistoryStream([]) };
    if (observed !== undefined && observed.updated_at !== document?.metadata.updated_at) {
      const entries = await readHistoryEntries(getHistoryPath(store.workspace, target.id), target.id);
      for (let length = entries.length; length > 0; length--) {
        const historical = await getItemAt(target.id, String(length), { pmRoot: store.workspace });
        if (historical.document.metadata.updated_at === observed.updated_at) return { ...target, document: historical.document, version: observed.updated_at, length, history: hashHistoryStream(entries.slice(0, length)) };
      }
      throw new MemoryError('history', 'Observed native base is unavailable', 'Preserve native history and export the current item before retrying');
    }
    return { ...target, document, version: proof.version, length: proof.length, history: proof.history };
  }));
}
/** Frozen SDK batch bound to the target history positions that it replaces. */
export interface ImportPlan {
  /** Immutable-origin selection format. */
  identityVersion?: 1;
  /** Forward-only intent format; older plans are retired without restoring anything. */
  forwardOnly?: 1;
  /** In-flight forward publication, never an instruction to restore values. */
  publication?: Publication;
  /** Identities actually written during this invocation. */
  applied?: string[];
  /** Planned outcome per native id keeps partial-success counters truthful. */
  outcomes?: Record<string, 'imported' | 'updated' | 'unchanged'>;
  /** Input bytes and metadata, independent of the target generation. */
  input: string;
  /** Attributed SDK operation identity. */
  author: string;
  /** Target-revision-and-content identity. */
  transactionId: string;
  /** UUID component bound to the input digest and persisted before the first write. */
  attempt?: string;
  /** Exact ordered batch retained across interruptions. */
  mutations: BulkItemMutation[];
  /** Portable ownership is retained in SDK journal results, outside native item fields. */
  ownership?: OwnedTarget[];
  /** Edge-free creation batch ensures a partial graph never references absent nodes. */
  nodes?: BulkItemMutation[];
  /** Complete independent SDK birth documents, frozen before source writes. */
  births?: { id: string; document: string; message?: string }[];
  /** True once all nodes exist and full data mutations carry captured SDK revisions. */
  nodesDone?: boolean;
  /** Package-owned graph members needed to resolve portable relationship identities. */
  members: string[];
  /** Expected native revision/history of every admitted target and dependency. */
  expected: ExpectedTarget[];
  /** Receipt for the operation being recovered. */
  result: PortableImportResult;
}
/** Wrap SDK failures without claiming reversal of already completed forward writes. */
export function planError(error: unknown): never {
  if (error instanceof MemoryError || error instanceof WorkspaceTransactionInterruptedError) throw error;
  const pending = [error];
  while (pending.length > 0) { const failure = pending.shift(); if (failure instanceof WorkspaceTransactionInterruptedError) throw failure; if (failure instanceof AggregateError) pending.push(...failure.errors); }
  const failure = new MemoryError('transaction', 'Portable import interrupted after zero or more forward writes', 'Rerun the input; completed items are retained and current native conflicts are reported'); failure.cause = error; throw failure;
}
/** Resolve only this package's private runtime slot. */
function intentPath(store: Store): string { return join(store.workspace, 'runtime', 'memory-policy-import.json'); }
/** Read a bounded, checksummed intent without adopting foreign records. */
async function readIntent(store: Store, strict = true): Promise<{ payload: string } | undefined | 'foreign'> {
  let value: unknown;
  try { value = JSON.parse(await readFile(intentPath(store), 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'foreign'; }
  if (value === null || typeof value !== 'object' || !('owner' in value) || value.owner !== 'pm-memory-policy-plan:1') return 'foreign';
  if (!('payload' in value) || typeof value.payload !== 'string' || !('checksum' in value) || digest(value.payload) !== value.checksum) { if (!strict) return 'foreign'; throw new MemoryError('history', 'Invalid portable import intent checksum', 'Preserve the owned intent and restore its verified copy'); }
  if (Object.keys(value).length !== 3) return 'foreign';
  return { payload: value.payload };
}
/** Remove only the exact slot observed by this live package lease. */
async function removeIntent(store: Store, plan: ImportPlan): Promise<boolean> {
  return store.fence(async () => { const current = await readIntent(store, false); if (current === 'foreign' || current?.payload !== intentTokens.get(plan)) return current === undefined; await rm(intentPath(store)); return true; });
}
/** Foreign private records are left byte-for-byte intact with an explicit reason. */
export function foreignIntentResult(): PortableImportResult { return { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: [{ slug: 'pending-import', reason: 'Foreign pending import record retained' }] }; }
/** Frozen legacy requests are checked for package shape, then retired rather than executed. */
function validIntent(plan: ImportPlan): boolean {
  if (!Array.isArray(plan.members) || !plan.members.every(id => typeof id === 'string') || !Array.isArray(plan.expected)) return false;
  if (!plan.expected.every(row => row !== null && typeof row === 'object' && typeof row.id === 'string' && typeof row.slug === 'string' && (row.version === null || typeof row.version === 'string') && Number.isSafeInteger(row.length) && row.length >= 0 && typeof row.history === 'string' && (row.origin === undefined || validOrigin(row.origin)))) return false;
  const batch = (rows: unknown): boolean => Array.isArray(rows) && rows.every(value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return ['create', 'update'].includes(String(row.op)) && typeof row.id === 'string' && row.options !== null && typeof row.options === 'object' && !Array.isArray(row.options) && plan.expected.some(target => target.id === row.id);
  });
  return batch(plan.mutations) && (plan.nodes === undefined || batch(plan.nodes));
}
/** Legacy plans are retired without executing frozen mutations or restoring historical values. */
export async function pendingImport(store: Store, _onStep?: PortableImportOptions['onStep'], _onTransition?: PortableImportOptions['onTransition']): Promise<undefined | 'foreign'> {
  if (store.leases.getStore() === undefined) return store.write(() => pendingImport(store, _onStep, _onTransition));
  const current = await readIntent(store); if (current === undefined || current === 'foreign') return current;
  let plan: ImportPlan;
  try {
    plan = JSON.parse(current.payload) as ImportPlan;
    if (plan === null || !IMPORT_ID.test(plan.transactionId) || typeof plan.input !== 'string' || typeof plan.author !== 'string' || !validIntent(plan)) throw new Error();
    if (plan.forwardOnly !== undefined && plan.forwardOnly !== 1) throw new Error();
    if (plan.publication !== undefined && (plan.forwardOnly !== 1 || typeof plan.publication.id !== 'string' || typeof plan.publication.stepId !== 'string' || !IMPORT_ID.test(plan.publication.transactionId) || !validNativeProof(plan.publication.before) || !/^[a-f0-9]{64}$/.test(plan.publication.proposed) || !validOwnedTarget(plan.publication.target) || plan.publication.id !== plan.publication.target.id)) throw new Error();
  } catch { throw new MemoryError('history', 'Invalid portable import intent', 'Preserve the owned intent and restore its verified copy'); }
  intentTokens.set(plan, current.payload);
  if (plan.forwardOnly === 1) await publishPending(store, plan, { onStep: _onStep, onTransition: _onTransition });
  await appendWorkspaceAuditEvent({ pmRoot: store.workspace, op: 'memory_import_replan', author: store.author, message: plan.forwardOnly === 1 ? 'Retired interrupted forward import; retain completed writes and replan current state' : 'Discarded legacy import intent without restoring values; replan current state', context: { transactionId: plan.transactionId, format: plan.forwardOnly === 1 ? 'forward-only' : 'legacy' }, lockTtlSeconds: 120, lockWaitMs: 10000 });
  await _onStep?.('retire-audit');
  const removed = await removeIntent(store, plan); await _onStep?.('retired-intent');
  return removed ? undefined : 'foreign';
}
/** Every adapter retires old plans before independently planning the current input. */
export async function recoverInput(store: Store, _input: string, options: PortableImportOptions): Promise<PortableImportResult | undefined> {
  try { return await pendingImport(store, options.onStep, options.onTransition) === 'foreign' ? foreignIntentResult() : undefined; } catch (error) { if (error instanceof MemoryError && error.code === 'foreign_intent') return foreignIntentResult(); return planError(error); }
}
/** Persist forward progress only while this lease still owns the exact runtime slot. */
export async function savePlan(store: Store, plan: ImportPlan): Promise<void> {
  const payload = JSON.stringify(plan);
  await store.fence(async () => {
    const current = await readIntent(store, false);
    if (current === 'foreign' || current !== undefined && current.payload !== intentTokens.get(plan)) throw new MemoryError('foreign_intent', 'Foreign pending import retained', 'Retry after its owner finishes; no foreign record was removed');
    await writeFileAtomic(intentPath(store), JSON.stringify({ owner: 'pm-memory-policy-plan:1', payload, checksum: digest(payload) })); intentTokens.set(plan, payload);
  });
}
/** Preview the same native operations without committing source items. */
export async function previewImport(store: Store, plan: ImportPlan, onStep?: PortableImportOptions['onStep']): Promise<void> {
  if (plan.mutations.some(row => row.op === 'create')) plan.nodes = prepareImportNodes(plan);
  const mutations = [...plan.mutations.filter(row => row.op === 'create'), ...plan.mutations.filter(row => row.op === 'update')].map(row => { const mutation = { ...row }; if (mutation.op === 'update') delete mutation.match; return mutation; });
  try { await previewOwnedItems(store, plan, mutations, onStep); } catch (error) { return planError(error); }
}
/** Validate the immutable read-set shape before schema registration and SDK preview. */
export async function validateImportPlan(_store: Store, plan: ImportPlan, _onStep?: PortableImportOptions['onStep']): Promise<void> {
  if (!plan.expected.every(target => target.origin === undefined || validOrigin(target.origin)) || plan.mutations.some(row => !plan.expected.some(target => target.id === row.id))) throw new MemoryError('history', 'Incomplete portable import read set', 'Export the current inventory and retry');
}
/** Count only actual forward writes and currently admitted no-op items, including partial success. */
function forwardResult(plan: ImportPlan): PortableImportResult {
  if (plan.outcomes === undefined) return plan.result;
  const result = { ...plan.result, imported: 0, updated: 0, unchanged: 0 };
  const applied = new Set(plan.applied); const skipped = new Set(result.skipped.flatMap(row => row.conflict === undefined ? [] : [row.conflict.item]));
  for (const [id, outcome] of Object.entries(plan.outcomes)) if (outcome === 'unchanged' ? !skipped.has(id) : applied.has(id)) result[outcome]++;
  return result;
}
/** Apply item steps once, retaining partial success and never issuing inverse mutations. */
export async function applyImport(store: Store, plan: ImportPlan, options: PortableImportOptions): Promise<PortableImportResult> {
  try {
    plan.forwardOnly = 1;
    await mkdir(join(store.workspace, 'runtime'), { recursive: true });
    if (plan.nodes === undefined && plan.mutations.some(row => row.op === 'create')) { plan.nodes = prepareImportNodes(plan); await captureBirths(store, plan); sealBirths(plan); }
    await savePlan(store, plan); await options.onStep?.('intent');
    await commitWorkspaceTransaction({ pmRoot: store.workspace, author: plan.author, transactionId: plan.transactionId, steps: [{ id: 'attempt', inspect: async () => ({ state: 'pending' }), apply: async () => ({ input: plan.input }), compensate: async () => {} }] });
    if (plan.nodes !== undefined) {
      await commitPortableBatch(store, plan, `${plan.transactionId}-nodes`, 'nodes', plan.nodes, options);
      const failed = new Set(plan.result.skipped.flatMap(row => row.conflict === undefined ? [] : [row.conflict.item]));
      const created = plan.mutations.filter(row => row.op === 'create' && !failed.has(row.id));
      const fresh = await expectedTargets(store, created.map(row => plan.expected.find(target => target.id === row.id)!));
      plan.expected = plan.expected.map(row => fresh.find(target => target.id === row.id) ?? row);
      plan.mutations = plan.mutations.flatMap(row => {
        if (row.op !== 'create') return [row];
        if (failed.has(row.id)) return [];
        const patch = relationshipPatch([], plan.ownership!.find(target => target.id === row.id)!.graph);
        return Object.keys(patch).length === 0 ? [] : [{ op: 'update' as const, id: row.id, options: patch }];
      });
      await savePlan(store, plan); await options.onStep?.('nodes');
    }
    await commitPortableBatch(store, plan, plan.transactionId, 'data', plan.mutations, options);
    await options.onStep?.('readback'); await options.onStep?.('published');
    plan.result = forwardResult(plan);
    if (!await removeIntent(store, plan)) plan.result.skipped.push(...foreignIntentResult().skipped);
    return plan.result;
  } catch (error) { if (error instanceof MemoryError && error.code === 'foreign_intent') return { ...forwardResult(plan), skipped: [...plan.result.skipped, ...foreignIntentResult().skipped] }; return planError(error); }
}
