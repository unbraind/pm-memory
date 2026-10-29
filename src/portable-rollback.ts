import { trackerSchema } from './lifecycle.ts';
import { isDeepStrictEqual } from 'node:util';
import { commitWorkspaceTransaction, update, getItemAt, getHistoryPath, readHistoryEntries, readSettings, resolveRuntimeStatusRegistry, resolveRuntimeFieldRegistry, resolveTransactionSchema, itemDocumentToMutationOptions, hashHistoryStream } from '@unbrained/pm-cli/sdk';
import type { ItemDocument } from '@unbrained/pm-cli/sdk';
import { documentHash, nativeProof, ownsWritten, writeWithProof } from './portable-write.ts';
import { savePlan, importIdentity } from './portable-plan.ts';
import type { ImportPlan, ExpectedTarget } from './portable-plan.ts';
import { type Store } from './store.ts';
import type { PortableImportOptions } from './portable.ts';
import { previousOwnership, relationshipPatch } from './portable-ownership.ts';
import { birthDocument, captureBirths } from './portable-preview.ts';
import { creator, creatorMatchesOrigin } from './portable-origin.ts';
import { MemoryError } from './core.ts';

/** Field-local compensation result, retained in the SDK journal and import diagnostics. */
export interface RollbackReceipt {
  /** Native identity is retained even when an import creation is canceled. */
  id: string;
  /** Compensation outcome, never a deletion. */
  outcome: 'unchanged' | 'canceled' | 'restored' | 'superseded';
  /** Fields restored only while they still equaled the exact SDK write. */
  restored_fields: string[];
  /** Peer-owned or unprovable fields left untouched. */
  preserved_fields: string[];
}

/** Creation ownership requires the independently SDK-created full birth document to match the SDK birth. */
export async function ownsCreation(store: Store, plan: ImportPlan, id: string): Promise<boolean> {
  try {
    const mutation = plan.nodes?.find(row => row.id === id) ?? plan.mutations.find(row => row.id === id && row.op === 'create');
    if (mutation === undefined) return false;
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
    if (entries[0]?.op !== 'create' || entries[0].author !== plan.author) return false;
    if (typeof mutation.options!.message === 'string' && entries[0].message !== mutation.options!.message) return false;
    const birth = creator(id, entries[0], undefined);
    if (birth === undefined || birth.metadata.type !== mutation.options!.type || birth.metadata.memory_slug !== mutation.options!.memorySlug || birth.metadata.memory_source !== mutation.options!.memorySource || birth.metadata.memory_original !== mutation.options!.memoryOriginal) return false;
    const origin = plan.expected.find(row => row.id === id)?.origin;
    if (origin !== undefined && !creatorMatchesOrigin(birth, origin)) return false;
    const { document } = await getItemAt(id, '1', { pmRoot: store.workspace });
    await captureBirths(store, plan);
    const expectedBirth = birthDocument(document, await trackerSchema(store.workspace));
    if (!plan.births!.some(row => row.id === id && row.document === expectedBirth && row.message === entries[0].message)) return false;
    const [memory] = await store.read(new Set([id]), [{ ...document.metadata, body: document.body }]);
    return await previousOwnership(store, memory, new Map()) !== undefined;
  } catch { return false; }
}

