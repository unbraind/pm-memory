import { resolve } from 'node:path';
import { commitWorkspaceTransaction, runWithActiveExtensions, setActiveExtensionHooks, restore, deleteItem, getItemAt, getHistoryPath, readHistoryEntries, PmClient, certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import { nativeProof, ownsWritten, writeWithProof } from './portable-write.ts';
import { savePlan, importIdentity } from './portable-plan.ts';
import type { BeforeMutationHook } from '@unbrained/pm-cli/sdk/authoring';
import type { ImportPlan, ExpectedTarget } from './portable-plan.ts';
import { type Store } from './store.ts';
import type { PortableImportOptions } from './portable.ts';
import { previousOwnership } from './portable-ownership.ts';
import { birthDocument, captureBirths } from './portable-preview.ts';
import { creator, creatorMatchesOrigin } from './portable-origin.ts';

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
    if (!plan.births!.some(row => row.id === id && row.document === birthDocument(document) && row.message === entries[0].message)) return false;
    const [memory] = await store.read(new Set([id]), [{ ...document.metadata, body: document.body }]);
    return await previousOwnership(store, memory, new Map()) !== undefined;
  } catch { return false; }
}

/** Exact SDK document/history receipts, never message prefixes, prove the current write. */
export async function ownsLatest(store: Store, plan: ImportPlan, id: string): Promise<boolean> { return ownsWritten(store, plan, id); }
/** Keep the transitive support graph of every current peer-owned record. */
async function protectedByPeer(store: Store, plan: ImportPlan, id: string): Promise<boolean> {
  const client = new PmClient({ pmRoot: store.workspace, noExtensions: true });
  const items = certifyCompleteListResult(await client.listAllComplete()).items;
  const protectedIds = new Set<string>();
  for (const item of items) if (!await ownsLatest(store, plan, item.id)) protectedIds.add(item.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) if (protectedIds.has(item.id)) for (const edge of item.dependencies ?? []) if (!protectedIds.has(edge.id)) { protectedIds.add(edge.id); changed = true; }
  }
  return protectedIds.has(id);
}
/** Guard SDK compensation inside its item lock so a native peer is never restored over. */
export async function guardedCompensation<T>(store: Store, plan: ImportPlan, run: () => Promise<T>): Promise<T> {
  return runWithActiveExtensions({ path: store.workspace, noExtensions: true }, async () => {
    const guard: BeforeMutationHook = async context => {
      if (resolve(context.pm_root) !== resolve(store.workspace)) return;
      if (context.operation === 'create') {
        const expected = plan.births?.find(row => row.id === context.after!.metadata.id);
        if (expected !== undefined && expected.document !== birthDocument(context.after!)) return { allow: false, code: 'memory_import_birth_moved', message: 'SDK creation context changed after planning', remediation: 'Retry the portable import using the current schema and defaults; no unexpected creation was written' };
      }
      if (context.before === null || !['restore', 'delete'].includes(context.operation) || !plan.expected.some(row => row.id === context.before!.metadata.id)) return;
      if (!await ownsLatest(store, plan, context.before.metadata.id)) return { allow: false, code: 'memory_import_peer_revision', message: 'Compensation superseded by a native revision', remediation: 'Retain the native revision and retry the portable import' };
      if (context.operation === 'delete' && await protectedByPeer(store, plan, context.before.metadata.id)) return { allow: false, code: 'memory_import_peer_reference', message: 'A peer references this target', remediation: 'Retain the peer reference graph and retry the portable import' };
    };
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onRead: [], onIndex: [], beforeMutation: [{ layer: 'project', name: 'pm-memory-compensation', run: guard }] });
    return run();
  });
}
/** Restore one exact owned write inside the already held SDK workspace critical section. */
export async function rollbackTarget(store: Store, plan: ImportPlan, target: ExpectedTarget, options: PortableImportOptions): Promise<string> {
  const before = await nativeProof(store, target.id).catch(() => undefined);
  if (before !== undefined && (before.hash === null || (before.length === target.length && before.history === target.history))) return 'unchanged';
  if (before === undefined || !await ownsLatest(store, plan, target.id) || (target.version === null && await protectedByPeer(store, plan, target.id))) {
    const skipped = { slug: target.slug, reason: 'superseded: native peer owns the current document or its reference graph' };
    if (!plan.result.skipped.some(row => row.slug === skipped.slug && row.reason === skipped.reason)) plan.result.skipped.push(skipped);
    return 'superseded';
  }
  await options.onStep?.('rollback-apply');
  const receipt = { id: target.id, key: `rollback:${target.id}:${before.history}`, before, proposed: null };
  const mutationOptions = { author: plan.author, force: true, message: `bulk-item-transaction ${plan.rollbackId ?? plan.transactionId}-rollback ${target.id} compensate` };
  await writeWithProof(store, plan, receipt, () => savePlan(store, plan), async () => {
    if (target.version === null) await deleteItem(target.id, mutationOptions, { pmRoot: store.workspace });
    else await restore(target.id, Number.isSafeInteger(target.length) && target.length > 0 ? String(target.length) : target.version, mutationOptions, { pmRoot: store.workspace });
  }, options.onStep);
  return 'restored';
}
/** SDK inspection and application share its cross-process lock; each drain has a unique identity. */
export async function rollbackImport(store: Store, plan: ImportPlan, options: PortableImportOptions): Promise<void> {
  const transactionId = `${plan.rollbackId ?? (await importIdentity(store, plan.input)).transactionId}-rollback`;
  await commitWorkspaceTransaction({ pmRoot: store.workspace, author: plan.author, transactionId, lockTtlSeconds: 3600, steps: [...(plan.initial ?? plan.expected)].reverse().map(target => ({
    id: `restore-${target.id}`,
    /** Re-read the actual target before deciding whether this drain has work. */
    inspect: async () => {
      const current = await nativeProof(store, target.id).catch(() => undefined);
      if (current !== undefined && current.length === target.length && current.history === target.history) return { state: 'applied' as const, result: { owner: 'pm-memory-policy-rollback:1', id: target.id, outcome: 'unchanged', writes: [] } };
      return { state: 'pending' as const };
    },
    /** A second item-lock CAS protects native writers which do not take the workspace lock. */
    apply: async () => ({ owner: 'pm-memory-policy-rollback:1', id: target.id, outcome: await rollbackTarget(store, plan, target, options), writes: JSON.parse(JSON.stringify(plan.writes?.filter(row => row.id === target.id) ?? [])) }),
    /** A rollback never reintroduces state when its own drain fails or is interrupted. */
    compensate: async () => {},
  })), onTransition: options.onTransition });
}
