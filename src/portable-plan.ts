import { mkdir, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic, commitItemMutations, commitWorkspaceTransaction, deriveMutationTransactionId, getHistoryPath, readHistoryEntries, hashHistoryStream, certifyCompleteListResult, WorkspaceTransactionInterruptedError, PmClient, isPmCliExpectedError, replayHistoryToTarget } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation, WorkspaceTransactionJsonValue } from '@unbrained/pm-cli/sdk';
import { replanNodes } from './portable-replan.ts';
import { digest, MemoryError } from './core.ts';
import type { PortableImportResult, PortableImportOptions } from './portable.ts';
import type { Store } from './store.ts';
import { guardedCompensation, rollbackImport } from './portable-rollback.ts';
import { relationshipPatch, validOwnedTarget } from './portable-ownership.ts';
import type { OwnedTarget } from './portable-ownership.ts';

/** SDK-derived attempts and the earlier private content/history identity format. */
const IMPORT_ID = /^memory-policy-(?:mutate-[a-f0-9]{24}|[a-f0-9]{40})$/;

/** A fresh attempt identity survives deletion and is durably recorded in its intent. */
export async function importIdentity(store: Store, input: string, candidate: string = randomUUID()): Promise<{ attempt: string; transactionId: string }> {
  for (;;) {
    const transactionId = `memory-policy-${deriveMutationTransactionId(JSON.stringify([input, candidate]))}`;
    const occupied = await Promise.all(['', '-nodes', '-snapshot', '-rollback'].map(async suffix => {
      try { await access(join(store.workspace, 'transactions', 'sdk', `${transactionId}${suffix}.json`)); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new MemoryError('transaction', 'Portable transaction namespace is unavailable', 'Restore access to transactions/sdk and retry the import'); }
    }));
    if (!occupied.some(Boolean)) return { attempt: candidate, transactionId };
    candidate = randomUUID();
  }
}

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
export async function expectedTargets(store: Store, targets: readonly Pick<ExpectedTarget, 'id' | 'slug'>[], observed?: readonly { id: string; updated_at: string }[]): Promise<ExpectedTarget[]> {
  const items = observed ?? certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
  return Promise.all(targets.map(async target => {
    const item = items.find(item => item.id === target.id);
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, target.id), target.id);
    return { ...target, version: item === undefined ? null : String(item.updated_at), length: entries.length, history: hashHistoryStream(entries) };
  }));
}
/** Halt SDK replay without compensation when a newer native revision must win. */
class PlanMoved extends Error {}
/** A newly reserved identity occupied by a foreign record produces a skip receipt. */
class PlanForeign extends PlanMoved {}
/** A foreign file in the private intent slot must never be overwritten or removed. */
class ForeignIntent extends WorkspaceTransactionInterruptedError {}
/** Last observed or published token, separate from mutable next-stage plan values. */
const intentTokens = new WeakMap<ImportPlan, string>();
/** Preserve deliberate crash injection even when the SDK wraps compensation errors. */
function interruption(error: unknown): WorkspaceTransactionInterruptedError | undefined {
  if (error instanceof WorkspaceTransactionInterruptedError) return error;
  if (error instanceof AggregateError) return error.errors.map(interruption).find(value => value !== undefined);
  return undefined;
}
/** Refuse a moved plan before any further write, including recovery and SDK boundaries. */
async function guardPlan(store: Store, plan: ImportPlan): Promise<void> {
  // Read inside the existing fence without recursively acquiring that fence.
  const client = new PmClient({ pmRoot: store.workspace, noExtensions: true });
  const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
  for (const expected of plan.expected) {
    const item = items.find(item => item.id === expected.id);
    if (items.some(row => row.memory_slug === expected.slug && row.id !== expected.id)) throw new PlanMoved('Portable target ownership moved');
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, expected.id), expected.id);
    const tail = entries.slice(expected.length);
    const mutation = plan.mutations.find(row => row.id === expected.id);
    if (mutation?.op === 'update' && (mutation.match?.key !== 'updated_at' || mutation.match.value !== expected.version)) throw new PlanMoved('Planned SDK CAS revision differs from its captured expectation');
    const unchanged = tail.length === 0 && (item === undefined ? null : String(item.updated_at)) === expected.version;
    const owned = tail.length > 0 && tail.every((entry, index) => {
      if (mutation?.op === 'create' && expected.version === null && entry.op === 'create' && entry.author === plan.author) {
        const created = replayHistoryToTarget(entries, expected.length + index).metadata;
        return created.memory_original === mutation.options.memoryOriginal && created.memory_source === mutation.options.memorySource;
      }
      return entry.message?.startsWith(`bulk-item-transaction ${plan.transactionId} `) || entry.message?.startsWith(`bulk-item-transaction ${plan.transactionId}-snapshot `) || (entry.op === 'delete' && entry.author === plan.author && entry.message === `Compensate interrupted bulk transaction ${plan.transactionId}-nodes`);
    });
    if (expected.version === null && item !== undefined && !owned) throw new PlanForeign('Foreign record occupies the reserved import id');
    if (hashHistoryStream(entries.slice(0, expected.length)) !== expected.history || !(unchanged || owned)) throw new PlanMoved('Portable import target revision moved');
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
  /** UUID component bound to the input digest and persisted before the first write. */
  attempt?: string;
  /** Exact ordered batch retained across interruptions. */
  mutations: BulkItemMutation[];
  /** Frozen SDK read-back provenance batch, retained once captured. */
  snapshots?: BulkItemMutation[];
  /** Portable ownership is retained in SDK journal results, outside native item fields. */
  ownership?: OwnedTarget[];
  /** Edge-free creation batch ensures a partial graph never references absent nodes. */
  nodes?: BulkItemMutation[];
  /** True once all nodes exist and full data mutations carry SDK-read CAS revisions. */
  nodesDone?: boolean;
  /** Package-owned graph members needed to resolve portable relationship identities. */
  members: string[];
  /** Expected native revision/history of every admitted target and dependency. */
  expected: ExpectedTarget[];
  /** Original pre-import revisions retained across all node/data/provenance stages. */
  initial?: ExpectedTarget[];
  /** Monotonic rollback state retained when a refusal itself is interrupted. */
  refusing?: boolean;
  /** Earlier attempt identities whose partial writes remain owned during recovery. */
  ownedTransactions?: string[];
  /** Receipt for the operation being recovered. */
  result: PortableImportResult;
}
/** Turn moved-state refusals into the public package error without exposing input data. */
export function planError(error: unknown): never {
  if (error instanceof MemoryError || error instanceof WorkspaceTransactionInterruptedError) throw error;
  if (error instanceof PlanMoved || (isPmCliExpectedError(error) && ['upsert_match_changed', 'upsert_key_conflict', 'item_already_exists'].includes(String(error.code)))) throw new MemoryError('conflict', 'Portable import target revision changed', 'Retry the portable import; newer native edits are retained and owned partial changes are compensated');
  throw new MemoryError('transaction', 'Portable import transaction failed', 'Retry the same input to complete recovery; preserve the owned intent and inspect pm health if recovery refuses');
}
/** Every path reads revisions, validates the old read set, then applies SDK CAS. */
export async function readGuardApply<T>(store: Store, plan: ImportPlan, onStep: PortableImportOptions['onStep'], apply: (expected: ExpectedTarget[]) => Promise<T>): Promise<T> {
  const expected = await expectedTargets(store, plan.expected);
  await onStep?.('cas-read');
  await guardPlan(store, plan);
  await onStep?.('cas-guarded');
  // This final check includes dependencies without their own mutation/CAS row.
  await guardPlan(store, plan);
  return apply(expected);
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
/** All harness adapters recover the same input under the same ownership contract. */
export async function recoverInput(store: Store, input: string, options: PortableImportOptions): Promise<PortableImportResult | undefined> {
  const pending = await pendingImport(store, options.onStep, options.onTransition);
  if (pending === 'foreign') return foreignIntentResult();
  if (pending === undefined) return undefined;
  if (pending.input !== input) throw new MemoryError('conflict', 'Another portable import needs recovery', 'Rerun the interrupted input before importing a different manifest');
  return applyImport(store, pending, options);
}
/** Finish only the published import whose intent token is still owned. */
async function publishedImport(store: Store, plan: ImportPlan, options: PortableImportOptions): Promise<PortableImportResult> {
  await options.onStep?.('published');
  if (!await removeIntent(store, plan)) return { ...plan.result, skipped: [...plan.result.skipped, ...foreignIntentResult().skipped] };
  return plan.result;
}
/** Both old plans and interrupted refusals finish the same guarded SDK compensation. */
async function drainRefusal(store: Store, plan: ImportPlan, onStep?: PortableImportOptions['onStep'], onTransition?: PortableImportOptions['onTransition']): Promise<undefined | 'foreign'> {
  try { await rollbackImport(store, plan, { workspace: store.workspace, from: 'agents-md', onStep, onTransition }); }
  catch (error) { return planError(interruption(error) ?? error); }
  return await removeIntent(store, plan) ? undefined : 'foreign';
}
/** Recover only checksummed package-owned plans; completed plans never suppress a later import. */
export async function pendingImport(store: Store, onStep?: PortableImportOptions['onStep'], onTransition?: PortableImportOptions['onTransition']): Promise<ImportPlan | undefined | 'foreign'> {
  if (store.leases.getStore() === undefined) return store.write(() => pendingImport(store, onStep, onTransition));
  let value: unknown;
  try { value = await optionalJson(intentPath(store)); } catch { return 'foreign'; }
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || !('owner' in value) || value.owner !== 'pm-memory-policy-plan:1') return 'foreign';
  if (!('payload' in value) || typeof value.payload !== 'string' || !('checksum' in value) || digest(value.payload) !== value.checksum) throw new MemoryError('history', 'Invalid portable import plan checksum', 'Preserve and restore the pending import journal before retrying');
  let plan: ImportPlan;
  try {
    plan = JSON.parse(value.payload) as ImportPlan;
    if (!IMPORT_ID.test(plan.transactionId) || typeof plan.input !== 'string' || typeof plan.author !== 'string' || !Array.isArray(plan.members) || !plan.members.every(id => typeof id === 'string')) throw new Error();
    if (plan.nodesDone !== undefined && typeof plan.nodesDone !== 'boolean') throw new Error();
    if (plan.attempt !== undefined && (typeof plan.attempt !== 'string' || !/^[a-f0-9-]{36}$/.test(plan.attempt))) throw new Error();
    if (plan.refusing !== undefined && typeof plan.refusing !== 'boolean') throw new Error();
    if (plan.ownership !== undefined && (!Array.isArray(plan.ownership) || !plan.ownership.every(row => validOwnedTarget(row) && plan.expected.some(target => target.id === row.id)))) throw new Error();
    if (plan.ownedTransactions !== undefined && (!Array.isArray(plan.ownedTransactions) || !plan.ownedTransactions.every(id => typeof id === 'string' && IMPORT_ID.test(id)))) throw new Error();
    if (!Array.isArray(plan.expected) || !plan.expected.every(row => typeof row.id === 'string' && typeof row.slug === 'string' && (row.version === null || typeof row.version === 'string') && Number.isSafeInteger(row.length) && row.length >= 0 && typeof row.history === 'string')) throw new Error();
    if (plan.initial !== undefined && (!Array.isArray(plan.initial) || !plan.initial.every(row => row !== null && typeof row === 'object' && typeof row.id === 'string' && plan.expected.some(target => target.id === row.id) && (row.version === null || typeof row.version === 'string')))) throw new Error();
    if (![plan.mutations, ...(plan.nodes === undefined ? [] : [plan.nodes]), ...(plan.snapshots === undefined ? [] : [plan.snapshots])].every(batch => validBatch(batch, plan.expected))) throw new Error();
    if (plan.ownership !== undefined && plan.mutations.some(row => !plan.ownership!.some(target => target.id === row.id))) throw new Error();
  } catch { throw new MemoryError('history', 'Invalid portable import plan', 'Preserve and restore the pending import journal before retrying'); }
  intentTokens.set(plan, value.payload);
  if (plan.refusing) return drainRefusal(store, plan, onStep, onTransition);
  const journal = await optionalJson(join(store.workspace, 'transactions', 'sdk', `${plan.transactionId}-snapshot.json`));
  if (typeof journal === 'object' && journal !== null && 'status' in journal && journal.status === 'committed') { await onStep?.('recover-published'); return await removeIntent(store, plan) ? undefined : 'foreign'; }
  if (plan.ownership === undefined) {
    // Older frozen whole-record plans must compensate before the current adapter replans.
    if (plan.initial === undefined) plan.initial = plan.expected.map(target => plan.nodes?.some(row => row.id === target.id) ? { ...target, version: null, length: 0, history: hashHistoryStream([]) } : target);
    plan.refusing = true; await savePlan(store, plan);
    return drainRefusal(store, plan, onStep, onTransition);
  }
  const data = await optionalJson(join(store.workspace, 'transactions', 'sdk', `${plan.transactionId}.json`));
  if ((typeof data === 'object' && data !== null && 'status' in data && data.status === 'compensated') || (typeof journal === 'object' && journal !== null && 'status' in journal && journal.status === 'compensated')) {
    const token = value.payload;
    try {
      return await readGuardApply(store, plan, onStep, async expected => {
        const { snapshots: _snapshots, ...prior } = plan;
        const next = { ...prior, expected, ownedTransactions: [...(plan.ownedTransactions ?? []), plan.transactionId], ...await importIdentity(store, plan.input), mutations: plan.mutations.map(row => ({ ...row, match: { key: 'updated_at', value: expected.find(target => target.id === row.id)!.version } })) };
        intentTokens.set(next, token); return next;
      });
    } catch (error) {
      const crash = interruption(error); if (crash !== undefined) throw crash;
      try { return await refuseImport(store, plan, { workspace: store.workspace, from: 'agents-md', onStep, onTransition }, error); }
      catch (failure) { if (failure instanceof ForeignIntent) return 'foreign'; return planError(interruption(failure) ?? failure); }
    }
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
  try { return await runImport(store, plan, options); }
  catch (error) {
    if (error instanceof ForeignIntent) return foreignIntentResult();
    const crash = interruption(error); if (crash !== undefined) throw crash;
    try { return await refuseImport(store, plan, options, error); }
    catch (failure) {
      if (failure instanceof ForeignIntent) return foreignIntentResult();
      if (failure instanceof PlanForeign) return { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: plan.expected.map(row => ({ slug: row.slug, reason: 'Foreign record occupies the reserved import id; dependent plan compensated' })) };
      return planError(interruption(failure) ?? failure);
    }
  }
}
/** Complete a recoverable, guarded SDK rollback before clearing only this intent. */
async function refuseImport(store: Store, plan: ImportPlan, options: PortableImportOptions, error: unknown): Promise<never> {
  plan.refusing = true;
  await savePlan(store, plan);
  await rollbackImport(store, plan, options);
  await removeIntent(store, plan);
  if (error instanceof PlanForeign) throw error;
  return planError(error);
}
/** Validate the captured read set before schema writes or SDK preview. */
export async function validateImportPlan(store: Store, plan: ImportPlan, onStep?: PortableImportOptions['onStep']): Promise<void> {
  try { await readGuardApply(store, plan, onStep, async () => {}); } catch (error) { return planError(error); }
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
  /** Validate every target before writing, and let ordinary refusals compensate. */
  const commit = async (transactionId: string, mutations: BulkItemMutation[]) => {
    await readGuardApply(store, plan, options.onStep, async () => {
      await store.fence(() => guardedCompensation(store, plan, () => commitItemMutations({ pmRoot: store.workspace, author: plan.author, transactionId, mutations, createCompensation: 'delete', onTransition: async event => {
        await options.onTransition?.(event);
        if (!event.transition.includes('compensat')) await guardPlan(store, plan);
      } })));
    });
  };
  if (plan.nodes !== undefined && !plan.nodesDone) {
    try { await commit(`${plan.transactionId}-nodes`, plan.nodes); }
    catch (error) {
      if (!isPmCliExpectedError(error) || error.code !== 'item_identity_reserved') throw error;
      const next = await replanNodes(store, plan);
      intentTokens.set(next, intentTokens.get(plan)!);
      await validateImportPlan(store, plan, options.onStep);
      return runImport(store, next, options);
    }
    await readGuardApply(store, plan, options.onStep, async expected => {
    plan.mutations = plan.mutations.map(row => {
      if (row.op !== 'create') return row;
      const { type: _type, allowDuplicate: _duplicate, ...options } = row.options;
      return { op: 'update', id: row.id, match: { key: 'updated_at', value: expected.find(target => target.id === row.id)!.version }, options: { ...options, allowUnresolvedDeps: false, ...relationshipPatch([], plan.ownership!.find(target => target.id === row.id)!.graph) } };
    });
    plan.expected = expected; plan.nodesDone = true;
    });
    await savePlan(store, plan);
    await options.onStep?.('nodes');
  }
  await commit(plan.transactionId, plan.mutations);
  await options.onStep?.('readback');
  await readGuardApply(store, plan, options.onStep, () => store.fence(() => commitWorkspaceTransaction({ pmRoot: store.workspace, author: plan.author, transactionId: `${plan.transactionId}-snapshot`, steps: plan.ownership!.map((target, index) => {
    const id = `${index + 1}-ownership-${target.id}`;
    return {
      id,
      /** SDK journal completion, rather than mutable native fields, proves publication. */
      inspect: async () => {
        const journal = await optionalJson(join(store.workspace, 'transactions', 'sdk', `${plan.transactionId}-snapshot.json`)) as { results?: Record<string, WorkspaceTransactionJsonValue> } | undefined;
        const result = journal?.results?.[id];
        return result === undefined ? { state: 'pending' } : { state: 'applied', result };
      },
      /** Retain the represented input without altering native bookkeeping or foreign values. */
      apply: async () => JSON.parse(JSON.stringify({ owner: 'pm-memory-policy-ownership:1', targets: [target] })) as WorkspaceTransactionJsonValue,
      /** Ownership receipts have no domain mutation to undo; outer rollback restores data. */
      compensate: async () => {},
    };
  }), onTransition: async event => { await options.onTransition?.(event); if (!event.transition.includes('compensat')) await guardPlan(store, plan); } })));
  return publishedImport(store, plan, options);
}
