import { randomUUID } from 'node:crypto';
import { canonicalDocument, itemDocumentToMutationOptions, getHistoryPath, getItemAt, hashHistoryStream, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import type { ItemDocument } from '@unbrained/pm-cli/sdk';
import { contentRevision } from './content.ts';
import { MemoryError } from './core.ts';
import { isCanceled, statusRegistry } from './lifecycle.ts';
import { commitNativeFields, documentHash, nativeState, sameNativeProof, trackerSchema, validNativeProof } from './native-revision.ts';
import type { NativeProof } from './native-revision.ts';
import type { Store } from './store.ts';
import type { Memory } from './types.ts';

/** A forward merge is authorized by immutable source and target history prefixes. */
interface MergeReceipt { version: 2; id: string; target: string; target_id: string; body: string; changed_at: string; source_before: NativeProof; target_before: NativeProof; target_after: string }
/** Recovery always identifies the audited field requiring operator reconciliation. */
function refusal(source: Memory): MemoryError {
  let target = 'unavailable target';
  try { const row = JSON.parse(source.merge) as { target?: unknown }; if (typeof row?.target === 'string') target = row.target; } catch { /* Keep malformed legacy receipts readable while refusing replay. */ }
  return new MemoryError('conflict', `Pending memory merge ${source.slug} -> ${target} revisions changed`, `Inspect memory_merge on ${source.slug}; preserve intervening edits, then reconcile or clear it through an audited pm update before retrying`); }
/** Parse only enough identity to detect overlapping pending actions before interpreting their proofs. */
export function pendingMerge(source: Memory): { target: string; receipt: unknown } {
  try { const row = JSON.parse(source.merge) as { target?: unknown }; if (typeof row?.target === 'string') return { target: row.target, receipt: row }; } catch { /* Invalid persisted data remains readable, but cannot authorize mutation. */ }
  throw refusal(source);
}
/** Normalize the complete expected payload; SDK modification clocks never establish recovery identity. */
async function payloadHash(store: Store, document: ItemDocument): Promise<string> {
  return documentHash({ ...document, metadata: { ...document.metadata, updated_at: '2026-01-01T00:00:00.000Z' } }, await trackerSchema(store.workspace))!;
}
/** Read a verified native generation only at the saved prefix or its exact single named append. */
async function generation(store: Store, id: string, before: NativeProof, messages: string[]): Promise<Awaited<ReturnType<typeof nativeState>>> {
  const state = await nativeState(store, id); const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
  if (state.document === null || hashHistoryStream(entries.slice(0, before.length)) !== before.history || entries.length !== before.length + messages.length || messages.some((message, offset) => entries[before.length + offset].message !== message)) throw new MemoryError('conflict', 'Pending memory merge history moved', 'Preserve the native generation and reconcile the recorded memory_merge through an audited pm update');
  if (messages.length === 0 && !sameNativeProof(state.proof, before)) throw new MemoryError('conflict', 'Pending memory merge document moved', 'Preserve the native generation and reconcile memory_merge through an audited pm update');
  return state;
}
/** Reuse one deterministic patch for SDK publication and its canonical expected payload. */
function revisionFields(receipt: Pick<MergeReceipt, 'body' | 'changed_at'>): Record<string, unknown> {
  const fields = { body: receipt.body, memoryEdited: true }; contentRevision(fields, receipt.changed_at); return fields;
}
/** Validate a pending receipt against exact immutable history, allowing only this run's forward steps. */
async function recover(store: Store, source: Memory, target: Memory, receipt: MergeReceipt) {
  const intent = `Memory merge ${receipt.id} intent`; const cancel = `Memory merge ${receipt.id} cancel`;
  const canceled = isCanceled(source);
  const saved = await generation(store, source.id, receipt.source_before, canceled ? [intent, cancel] : [intent]);
  const original = (await getItemAt(source.id, String(receipt.source_before.length), { pmRoot: store.workspace })).document;
  const pending = (await getItemAt(source.id, String(receipt.source_before.length + 1), { pmRoot: store.workspace })).document;
  if (await payloadHash(store, pending) !== await payloadHash(store, { ...original, metadata: { ...original.metadata, memory_merge: source.merge } })) throw refusal(source);
  // A cancellation may alter lifecycle only; every semantic and foreign field remains bound to the intent.
  if (canceled) {
    const lifecycle = new Set(['status', 'closed_at', 'close_reason', 'updated_at']);
    const stable = (document: ItemDocument) => ({ ...document, metadata: Object.fromEntries(Object.entries(document.metadata).filter(([key]) => !lifecycle.has(key))) } as ItemDocument);
    if (await payloadHash(store, stable(saved.document!)) !== await payloadHash(store, stable(pending))) throw refusal(source);
  }
  const current = await nativeState(store, target.id);
  const published = current.proof.length === receipt.target_before.length + 1;
  const destination = await generation(store, target.id, receipt.target_before, published ? [`Memory merge ${receipt.id} publish`] : []);
  if (published && await payloadHash(store, destination.document!) !== receipt.target_after || canceled && !published) throw refusal(source);
  return { source: saved, target: destination, published, canceled };
}
/** Publish every merge step through the same complete revision and host-policy guard, rechecking every additionally certified item. */
async function writeStep(store: Store, source: Memory, id: string, before: NativeProof, fields: Record<string, unknown>, message: string, certify?: ReadonlyMap<string, NativeProof>): Promise<void> {
  if (!await commitNativeFields(store, id, before, fields, message, certify)) throw refusal(source);
}
/** Capture and publish a merge, or resume only its exact forward history steps. Legacy intents refuse safely. */
export async function performMerge(store: Store, source: Memory, memories: readonly Memory[], observed: ReadonlyMap<string, Awaited<ReturnType<typeof nativeState>>>, apply: boolean, selectedTarget?: string): Promise<void> {
  let receipt: MergeReceipt; let target: Memory | undefined;
  if (source.merge !== '') {
    const pending = pendingMerge(source);
    target = memories.find(item => item.slug === pending.target && !isCanceled(item));
    receipt = pending.receipt as MergeReceipt;
    if (target === undefined || receipt.version !== 2 || typeof receipt.id !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.id) || receipt.target_id !== target.id || typeof receipt.body !== 'string' || typeof receipt.changed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.changed_at) || !validNativeProof(receipt.source_before) || receipt.source_before.length < 1 || !validNativeProof(receipt.target_before) || typeof receipt.target_after !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.target_after)) throw refusal(source);
  } else {
    if (!apply) return;
    target = memories.find(item => item.slug === selectedTarget && !isCanceled(item));
    if (target === undefined) throw refusal(source);
    const id = randomUUID(); const targetBase = observed.get(target.id); const sourceBase = observed.get(source.id);
    if (!targetBase?.document || sourceBase === undefined) throw refusal(source);
    const graph = [...target.relationships];
    if (!graph.some(edge => edge.id === source.id && edge.kind === 'related')) graph.push({ id: source.id, kind: 'related' });
    const preparation = { ...itemDocumentToMutationOptions(JSON.stringify({ dependencies: graph }), 'update'), comment: [`Memory merge: ${source.slug}. Original content retained in its Knowledge item and append-only history. Receipt ${id}.`] };
    await writeStep(store, source, target.id, targetBase.proof, preparation, `Memory merge ${id} prepare`);
    const prepared = await generation(store, target.id, targetBase.proof, [`Memory merge ${id} prepare`]);
    const body = `${prepared.document!.body}\n\n### Consolidated context (${source.slug})\n${source.body}\n\n**Why:** ${source.why}\n**How to apply:** ${source.how}`;
    const changed_at = new Date().toISOString();
    const fields = revisionFields({ body, changed_at });
    const after = canonicalDocument({ ...prepared.document!, body, metadata: { ...prepared.document!.metadata, memory_edited: fields.memoryEdited, memory_changed_at: fields.memoryChangedAt, memory_verdict: fields.memoryVerdict } }, { schema: await trackerSchema(store.workspace) });
    for (const field of fields.unset as string[]) delete after.metadata[field];
    receipt = { version: 2, id, target: target.slug, target_id: target.id, body, changed_at, source_before: sourceBase.proof, target_before: prepared.proof, target_after: await payloadHash(store, after) };
    const encoded = JSON.stringify(receipt);
    await writeStep(store, source, source.id, sourceBase.proof, { memoryMerge: encoded }, `Memory merge ${id} intent`, new Map([[target.id, prepared.proof]]));
    source = { ...source, merge: encoded };
  }
  let progress;
  try { progress = await recover(store, source, target, receipt); } catch { throw refusal(source); }
  if (!apply) return;
  if (!progress.published) {
    await writeStep(store, source, target.id, progress.target.proof, revisionFields(receipt), `Memory merge ${receipt.id} publish`, new Map([[source.id, progress.source.proof]]));
    progress = await recover(store, source, target, receipt);
  }
  if (!progress.canceled) {
    await writeStep(store, source, source.id, progress.source.proof, { status: (await statusRegistry(store.workspace)).canceled_status, closeReason: `Merged context linked to ${target.slug}; content retained` }, `Memory merge ${receipt.id} cancel`, new Map([[target.id, progress.target.proof]]));
    const current = (await store.read()).find(item => item.id === source.id)!;
    progress = await recover(store, current, target, receipt);
  }
  // Finalization certifies the published target position again inside the same admission hook that clears the receipt.
  await writeStep(store, source, source.id, progress.source.proof, { memoryMerge: '' }, `Memory merge ${receipt.id} finish`, new Map([[target.id, progress.target.proof]]));
}
