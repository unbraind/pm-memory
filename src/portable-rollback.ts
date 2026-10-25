import { commitWorkspaceTransaction, runWithActiveExtensions, setActiveExtensionHooks, restore, deleteItem, getHistoryPath, readHistoryEntries, replayHistoryToTarget, PmClient, certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook } from '@unbrained/pm-cli/sdk/authoring';
import type { ImportPlan, ExpectedTarget } from './portable-plan.ts';
import type { Store } from './store.ts';
import type { PortableImportOptions } from './portable.ts';

/** Immutable SDK history, rather than mutable content, identifies an owned write. */
export async function ownsLatest(store: Store, plan: ImportPlan, id: string): Promise<boolean> {
  if (!plan.expected.some(target => target.id === id)) return false;
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
  const last = entries.at(-1);
  if (last?.author !== plan.author) return false;
  if ([plan.transactionId, ...(plan.ownedTransactions ?? [])].some(id => last.message?.startsWith(`bulk-item-transaction ${id} `) || last.message?.startsWith(`bulk-item-transaction ${id}-`))) return true;
  const mutation = plan.nodes?.find(row => row.id === id) ?? plan.mutations.find(row => row.id === id && row.op === 'create');
  if (last.op !== 'create' || mutation === undefined || entries.length !== 1) return false;
  const created = replayHistoryToTarget(entries, 0).metadata;
  return created.memory_source === 'portable:policy-v1' && created.memory_original === mutation.options!.memoryOriginal;
}
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
      if (context.before === null || !['restore', 'delete'].includes(context.operation) || !plan.expected.some(row => row.id === context.before!.metadata.id)) return;
      if (!await ownsLatest(store, plan, context.before.metadata.id)) return { allow: false, code: 'memory_import_peer_revision', message: 'A native revision owns this target', remediation: 'Retain the native revision and retry the portable import' };
      if (context.operation === 'delete' && await protectedByPeer(store, plan, context.before.metadata.id)) return { allow: false, code: 'memory_import_peer_reference', message: 'A peer references this target', remediation: 'Retain the peer reference graph and retry the portable import' };
    };
    setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onWrite: [], onRead: [], onIndex: [], beforeMutation: [{ layer: 'project', name: 'pm-memory-compensation', run: guard }] });
    return run();
  });
}
/** Restore only import-owned documents; the SDK keeps an append-only compensation audit. */
export async function rollbackImport(store: Store, plan: ImportPlan, options: PortableImportOptions): Promise<void> {
  const client = new PmClient({ pmRoot: store.workspace, noExtensions: true });
  const transactionId = `${plan.transactionId}-rollback`;
  /** Classify current ownership and references again at every SDK recovery inspection. */
  const pending = async (target: ExpectedTarget): Promise<boolean> => {
    const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    const item = items.find(row => row.id === target.id);
    if (item === undefined || (target.version !== null && item.updated_at === target.version) || !await ownsLatest(store, plan, target.id)) return false;
    if (target.version === null && await protectedByPeer(store, plan, target.id)) return false;
    return true;
  };
  const steps = [...(plan.initial ?? plan.expected)].reverse().map(target => ({
    id: `restore-${target.id}`,
    /** Already restored, absent and peer-owned targets are complete rollback steps. */
    inspect: async () => ({ state: await pending(target) ? 'pending' as const : 'applied' as const }),
    /** Use native SDK restoration/deletion, protected again under its item lock. */
    apply: async () => {
      await options.onStep?.('rollback-apply');
      if (!await pending(target)) return undefined;
      const mutationOptions = { author: plan.author, force: true, message: `bulk-item-transaction ${transactionId} ${target.id} compensate` };
      if (target.version === null) await deleteItem(target.id, mutationOptions, { pmRoot: store.workspace });
      else await restore(target.id, target.version, mutationOptions, { pmRoot: store.workspace });
      return undefined;
    },
    /** Rollback is monotonic: a restored version must never be reapplied on error. */
    compensate: async () => {},
  }));
  await store.fence(() => guardedCompensation(store, plan, () => commitWorkspaceTransaction({ pmRoot: store.workspace, author: plan.author, transactionId, steps, onTransition: options.onTransition })));
}
