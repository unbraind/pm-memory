import { resolve } from 'node:path';
import { certifyCompleteListResult, getItemAt, getHistoryPath, readHistoryEntries, hashHistoryStream, runWithActiveExtensions, create, update, commitWorkspaceTransaction, itemDocumentToMutationOptions, resolveRuntimeFieldRegistry } from '@unbrained/pm-cli/sdk';
import type { ItemDocument, BulkItemMutation, WorkspaceTransactionJsonValue } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook } from '@unbrained/pm-cli/sdk/authoring';
import type { ImportPlan } from './portable-plan.ts';
import type { Store } from './store.ts';
import { isDeepStrictEqual } from 'node:util';
import { savePlan, importIdentity, retainForwardWrites } from './portable-plan.ts';
import type { OwnedTarget } from './portable-ownership.ts';
import { foreignMemories, type ImportConflict, type PortableImportOptions } from './portable.ts';
import { birthDocument } from './portable-preview.ts';
import { digest, MemoryError } from './core.ts';

import { guardedHostCreate, guardedHostUpdate } from './native-host.ts';
import { installStandaloneGuard, documentHash, nativeState, sameNativeProof, trackerSchema } from './native-revision.ts';
import type { NativeProof } from './native-revision.ts';

export { validNativeProof } from './native-revision.ts';
/** Native keys for exactly the semantic option scope carried by portable requests. */
const SEMANTIC_OPTIONS: ReadonlyMap<string, string> = new Map([['title', 'title'], ['description', 'description'], ['body', 'body'], ['tags', 'tags'], ['memoryKind', 'memory_kind'], ['memoryWhy', 'memory_why'], ['memoryHow', 'memory_how'], ['memoryPinned', 'memory_pinned']]);
/** SDK-normalized fields that invalidate verification when their actual values change. */
const SEMANTIC_FIELDS: ReadonlySet<string> = new Set(SEMANTIC_OPTIONS.values());
/** One in-flight forward publication, needed only to recognize a write interrupted before its receipt. */
export interface Publication {
  /** Immutable target and unique publication journal identity. */
  id: string;
  /** Unique per-write SDK receipt identity, never a content-only key. */
  transactionId: string;
  /** Unique SDK publication message; older interrupted proposals cannot establish ownership. */
  message?: string;
  /** Stable native step used to finish this same publication after interruption. */
  stepId: string;
  /** Exact SDK history position before this forward write. */
  before: NativeProof;
  /** Exact SDK-normalized proposed document hash, persisted before the write. */
  proposed: string;
  /** Represented input whose successful forward write will be published. */
  target: OwnedTarget;
}
/** Compact typed conflict values are fingerprints of SDK-normalized fields, never echoed bodies. */
export function importConflict(item: string, fields: string[], base: Record<string, unknown>, current: Record<string, unknown>): ImportConflict {
  const hashes = (values: Record<string, unknown>) => Object.fromEntries(fields.map(field => [field, digest(JSON.stringify({ present: Object.hasOwn(values, field), value: values[field] }))]));
  return { code: 'import_conflict', item, fields, base: hashes(base), current: hashes(current), remedy: 'Export the current target and reconcile these fields before retrying; prior successful writes were retained' };
}
/** A moved item is a typed skip, not an instruction to undo preceding writes. */
export class ImportMoved extends Error {
  /** Public field-level conflict receipt. */
  readonly conflict: ImportConflict;
  /** Carry safe field fingerprints to the result. */
  constructor(conflict: ImportConflict) { super('Portable import base changed'); this.conflict = conflict; }
}
/** Compare only fields the actual SDK mutation changes, using SDK-normalized documents on both sides. */
export function assertBase(id: string, base: ItemDocument | null, before: ItemDocument | null, after: ItemDocument | null): string[] {
  const original = { ...base?.metadata, body: base?.body }; const current = { ...before?.metadata, body: before?.body }; const next = { ...after?.metadata, body: after?.body };
  const from = new Map(Object.entries(original)); const now = new Map(Object.entries(current)); const to = new Map(Object.entries(next));
  const fields = [...new Set([...now.keys(), ...to.keys()])].filter(key => !['updated_at', 'created_at'].includes(key) && !isDeepStrictEqual(now.get(key), to.get(key)));
  const conflicts = fields.filter(key => !isDeepStrictEqual(now.get(key), from.get(key)));
  if (base === null && before !== null || base !== null && before === null) conflicts.push('id');
  if (before !== null && (before.metadata.type !== 'Knowledge' || typeof before.metadata.memory_slug !== 'string' || foreignMemories([{ ...before.metadata, type: String(before.metadata.type) }]).length > 0)) conflicts.push('type', 'memory_source');
  if (base !== null && before !== null) for (const key of ['type', 'memory_source'] as const) if (!isDeepStrictEqual(base.metadata[key], before.metadata[key])) conflicts.push(key);
  if (conflicts.length > 0) throw new ImportMoved(importConflict(id, conflicts, original, current));
  return fields;
}
/** Recover only the exact SDK history append represented by the durable forward proposal. */
async function publicationResult(store: Store, pending: Publication): Promise<{ owner: string; targets: OwnedTarget[] } | undefined> {
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, pending.id), pending.id); const length = pending.before.length + 1;
  if (pending.message === undefined || entries.length < length || entries[pending.before.length].message !== pending.message || hashHistoryStream(entries.slice(0, pending.before.length)) !== pending.before.history) return undefined;
  const { document } = await getItemAt(pending.id, String(length), { pmRoot: store.workspace });
  if (documentHash(document, await trackerSchema(store.workspace)) !== pending.proposed) return undefined;
  const target = { ...pending.target, proof: { hash: pending.proposed, length, history: hashHistoryStream(entries.slice(0, length)), version: document.metadata.updated_at } };
  return { owner: 'pm-memory-policy-ownership:1', targets: [target] };
}
/** Finish a proven forward publication before retiring its interrupted intent; never issue an inverse item write. */
export async function publishPending(store: Store, plan: ImportPlan, options?: Pick<PortableImportOptions, 'onStep' | 'onTransition'>): Promise<void> {
  const pending = plan.publication; if (pending === undefined) return;
  await options?.onStep?.('recover-publication');
  const result = await publicationResult(store, pending);
  if (result !== undefined) {
    const snapshot = async () => JSON.parse(JSON.stringify(result)) as WorkspaceTransactionJsonValue;
    await commitWorkspaceTransaction({ pmRoot: store.workspace, author: plan.author, transactionId: `${pending.transactionId}-snapshot`, steps: [{ id: pending.stepId, inspect: async () => ({ state: 'applied', result: await snapshot() }), apply: snapshot, compensate: retainForwardWrites }], onTransition: options?.onTransition });
  }
  delete plan.publication; await savePlan(store, plan); await options?.onStep?.('recover-recorded');
}
/** Read an input-keyed planned outcome without consulting inherited object properties. */
function plannedOutcome(plan: ImportPlan, id: string): 'imported' | 'updated' | 'unchanged' | undefined { return plan.outcomes !== undefined && Object.hasOwn(plan.outcomes, id) ? plan.outcomes[id] : undefined; }
/** Re-read represented dependency identities at admission and at the actual final SDK hook. */
async function dependencyConflict(store: Store, plan: ImportPlan, target: OwnedTarget): Promise<ImportConflict | undefined> {
  for (const edge of target.relationships) {
    const expected = plan.expected.find(row => row.id === edge.id);
    let actual: Awaited<ReturnType<typeof nativeState>>;
    try { actual = await nativeState(store, edge.id); }
    catch (error) { if (!(error instanceof MemoryError) || error.code !== 'conflict') throw error; return importConflict(edge.id, ['document'], { document: expected?.history }, { document: 'unverified native document' }); }
    if (actual.document === null || actual.document.metadata.type !== 'Knowledge' || typeof actual.document.metadata.memory_slug !== 'string' || foreignMemories([{ ...actual.document.metadata, type: String(actual.document.metadata.type) }]).length > 0 || expected !== undefined && (actual.proof.length !== expected.length || actual.proof.history !== expected.history)) return importConflict(edge.id, ['revision'], { revision: expected?.history }, { revision: actual.proof.history });
  }
  return undefined;
}
/** A peer already satisfied the actual SDK-normalized input; no revision-only write is authorized. */
class CompletedInput extends Error {}