/** Exact SDK document/history receipts, never message prefixes, prove the current write. */
export async function ownsLatest(store: Store, plan: ImportPlan, id: string): Promise<boolean> { return ownsWritten(store, plan, id); }
/** Read the last exact historical write by this import, independent of later peer appends. */
async function writtenDocument(store: Store, plan: ImportPlan, id: string): Promise<ItemDocument | undefined> {
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
  for (const receipt of [...(plan.writes ?? [])].reverse()) {
    if (receipt.id !== id || receipt.key.startsWith('rollback:')) continue;
    const length = receipt.after?.length ?? receipt.before.length + 1;
    if (length <= receipt.before.length || length > entries.length || hashHistoryStream(entries.slice(0, receipt.before.length)) !== receipt.before.history) continue;
    const { document } = await getItemAt(id, String(length), { pmRoot: store.workspace });
    if (documentHash(document, await trackerSchema(store.workspace)) === (receipt.after?.hash ?? receipt.proposed) && (receipt.after === undefined || hashHistoryStream(entries.slice(0, length)) === receipt.after.history)) return document;
  }
  return undefined;
}
/** Compare complete SDK-read field values; no parallel input normalization or field allowlist. */
function restoration(current: ItemDocument, written: ItemDocument, original: ItemDocument): { fields: Record<string, unknown>; restored: string[]; preserved: string[] } {
  const fields = Object.create(null) as Record<string, unknown>; const restored: string[] = []; const preserved: string[] = [];
  const before = new Map<string, unknown>(Object.entries({ ...original.metadata, body: original.body }));
  const after = new Map<string, unknown>(Object.entries({ ...written.metadata, body: written.body }));
  const now = new Map<string, unknown>(Object.entries({ ...current.metadata, body: current.body }));
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (['id', 'created_at', 'updated_at'].includes(key) || isDeepStrictEqual(before.get(key), after.get(key))) continue;
    if (isDeepStrictEqual(now.get(key), before.get(key))) continue;
    if (!isDeepStrictEqual(now.get(key), after.get(key))) { preserved.push(key); continue; }
    fields[key] = before.get(key); restored.push(key);
  }
  return { fields, restored, preserved };
}
/** Reject SDK side effects on unowned fields using its actual normalized mutation proposal. */
function checkRollback(before: ItemDocument, after: ItemDocument, desired: Record<string, unknown>, refused: string[]): void {
  const from = new Map<string, unknown>(Object.entries({ ...before.metadata, body: before.body })); const to = new Map<string, unknown>(Object.entries({ ...after.metadata, body: after.body }));
  for (const key of new Set([...from.keys(), ...to.keys()])) {
    if (Object.hasOwn(desired, key) || key === 'updated_at' || ['completed_at', 'closed_at'].includes(key) && from.get(key) === undefined) continue;
    if (!isDeepStrictEqual(from.get(key), to.get(key))) refused.push(key);
  }
  if (refused.length > 0) throw new MemoryError('rollback_fields', 'SDK compensation would change unowned field values', 'Retain the native values named in the rollback receipt');
}
/** Retain a compact field-level peer receipt without copying guidance into agent output. */
function report(plan: ImportPlan, target: ExpectedTarget, receipt: RollbackReceipt): RollbackReceipt {
  if (receipt.preserved_fields.length > 0) {
    const reason = `superseded: rollback retained native fields: ${receipt.preserved_fields.join(', ')}`;
    if (!plan.result.skipped.some(row => row.slug === target.slug && row.reason === reason)) plan.result.skipped.push({ slug: target.slug, reason });
  }
  return receipt;
}
/** Cancel births and restore only still-owned field values, with a final best-effort reread. */
export async function rollbackTarget(store: Store, plan: ImportPlan, target: ExpectedTarget, options: PortableImportOptions): Promise<RollbackReceipt> {
  const result: RollbackReceipt = { id: target.id, outcome: 'unchanged', restored_fields: [], preserved_fields: [] };
  await options.onStep?.('rollback-apply');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = await nativeProof(store, target.id).catch(() => undefined);
      if (before === undefined) return report(plan, target, { ...result, outcome: 'superseded', preserved_fields: ['document: unverified history'] });
      if (before.hash === null || before.length === target.length && before.history === target.history) return result;
      const { document: current } = await getItemAt(target.id, String(before.length), { pmRoot: store.workspace });
      const written = await writtenDocument(store, plan, target.id).catch(() => undefined);
      if (written === undefined) return report(plan, target, { ...result, outcome: 'superseded', preserved_fields: ['document'] });
      if (current.metadata.memory_source !== written.metadata.memory_source || current.metadata.type !== written.metadata.type) return report(plan, target, { ...result, outcome: 'superseded', preserved_fields: ['memory_source', 'type'] });
      await options.onStep?.('rollback-read');
      let patch: Record<string, unknown>; let desired: Record<string, unknown>;
      if (target.version === null) {
        if (!await ownsCreation(store, plan, target.id)) return report(plan, target, { ...result, outcome: 'superseded', preserved_fields: ['creation'] });
        const { schema } = await resolveTransactionSchema(store.workspace, await readSettings(store.workspace)); const canceled = resolveRuntimeStatusRegistry(schema).canceled_status;
        if (current.metadata.status === canceled) return { ...result, outcome: 'canceled' };
        if (current.metadata.status !== written.metadata.status || !isDeepStrictEqual(current.metadata.close_reason, written.metadata.close_reason)) return report(plan, target, { ...result, outcome: 'superseded', preserved_fields: ['status', 'close_reason'] });
        const reason = `Canceled incomplete memory import ${plan.invocationId ?? plan.transactionId}`;
        patch = { status: canceled, closeReason: reason }; desired = { status: canceled, close_reason: reason };
        Object.assign(result, { outcome: 'canceled', restored_fields: ['status'] });
      } else {
        const { document: original } = await getItemAt(target.id, Number.isSafeInteger(target.length) && target.length > 0 ? String(target.length) : target.version, { pmRoot: store.workspace });
        const selection = restoration(current, written, original);
        Object.assign(result, { restored_fields: selection.restored, preserved_fields: selection.preserved });
        if (selection.restored.length === 0) return report(plan, target, { ...result, outcome: selection.preserved.length > 0 ? 'superseded' : 'unchanged' });
        const { schema } = await resolveTransactionSchema(store.workspace, await readSettings(store.workspace));
        const fields = Object.fromEntries(Object.entries(selection.fields).filter(([key, value]) => key !== 'dependencies' && value !== undefined));
        const unset = Object.keys(selection.fields).filter(key => selection.fields[key] === undefined);
        patch = { ...itemDocumentToMutationOptions(JSON.stringify(fields), 'update', {}, resolveRuntimeFieldRegistry(schema).definitions), ...(unset.length === 0 ? {} : { unset }) };
        if (selection.restored.includes('dependencies')) Object.assign(patch, relationshipPatch(current.metadata.dependencies ?? [], original.metadata.dependencies ?? []));
        desired = selection.fields; Object.assign(result, { outcome: 'restored' });
      }
      await options.onStep?.('rollback-ready');
      const receipt = { id: target.id, key: `rollback:${target.id}:${before.history}`, before, proposed: null };
      const refused: string[] = [];
      try {
        await writeWithProof(store, plan, receipt, () => savePlan(store, plan), () => update(target.id, { ...patch, author: plan.author, message: `bulk-item-transaction ${plan.rollbackId ?? plan.transactionId}-rollback ${target.id} compensate` }, { pmRoot: store.workspace }), options.onStep, (before, after) => checkRollback(before!, after!, desired, refused));
      } catch (error) {
        if (refused.length > 0) return report(plan, target, { ...result, outcome: 'superseded', restored_fields: [], preserved_fields: [...new Set([...result.preserved_fields, ...refused])] });
        throw error;
      }
      return report(plan, target, result);
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'conflict') continue;
      throw error;
    }
  }
  return report(plan, target, { ...result, outcome: 'superseded', restored_fields: [], preserved_fields: [...new Set([...result.preserved_fields, 'document: moved during rollback'])] });
}
/** Journal rollback progress; workspace coordination does not exclude plain SDK/CLI writers. */
export async function rollbackImport(store: Store, plan: ImportPlan, options: PortableImportOptions): Promise<void> {
  const transactionId = `${plan.rollbackId ?? (await importIdentity(store, plan.input)).transactionId}-rollback`;
  await commitWorkspaceTransaction({ pmRoot: store.workspace, author: plan.author, transactionId, lockTtlSeconds: 3600, steps: [...(plan.initial ?? plan.expected)].reverse().map(target => ({
    id: `restore-${target.id}`,
    /** An unchanged initial history needs no compensation. */
    inspect: async () => {
      const current = await nativeProof(store, target.id).catch(() => undefined);
      if (current !== undefined && current.length === target.length && current.history === target.history) return { state: 'applied' as const, result: { owner: 'pm-memory-policy-rollback:1', id: target.id, outcome: 'unchanged', writes: [] } };
      return { state: 'pending' as const };
    },
    /** Native updates preserve identity and selectively retain all observed peer changes. */
    apply: async () => ({ owner: 'pm-memory-policy-rollback:1', ...await rollbackTarget(store, plan, target, options), writes: JSON.parse(JSON.stringify(plan.writes?.filter(row => row.id === target.id) ?? [])) }),
    /** A rollback never reapplies old state when its own journal fails. */
    compensate: async () => {},
  })), onTransition: options.onTransition });
}
