import { commitWorkspaceTransaction, runWithActiveExtensions, setActiveExtensionHooks, restore, deleteItem, getItemAt, getHistoryPath, readHistoryEntries, canonicalDocument, PmClient, certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook } from '@unbrained/pm-cli/sdk/authoring';
import type { ImportPlan, ExpectedTarget } from './portable-plan.ts';
import { MEMORY_FIELDS, metadata, type Store } from './store.ts';
import type { PortableImportOptions } from './portable.ts';
import { portableFields, previousOwnership } from './portable-ownership.ts';
import { creator, sameOrigin } from './portable-origin.ts';

/** Creation ownership requires the entire planned write set and its represented receipt to match the SDK birth. */
export async function ownsCreation(store: Store, plan: ImportPlan, id: string): Promise<boolean> {
  const mutation = plan.nodes?.find(row => row.id === id) ?? plan.mutations.find(row => row.id === id && row.op === 'create');
  const target = plan.ownership?.find(row => row.id === id);
  if (mutation === undefined) return false;
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
  if (entries[0]?.op !== 'create' || entries[0].author !== plan.author) return false;
  if (typeof mutation.options!.message === 'string' && entries[0].message !== mutation.options!.message) return false;
  const birth = creator(id, entries[0], undefined);
  if (birth === undefined || birth.metadata.type !== mutation.options!.type || birth.metadata.memory_slug !== mutation.options!.memorySlug || birth.metadata.memory_source !== mutation.options!.memorySource || birth.metadata.memory_original !== mutation.options!.memoryOriginal) return false;
  const origin = plan.expected.find(row => row.id === id)?.origin;
  if (origin !== undefined && !sameOrigin(birth.origin, origin)) return false;
  try {
    const { document } = await getItemAt(id, '1', { pmRoot: store.workspace });
    // Creation writes defaults too. A legacy ownership receipt intentionally omits
    // those fields, so it cannot by itself prove ownership of the whole creation.
    const projected = { ...document.metadata };
    for (const key of ['title', 'description', 'type']) if (Object.hasOwn(mutation.options!, key)) Object.assign(projected, { [key]: mutation.options![key] });
    for (const field of MEMORY_FIELDS) {
      const option = Object.keys(metadata({ [field.name.slice('memory_'.length)]: '' }))[0];
      if (Object.hasOwn(mutation.options!, option)) Object.assign(projected, { [field.name]: mutation.options![option] });
      else if (Object.hasOwn(document.metadata, field.name)) return false;
    }
    const expected = canonicalDocument({ metadata: projected, body: mutation.options!.body as string });
    if (JSON.stringify(canonicalDocument(document)) !== JSON.stringify(expected)) return false;
    const [memory] = await store.read(new Set([id]), [{ ...document.metadata, body: document.body }]);
    const fields = portableFields(memory, memory.body);
    const receipt = target ?? await previousOwnership(store, memory, new Map());
    return receipt !== undefined && Object.entries(receipt.fields).every(([key, value]) => fields[key as keyof typeof fields] === value);
  } catch { return false; }
}

/** Immutable SDK history, rather than mutable content, identifies an owned write. */
export async function ownsLatest(store: Store, plan: ImportPlan, id: string): Promise<boolean> {
  if (!plan.expected.some(target => target.id === id)) return false;
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
  const last = entries.at(-1);
  if (last?.author !== plan.author) return false;
  if (last.op === 'create') return entries.length === 1 && await ownsCreation(store, plan, id);
  if ([plan.transactionId, ...(plan.ownedTransactions ?? [])].some(id => last.message?.startsWith(`bulk-item-transaction ${id} `) || last.message?.startsWith(`bulk-item-transaction ${id}-`))) return true;
  return false;
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
