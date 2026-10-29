import type { TrackerSchema } from './lifecycle.ts';
import { trackerSchema } from './lifecycle.ts';
import { resolve } from 'node:path';
import { canonicalDocument, serializeItemDocument, readSettings, resolveItemTypeRegistry, locateItem, getItemPath, readLocatedItem, getHistoryPath, readHistoryEntries, hashHistoryStream, verifyHistoryEntries, runWithActiveExtensions, setActiveExtensionHooks, create, update, commitWorkspaceTransaction } from '@unbrained/pm-cli/sdk';
import type { ItemDocument, BulkItemMutation } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook, OnWriteHook } from '@unbrained/pm-cli/sdk/authoring';
import type { ImportPlan } from './portable-plan.ts';
import type { Store } from './store.ts';
import type { PortableImportOptions } from './portable.ts';
import { rollbackTarget } from './portable-rollback.ts';
import { birthDocument } from './portable-preview.ts';
import { digest, MemoryError } from './core.ts';

/** Complete SDK document and immutable history position; no attribution is an ownership token. */
export interface NativeProof { hash: string | null; history: string; length: number; version: string | null }
/** Exact proposal retained before native publication and confirmed by the SDK write hook. */
export interface WriteReceipt { id: string; key: string; before: NativeProof; proposed: string | null; after?: NativeProof }
/** Hash both native reads and SDK hook documents through the identical SDK canonical serializer. */
export function documentHash(document: ItemDocument | null, schema?: TrackerSchema): string | null { return document === null ? null : digest(serializeItemDocument(canonicalDocument(document, { schema }), { schema })); }
/** Read the actual SDK document, rejecting a history/file disagreement rather than adopting it. */
export async function nativeProof(store: Store, id: string): Promise<NativeProof> {
  const settings = await readSettings(store.workspace); const schema = await trackerSchema(store.workspace);
  const located = await locateItem(store.workspace, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
  const document = located === null ? null : (await readLocatedItem(located, { schema })).document;
  if (!verifyHistoryEntries(entries, document ?? undefined).ok) throw new MemoryError('conflict', 'Native document and history disagree', 'Retain the native record and restore a verified history before retrying');
  return { hash: documentHash(document, schema), history: hashHistoryStream(entries), length: entries.length, version: document?.metadata.updated_at ?? null };
}
/** Equality includes the monotonically growing SDK history position, detecting content ABA. */
export function sameProof(a: NativeProof, b: NativeProof): boolean { return a.hash === b.hash && a.history === b.history && a.length === b.length; }
/** Reject malformed native fingerprints before interpreting recovery or publication data. */
export function validNativeProof(value: unknown): value is NativeProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as NativeProof;
  return (row.hash === null || typeof row.hash === 'string' && /^[a-f0-9]{64}$/.test(row.hash)) && typeof row.history === 'string' && /^[a-f0-9]{64}$/.test(row.history) && Number.isSafeInteger(row.length) && row.length >= 0 && (row.version === null || typeof row.version === 'string');
}
/** Validate an owned recovery receipt before it can authorize any write. */
export function validWriteReceipt(value: unknown): value is WriteReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.key === 'string' && validNativeProof(row.before) && (row.proposed === null || typeof row.proposed === 'string' && /^[a-f0-9]{64}$/.test(row.proposed)) && (row.after === undefined || validNativeProof(row.after));
}
/** A successful receipt, or its exact single SDK append after a crash, proves the current write. */
export async function receiptMatches(store: Store, receipt: WriteReceipt): Promise<boolean> {
  try {
    const current = await nativeProof(store, receipt.id);
    if (receipt.after !== undefined) return sameProof(current, receipt.after);
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, receipt.id), receipt.id);
    return current.hash === receipt.proposed && current.length === receipt.before.length + 1 && hashHistoryStream(entries.slice(0, receipt.before.length)) === receipt.before.history;
  } catch { return false; }
}
/** Only this transaction's exact current write may be compensated; native peer appends always win. */
export async function ownsWritten(store: Store, plan: ImportPlan, id: string): Promise<boolean> {
  const initial = (plan.initial ?? plan.expected).find(target => target.id === id);
  if (initial === undefined) return false;
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id).catch(() => []);
  if (hashHistoryStream(entries.slice(0, initial.length)) !== initial.history) return false;
  for (const receipt of [...(plan.writes ?? [])].reverse()) if (receipt.id === id && (receipt.after?.length ?? receipt.before.length + 1) > receipt.before.length && await receiptMatches(store, receipt)) return true;
  return false;
}
/** Capture native publication and reread its hash/history immediately before the SDK write; a race window remains. */
export async function writeWithProof<T>(store: Store, plan: ImportPlan, receipt: WriteReceipt, persist: () => Promise<void>, run: () => Promise<T>, onStep?: PortableImportOptions['onStep'], checkProposal?: (before: ItemDocument | null, after: ItemDocument | null) => void): Promise<T> {
  return runWithActiveExtensions({ path: store.workspace, noExtensions: true }, async () => {
    const schema = await trackerSchema(store.workspace);
    let failure: unknown;
    let observed = false;
    const guard: BeforeMutationHook = async context => {
      if (resolve(context.pm_root) !== resolve(store.workspace) || (context.after?.metadata.id ?? context.before?.metadata.id) !== receipt.id) return;
      try {
        await onStep?.('write-guard');
        if (documentHash(context.before, schema) !== receipt.before.hash || !sameProof(await nativeProof(store, receipt.id), receipt.before)) throw new MemoryError('conflict', 'Native target moved since its captured SDK read', 'Retry the import; the peer revision was retained');
        checkProposal?.(context.before, context.after);
        const birth = plan.births?.find(row => row.id === receipt.id);
        if (context.before === null && birth !== undefined && birth.document !== birthDocument(context.after!, schema)) throw new MemoryError('conflict', 'SDK creation defaults changed', 'Retry with the current native schema; no unexpected creation was written');
        receipt.proposed = documentHash(context.after, schema); (plan.writes ??= []).push(receipt); observed = true;
        await persist();
      } catch (error) { failure = error; throw error; }
    };
    const written: OnWriteHook = async context => {
      if (context.item_id !== receipt.id || context.op.includes(':history')) return;
      const settings = await readSettings(store.workspace); const type = context.item_type ?? context.after?.metadata.type ?? context.before?.metadata.type;
      if (type === undefined || ![settings.item_format, 'toon' as const].some(format => resolve(getItemPath(store.workspace, type, receipt.id, format, resolveItemTypeRegistry(settings).type_to_folder)) === resolve(context.path))) return;
      try {
        const after = await nativeProof(store, receipt.id); Object.assign(receipt, { after });
        if (context.op !== 'delete' && after.hash !== documentHash(context.after!, schema)) throw new Error('Native write proof disagrees with SDK publication');
        await persist();
      } catch (error) { failure = error; throw error; }
    };
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onIndex: [], beforeMutation: [{ layer: 'project', name: 'pm-memory-exact-write', run: guard }], onWrite: [{ layer: 'project', name: 'pm-memory-exact-receipt', run: written }] });
    let result: T;
    try { result = await run(); } catch (error) { throw failure === undefined ? error : failure; }
    if (failure !== undefined) throw failure;
    if (!observed) { receipt.proposed = receipt.before.hash; receipt.after = receipt.before; (plan.writes ??= []).push(receipt); await persist(); }
    return result;
  });
}
/** Journal exact SDK steps; workspace coordination serializes transactions only, not ordinary native writers. */
export async function commitPortableBatch(store: Store, plan: ImportPlan, transactionId: string, phase: string, mutations: BulkItemMutation[], persist: () => Promise<void>, guard: () => Promise<void>, options: PortableImportOptions): Promise<void> {
  const checked = { done: false };
  await commitWorkspaceTransaction({ pmRoot: store.workspace, author: plan.author, transactionId, lockTtlSeconds: 3600, steps: mutations.map((mutation, index) => {
    const key = `${phase}:${index}:${digest(JSON.stringify([mutation.op, mutation.id, mutation.options]))}`;
    let before: NativeProof;
    return {
      id: `${index + 1}-${mutation.op}-${mutation.id.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      /** Decide from current native state, never a message marker; this does not exclude plain SDK writers. */
      inspect: async () => {
        if (!checked.done) { await guard(); Object.assign(checked, { done: true }); }
        const receipt = plan.writes?.findLast(row => row.key === key);
        if (receipt !== undefined && await receiptMatches(store, receipt)) return { state: 'applied' as const, result: { id: mutation.id, op: mutation.op } };
        before = await nativeProof(store, mutation.id);
        return { state: 'pending' as const };
      },
      /** Native hooks recheck the same read-set immediately before mutation; no atomic precondition is claimed. */
      apply: async () => {
        before = await nativeProof(store, mutation.id); await guard();
        const receipt: WriteReceipt = { id: mutation.id, key, before, proposed: null };
        await writeWithProof(store, plan, receipt, persist, () => mutation.op === 'create'
          ? create({ ...mutation.options, author: plan.author, id: mutation.id }, { pmRoot: store.workspace })
          : update(mutation.id, { ...mutation.options, author: plan.author, message: `bulk-item-transaction ${transactionId} ${key.slice(0, 24)} apply` }, { pmRoot: store.workspace }), options.onStep);
        return { id: mutation.id, op: mutation.op };
      },
      /** Compensation cancels creations and restores only field values still equal to this run's write. */
      compensate: async () => { const target = (plan.initial ?? plan.expected).find(row => row.id === mutation.id)!; await rollbackTarget(store, plan, target, options); },
    };
  }), onTransition: async event => { await options.onTransition?.(event); if (event.transition === 'committing' || event.transition === 'committed') await guard(); } });
}