/** Recheck a saved field base in the SDK's actual pre-write hook; plain writers can still race the later publication. */
async function writeForward(store: Store, plan: ImportPlan, mutation: BulkItemMutation, target: OwnedTarget, base: ItemDocument | null, options: PortableImportOptions, stepId: string): Promise<void> {
  const identity = await importIdentity(store, plan.input); let completed: NativeProof | undefined;
  await commitWorkspaceTransaction({ pmRoot: store.workspace, author: plan.author, transactionId: `${identity.transactionId}-snapshot`, steps: [{ id: stepId, inspect: async () => ({ state: 'pending' }), apply: async () => {
  const initial = await nativeState(store, mutation.id);
  if (mutation.op === 'create' && initial.document !== null || mutation.op === 'update' && initial.document === null) throw new ImportMoved(importConflict(mutation.id, ['id'], { id: base?.metadata.id }, { id: initial.document?.metadata.id }));
  assertBase(mutation.id, base, initial.document, initial.document);
  const publish = async () => {
    const schema = await trackerSchema(store.workspace); let failure: unknown; let preserveRevision = false; let normalized: Record<string, unknown> = {};
    const suffix = mutation.op === 'create' ? `-nodes ${mutation.id} create memory-birth-v1:${digest(plan.births!.find(row => row.id === mutation.id)!.document)}` : ` forward ${mutation.id}`;
    const message = `bulk-item-transaction ${identity.transactionId}${suffix}`;
    const guard: BeforeMutationHook = async context => {
      if (context.operation !== mutation.op || resolve(context.pm_root) !== resolve(store.workspace) || context.after!.metadata.id !== mutation.id) return;
      try {
        await options.onStep?.('write-guard');
        const dependency = await dependencyConflict(store, plan, target); if (dependency !== undefined) throw new ImportMoved(dependency);
        const state = await nativeState(store, mutation.id);
        if (context.before === null) {
          const peers = certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
          if (peers.some(row => row.id !== mutation.id && row.memory_slug === mutation.options!.memorySlug)) throw new ImportMoved(importConflict(mutation.id, ['memory_slug'], { memory_slug: undefined }, { memory_slug: mutation.options!.memorySlug }));
        }
        const fields = assertBase(mutation.id, base, state.document, context.after);
        const expected = plan.expected.find(row => row.id === mutation.id)!;
        const entries = await readHistoryEntries(getHistoryPath(store.workspace, mutation.id), mutation.id);
        const touched = fields.filter(field => { const path = field === 'body' ? '/body' : `/metadata/${field.replace(/~/g, '~0').replace(/\//g, '~1')}`; return entries.slice(expected.length).some(entry => entry.patch.some(patch => patch.path === path || patch.path.startsWith(`${path}/`))); });
        if (touched.length > 0 || hashHistoryStream(entries.slice(0, expected.length)) !== expected.history) throw new ImportMoved(importConflict(mutation.id, [...touched, '$history'], { ...base?.metadata, body: base?.body, $history: expected.history }, { ...state.document?.metadata, body: state.document?.body, $history: state.proof.history }));
        const birth = plan.births?.find(row => row.id === mutation.id);
        if (context.before === null && birth !== undefined && birth.document !== birthDocument(context.after!, schema)) throw new ImportMoved(importConflict(mutation.id, ['birth'], { birth: birth.document }, { birth: birthDocument(context.after!, schema) }));
        if (documentHash(context.before, schema) !== state.proof.hash) throw new ImportMoved(importConflict(mutation.id, ['revision'], { revision: documentHash(context.before, schema) }, { revision: state.proof.hash }));
        if (mutation.op === 'update' && !preserveRevision && Object.hasOwn(mutation.options!, 'memoryChangedAt') && fields.every(field => !SEMANTIC_FIELDS.has(field))) {
          const document = Object.fromEntries([...SEMANTIC_OPTIONS].filter(([option]) => Object.hasOwn(mutation.options!, option)).map(([, key]) => [key, key === 'body' ? context.after!.body : context.after!.metadata[key]]));
          normalized = itemDocumentToMutationOptions(JSON.stringify(document), 'update', {}, resolveRuntimeFieldRegistry(schema).definitions);
          throw new CompletedInput();
        }
        plan.publication = { id: mutation.id, transactionId: identity.transactionId, message, stepId, before: state.proof, proposed: documentHash(context.after, schema)!, target };
        await savePlan(store, plan);
      } catch (error) { failure = error; throw error; }
    };
    if (store.hostClient === undefined) installStandaloneGuard(guard, 'pm-memory-forward-base');
    const dispatch = async () => {
      const common: Record<string, unknown> = { ...mutation.options, ...(preserveRevision ? normalized : {}), author: plan.author, message };
      if (preserveRevision) {
        for (const field of ['memoryChangedAt', 'memoryVerdict', 'memoryVerifiedAt', 'memoryReason']) delete common[field];
        const unset = (common.unset as string[] | undefined ?? []).filter(field => !['memory_verified_at', 'memory_reason'].includes(field));
        if (unset.length > 0) common.unset = unset; else delete common.unset;
      }
      if (mutation.op === 'create') {
        if (store.hostClient === undefined) await create({ ...common, id: mutation.id }, { pmRoot: store.workspace });
        else await guardedHostCreate(store, store.hostClient, mutation.id, guard, common);
      }
      else {
        const result = store.hostClient === undefined ? await update(mutation.id, common, { pmRoot: store.workspace }) : await guardedHostUpdate(store, store.hostClient, mutation.id, guard, common);
        if (result.changed_fields.length === 0) {
          const current = await nativeState(store, mutation.id); assertBase(mutation.id, base, current.document, current.document);
          const dependency = await dependencyConflict(store, plan, target); if (dependency !== undefined) throw new ImportMoved(dependency);
          if (plannedOutcome(plan, mutation.id) === 'updated') plan.outcomes![mutation.id] = 'unchanged';
        }
      }
    };
    try { await dispatch(); } catch (error) {
      const cause = failure ?? error;
      if (!(cause instanceof CompletedInput)) throw cause;
      preserveRevision = true; failure = undefined;
      try { await dispatch(); } catch (retryError) { throw failure ?? retryError; }
    }
  };
  if (store.hostClient === undefined) await runWithActiveExtensions({ path: store.workspace, noExtensions: true }, publish); else await publish();
  if (plannedOutcome(plan, mutation.id) !== 'unchanged') (plan.applied ??= []).push(mutation.id);
  await options.onStep?.('written');
  const result = plan.publication === undefined ? undefined : await publicationResult(store, plan.publication); completed = result?.targets[0].proof;
  return JSON.parse(JSON.stringify(result ?? null)) as WorkspaceTransactionJsonValue;
  }, compensate: retainForwardWrites }], onTransition: options.onTransition });
  if (completed !== undefined) Object.assign(plan.expected.find(row => row.id === mutation.id)!, { length: completed.length, history: completed.history, version: completed.version });
  delete plan.publication; await savePlan(store, plan);
  await options.onStep?.('publication');
}
/** Close runtime skips over all represented dependencies and report every affected item. */
function skipItem(plan: ImportPlan, id: string, conflict: ImportConflict): void {
  const pending = [id];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (plan.result.skipped.some(row => row.conflict?.item === current)) continue;
    const slug = plan.expected.find(row => row.id === current)!.slug;
    plan.result.skipped.push({ slug, reason: `import_conflict: Foreign or independently edited native content retained: ${conflict.fields.join(', ')}`, conflict: { ...conflict, item: current, ...(current === id ? {} : { dependency: id }) } });
    for (const target of plan.ownership!) if (target.graph.some(edge => edge.id === current)) pending.push(target.id);
  }
}
/** Journal forward item steps with no domain compensation: interruptions retain every completed write. */
export async function commitPortableBatch(store: Store, plan: ImportPlan, _transactionId: string, phase: string, mutations: BulkItemMutation[], options: PortableImportOptions): Promise<void> {
  for (const [index, mutation] of mutations.entries()) {
    if (plan.result.skipped.some(row => row.conflict?.item === mutation.id)) continue;
    const target = plan.ownership!.find(target => target.id === mutation.id)!;
    const base = plan.expected.find(row => row.id === mutation.id)!.document ?? null;
    try {
      await options.onStep?.('item-read');
      const dependency = phase === 'nodes' ? undefined : await dependencyConflict(store, plan, target);
      if (dependency !== undefined) skipItem(plan, dependency.item, dependency);
      if (plan.result.skipped.some(row => row.conflict?.item === mutation.id)) continue;
      await writeForward(store, plan, mutation, phase === 'nodes' ? { ...target, relationships: [], graph: [] } : target, base, options, `${index + 1}-${phase}-${mutation.id}`);
    } catch (error) {
      const conflict = error instanceof ImportMoved ? error.conflict : error instanceof MemoryError && error.code === 'conflict' ? importConflict(mutation.id, ['document'], { document: plan.expected.find(row => row.id === mutation.id)!.history }, { document: 'unverified native document' }) : undefined;
      if (conflict === undefined) throw error;
      skipItem(plan, conflict.item, conflict); await savePlan(store, plan);
    }
  }
}
