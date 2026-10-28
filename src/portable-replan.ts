import { readSettings, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import { digest, MemoryError } from './core.ts';
import { expectedTargets, importIdentity } from './portable-plan.ts';
import type { ImportPlan } from './portable-plan.ts';
import { parsePolicy, type PortableGuidance } from './portable.ts';
import type { Store } from './store.ts';
import { relationshipPatch } from './portable-ownership.ts';
import type { BulkItemMutation, Dependency } from '@unbrained/pm-cli/sdk';

/** Validate the original policy payload before adopting a compensated creation. */
function recoveryRecord(mutation: BulkItemMutation): PortableGuidance {
  try {
    const original = mutation.options!.memoryOriginal;
    if (typeof original !== 'string') throw new Error();
    const originalValue: unknown = JSON.parse(Buffer.from(original, 'base64').toString('utf8'));
    if (!Array.isArray(originalValue)) throw new Error();
    return parsePolicy({ version: 1, format: 'pm-memory-policy', harness: 'agents-md', guidance: [originalValue[0]] }).guidance[0];
  } catch { throw new MemoryError('history', 'Unreadable node recovery payload', 'Preserve the owned intent and recover its verified portable export before retrying'); }
}

/** Rebind compensated creations whose deleted identities remain reserved by SDK history. */
export async function replanNodes(store: Store, plan: ImportPlan): Promise<ImportPlan> {
  if (plan.ownership === undefined) throw new MemoryError('history', 'Older graph plans require compensated recovery', 'Rerun the original memory import to compensate its older plan before replanning');
  const identity = await importIdentity(store, plan.input); const { transactionId } = identity;
  const settings = await readSettings(store.workspace);
  const ids = new Map(plan.expected.map(target => [target.id, plan.mutations.some(row => row.id === target.id && row.op === 'create') ? `${settings.id_prefix}${digest(`${transactionId}:${target.slug}`).slice(0, 24)}` : target.id]));
  const remapped = new Map(plan.expected.map(target => [target.id, ids.get(target.id)!]));
  /** Both represented and native-only edges keep external identities during remapping. */
  const remapEdge = (edge: Dependency): Dependency => ({ ...edge, id: remapped.get(edge.id) ?? edge.id });
  const ownership = plan.ownership.map(target => ({ ...target, id: remapped.get(target.id)!, relationships: target.relationships.map(remapEdge), graph: target.graph.map(remapEdge) }));
  const mutations = await Promise.all(plan.mutations.map(async mutation => {
    if (mutation.op === 'create' && mutation.options.memorySource === 'portable:policy-v1') recoveryRecord(mutation);
    const target = ownership.find(target => target.id === remapped.get(mutation.id))!;
    const { dep: _dep, depRemove: _remove, ...options } = mutation.options!;
    const before = mutation.op === 'create' ? undefined : (await store.client.get(mutation.id, { full: true })).item;
    return { ...mutation, id: target.id, options: { ...options, ...(mutation.op === 'create' ? itemDocumentToMutationOptions(JSON.stringify({ dependencies: target.graph }), 'create') : relationshipPatch(before!.dependencies ?? [], target.graph)) } };
  }));
  const expected = await expectedTargets(store, plan.expected.map(target => ({ id: ids.get(target.id)!, slug: target.slug, origin: target.origin })));
  const initial = (plan.initial ?? plan.expected).map(target => ({ ...target, id: ids.get(target.id)! }));
  return { ...plan, ...identity, invocationId: undefined, rollbackId: undefined, writes: plan.writes?.filter(row => ids.get(row.id) === row.id), ownership, mutations, expected, initial, members: [...ids.values()], nodes: undefined, births: undefined, nodesDone: false, snapshots: undefined };
}
