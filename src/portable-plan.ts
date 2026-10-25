import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic, commitItemMutations, getHistoryPath, readHistoryEntries, hashHistoryStream, certifyCompleteListResult, WorkspaceTransactionInterruptedError, PmClient, hashDocument, canonicalDocument, isPmCliExpectedError, replayHistoryToTarget } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation } from '@unbrained/pm-cli/sdk';
import { replanNodes } from './portable-replan.ts';
import { digest, MemoryError } from './core.ts';
import type { PortableImportResult, PortableImportOptions } from './portable.ts';
import { metadata } from './store.ts';
import type { Store } from './store.ts';
import { snapshotDigest, portableRelationships } from './portable.ts';

/** SDK revision identity plus immutable history prefix read while planning. */
export interface ExpectedTarget {
  /** Native target identity reserved before a planned creation exists. */
  id: string;
  /** Unique portable identity also guarded against a new competing owner. */
  slug: string;
  /** SDK restorable revision checked atomically by update.match. */
  version: string | null;
  /** Expected number of immutable history entries. */
  length: number;
  /** SDK hash of the expected immutable history prefix. */
  history: string;
}
/** Capture expected target state through the SDK before constructing a batch. */
export async function expectedTargets(store: Store, targets: readonly Pick<ExpectedTarget, 'id' | 'slug'>[]): Promise<ExpectedTarget[]> {
  const items = certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
  return Promise.all(targets.map(async target => {
    const item = items.find(item => item.id === target.id);
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, target.id), target.id);
    return { ...target, version: item === undefined ? null : String(item.updated_at), length: entries.length, history: hashHistoryStream(entries) };
  }));
}
/** Halt SDK replay without compensation when a newer native revision must win. */
class PlanMoved extends WorkspaceTransactionInterruptedError {}
/** A foreign file in the private intent slot must never be overwritten or removed. */
class ForeignIntent extends WorkspaceTransactionInterruptedError {}
/** Last observed or published token, separate from mutable next-stage plan values. */
const intentTokens = new WeakMap<ImportPlan, string>();
/** Refuse a moved plan before any further write, including recovery and SDK boundaries. */
async function guardPlan(store: Store, plan: ImportPlan, checked = new Map<string, string>()): Promise<void> {
  // Read inside the existing fence without recursively acquiring that fence.
  const client = new PmClient({ pmRoot: store.workspace, noExtensions: true });
  const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
  for (const expected of plan.expected) {
    const item = items.find(item => item.id === expected.id);
    if (items.some(row => row.memory_slug === expected.slug && row.id !== expected.id)) throw new PlanMoved('Portable target ownership moved');
    const document = item === undefined ? undefined : canonicalDocument({ metadata: item, body: String(item.body) });
    const witness = document === undefined ? 'absent' : hashDocument(document);
    if (checked.get(expected.id) === witness) continue;
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, expected.id), expected.id);
    const tail = entries.slice(expected.length);
    const mutation = plan.mutations.find(row => row.id === expected.id);
    if (mutation?.op === 'update' && (mutation.match?.key !== 'updated_at' || mutation.match.value !== expected.version)) throw new PlanMoved('Planned SDK CAS revision differs from its captured expectation');
    const unchanged = tail.length === 0 && (item === undefined ? null : String(item.updated_at)) === expected.version;
    const owned = tail.length > 0 && tail.every((entry, index) => {
      if (mutation?.op === 'create' && expected.version === null && entry.op === 'create' && entry.author === plan.author) {
        const created = replayHistoryToTarget(entries, expected.length + index).metadata;
        return created.memory_original === mutation.options.memoryOriginal && created.memory_source === 'portable:policy-v1';
      }
      return entry.message?.startsWith(`bulk-item-transaction ${plan.transactionId} `) || entry.message?.startsWith(`bulk-item-transaction ${plan.transactionId}-snapshot `) || (entry.op === 'delete' && entry.author === plan.author && entry.message === `Compensate interrupted bulk transaction ${plan.transactionId}-nodes`);
    });
    if (hashHistoryStream(entries.slice(0, expected.length)) !== expected.history || !(unchanged || owned)) throw new PlanMoved('Portable import target revision moved');
    checked.set(expected.id, witness);
  }
}
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
  /** Frozen SDK read-back provenance batch, retained once captured. */
  snapshots?: BulkItemMutation[];
  /** Edge-free creation batch ensures a partial graph never references absent nodes. */
  nodes?: BulkItemMutation[];
  /** True once all nodes exist and full data mutations carry SDK-read CAS revisions. */
  nodesDone?: boolean;
  /** Package-owned graph members needed to resolve portable relationship identities. */
  members: string[];
  /** Expected native revision/history of every admitted target and dependency. */
  expected: ExpectedTarget[];
  /** Receipt for the operation being recovered. */
  result: PortableImportResult;
}
/** Turn moved-state refusals into the public package error without exposing input data. */
export function planError(error: unknown): never {
  if (error instanceof PlanMoved || (isPmCliExpectedError(error) && ['upsert_match_changed', 'upsert_key_conflict', 'item_already_exists'].includes(String(error.code)))) throw new MemoryError('conflict', 'Portable import target revision changed', 'Export current guidance for review. If runtime/memory-policy-import.json exists, preserve it and remove only the verified owned intent after reconciliation, then import the reviewed export');
  throw error;
}
/** Validate each frozen SDK batch and require a target expectation for every mutation. */
function validBatch(value: unknown, expected: ExpectedTarget[]): value is BulkItemMutation[] {
  return Array.isArray(value) && value.every((value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    if ((row.op !== 'create' && row.op !== 'update') || typeof row.id !== 'string' || row.options === null || typeof row.options !== 'object') return false;
    const guard = row.op === 'create' ? row.unique : row.match;
    if (guard === null || typeof guard !== 'object' || Array.isArray(guard)) return false;
    const key = guard as Record<string, unknown>;
    return key.key === (row.op === 'create' ? 'memory_slug' : 'updated_at') && typeof key.value === 'string' && expected.some(target => target.id === row.id);
  });
}
/** Resolve the single pending import slot under the package writer lease. */
function intentPath(store: Store): string { return join(store.workspace, 'runtime', 'memory-policy-import.json'); }
/** Read a regular JSON file, leaving absent state absent. */
async function optionalJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new MemoryError('history', 'Unreadable portable import journal', 'Preserve the pending import journal and restore a verified copy before retrying'); }
}
/** Check the current slot immediately before lease-fenced replacement or removal. */
async function ownsIntent(store: Store, plan: ImportPlan): Promise<'owned' | 'absent' | 'foreign'> {
  let value: unknown;
  try { value = await optionalJson(intentPath(store)); } catch { return 'foreign'; }
  if (value === undefined) return 'absent';
  if (value === null || typeof value !== 'object' || Object.keys(value).length !== 3 || !('owner' in value) || value.owner !== 'pm-memory-policy-plan:1' || !('payload' in value) || typeof value.payload !== 'string' || !('checksum' in value) || digest(value.payload) !== value.checksum) return 'foreign';
  return intentTokens.get(plan) === value.payload ? 'owned' : 'foreign';
}
/** Delete only the exact intent last written by this operation, under its live lease. */
async function removeIntent(store: Store, plan: ImportPlan): Promise<boolean> {
  return store.fence(async () => { const owner = await ownsIntent(store, plan); if (owner === 'foreign') return false; if (owner === 'owned') await rm(intentPath(store)); return true; });
}
/** Compact refusal when another tool owns the intent slot. */
export function foreignIntentResult(): PortableImportResult { return { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: [{ slug: 'pending-import', reason: 'Foreign pending import record retained' }] }; }
/** Recover only checksummed package-owned plans; completed plans never suppress a later import. */
export async function pendingImport(store: Store, onStep?: PortableImportOptions['onStep']): Promise<ImportPlan | undefined | 'foreign'> {
  if (store.leases.getStore() === undefined) return store.write(() => pendingImport(store, onStep));
  let value: unknown;
  try { value = await optionalJson(intentPath(store)); } catch { return 'foreign'; }
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || !('owner' in value) || value.owner !== 'pm-memory-policy-plan:1') return 'foreign';
  if (!('payload' in value) || typeof value.payload !== 'string' || !('checksum' in value) || digest(value.payload) !== value.checksum) throw new MemoryError('history', 'Invalid portable import plan checksum', 'Preserve and restore the pending import journal before retrying');
  let plan: ImportPlan;
  try {
    plan = JSON.parse(value.payload) as ImportPlan;
    if (!/^memory-policy-[a-f0-9]{40}$/.test(plan.transactionId) || typeof plan.input !== 'string' || typeof plan.author !== 'string' || !Array.isArray(plan.members) || !plan.members.every(id => typeof id === 'string')) throw new Error();
    if (plan.nodesDone !== undefined && typeof plan.nodesDone !== 'boolean') throw new Error();
    if (!Array.isArray(plan.expected) || !plan.expected.every(row => typeof row.id === 'string' && typeof row.slug === 'string' && (row.version === null || typeof row.version === 'string') && Number.isSafeInteger(row.length) && row.length >= 0 && typeof row.history === 'string')) throw new Error();
    if (![plan.mutations, ...(plan.nodes === undefined ? [] : [plan.nodes]), ...(plan.snapshots === undefined ? [] : [plan.snapshots])].every(batch => validBatch(batch, plan.expected))) throw new Error();
  } catch { throw new MemoryError('history', 'Invalid portable import plan', 'Preserve and restore the pending import journal before retrying'); }
  intentTokens.set(plan, value.payload);
  const journal = await optionalJson(join(store.workspace, 'transactions', 'sdk', `${plan.transactionId}-snapshot.json`));
  if (typeof journal === 'object' && journal !== null && 'status' in journal && journal.status === 'committed') { await onStep?.('recover-published'); return await removeIntent(store, plan) ? undefined : 'foreign'; }
  const data = await optionalJson(join(store.workspace, 'transactions', 'sdk', `${plan.transactionId}.json`));
  if ((typeof data === 'object' && data !== null && 'status' in data && data.status === 'compensated') || (typeof journal === 'object' && journal !== null && 'status' in journal && journal.status === 'compensated')) {
    try { await guardPlan(store, plan); } catch (error) { return planError(error); }
    const expected = await expectedTargets(store, plan.expected);
    const { snapshots: _snapshots, ...prior } = plan;
    const next = { ...prior, expected, transactionId: `memory-policy-${digest(JSON.stringify([plan.input, expected])).slice(0, 40)}`, mutations: plan.mutations.map(row => ({ ...row, match: { key: 'updated_at', value: expected.find(target => target.id === row.id)!.version } })) };
    intentTokens.set(next, value.payload); return next;
  }
  return plan;
}
/** Replace only the lease-owned intent slot with the next complete recovery stage. */
async function savePlan(store: Store, plan: ImportPlan): Promise<void> {
  const payload = JSON.stringify(plan);
  await store.fence(async () => {
    if (await ownsIntent(store, plan) === 'foreign') throw new ForeignIntent();
    await writeFileAtomic(intentPath(store), JSON.stringify({ owner: 'pm-memory-policy-plan:1', payload, checksum: digest(payload) }));
    intentTokens.set(plan, payload);
  });
}
/** Publish or recover a validated plan, returning only typed moved-state refusals. */
export async function applyImport(store: Store, plan: ImportPlan, options: PortableImportOptions): Promise<PortableImportResult> {
  try { return await runImport(store, plan, options); } catch (error) { if (error instanceof ForeignIntent) return foreignIntentResult(); return planError(error); }
}
/** Validate the captured read set before schema writes or SDK preview. */
export async function validateImportPlan(store: Store, plan: ImportPlan): Promise<void> {
  try { await guardPlan(store, plan); } catch (error) { return planError(error); }
}
/** Persist the frozen plan before the SDK's first write, then remove only that owned intent after commit. */
async function runImport(store: Store, plan: ImportPlan, options: PortableImportOptions): Promise<PortableImportResult> {
  await mkdir(join(store.workspace, 'runtime'), { recursive: true });
  if (plan.nodes === undefined && plan.mutations.some(row => row.op === 'create')) plan.nodes = plan.mutations.filter(row => row.op === 'create').map(row => {
    const { dep: _dep, allowUnresolvedDeps: _unresolved, ...options } = row.options;
    return { ...row, options };
  });
  await savePlan(store, plan);
  await options.onStep?.('intent');
  const checked = new Map<string, string>();
  /** Keep the SDK's item-lock CAS and interrupt, rather than compensate over a native edit. */
  const commit = async (transactionId: string, mutations: BulkItemMutation[]) => {
    try {
      await guardPlan(store, plan, checked);
      await store.fence(() => commitItemMutations({ pmRoot: store.workspace, author: plan.author, transactionId, mutations, createCompensation: 'delete', onTransition: async event => {
        try { await options.onTransition?.(event); } finally { await guardPlan(store, plan, checked); }
      } }));
    } catch (error) {
      return planError(error);
    }
  };
  if (plan.nodes !== undefined && !plan.nodesDone) {
    try { await commit(`${plan.transactionId}-nodes`, plan.nodes); }
    catch (error) {
      if (!isPmCliExpectedError(error) || error.code !== 'item_identity_reserved') throw error;
      const next = await replanNodes(store, plan);
      intentTokens.set(next, intentTokens.get(plan)!);
      await guardPlan(store, plan, checked);
      return runImport(store, next, options);
    }
    const expected = await expectedTargets(store, plan.expected);
    await guardPlan(store, plan, checked);
    plan.mutations = plan.mutations.map(row => {
      if (row.op !== 'create') return row;
      const { type: _type, allowDuplicate: _duplicate, ...options } = row.options;
      return { op: 'update', id: row.id, match: { key: 'updated_at', value: expected.find(target => target.id === row.id)!.version }, options: { ...options, allowUnresolvedDeps: false, ...(Array.isArray(options.dep) && options.dep.length > 0 ? { replaceDeps: true } : { clearDeps: true }) } };
    });
    plan.expected = expected; plan.nodesDone = true;
    await savePlan(store, plan);
    await options.onStep?.('nodes');
  }
  await commit(plan.transactionId, plan.mutations);
  const current = await store.read(new Set(plan.members));
  const mutations: BulkItemMutation[] = [];
  for (const mutation of plan.mutations) {
    const item = current.find(item => item.id === mutation.id)!;
    const native = (await store.client.get(item.id, { full: true })).item;
    mutations.push({ op: 'update', id: item.id, match: { key: 'updated_at', value: native.updated_at }, options: metadata({ import_snapshot: snapshotDigest(item, item.body, portableRelationships(item, current)) }) });
  }
  if (plan.snapshots === undefined) { plan.snapshots = mutations; await savePlan(store, plan); }
  await options.onStep?.('readback');
  await commit(`${plan.transactionId}-snapshot`, plan.snapshots);
  await options.onStep?.('published');
  if (!await removeIntent(store, plan)) return { ...plan.result, skipped: [...plan.result.skipped, ...foreignIntentResult().skipped] };
  return plan.result;
}
