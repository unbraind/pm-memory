import { readSettings, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import { digest, MemoryError } from './core.ts';
import { expectedTargets } from './portable-plan.ts';
import type { ImportPlan } from './portable-plan.ts';
import { parsePolicy, type PortableGuidance } from './portable.ts';
import type { Store } from './store.ts';

/** Rebind compensated creations whose deleted identities remain reserved by SDK history. */
export async function replanNodes(store: Store, plan: ImportPlan): Promise<ImportPlan> {
  const replaced = await expectedTargets(store, plan.expected);
  const transactionId = `memory-policy-${digest(JSON.stringify([plan.input, replaced])).slice(0, 40)}`;
  const settings = await readSettings(store.workspace);
  const ids = new Map(plan.expected.map(target => [target.slug, plan.mutations.some(row => row.id === target.id && row.op === 'create') ? `${settings.id_prefix}${digest(`${transactionId}:${target.slug}`).slice(0, 24)}` : target.id]));
  const mutations = plan.mutations.map(mutation => {
    let row: PortableGuidance;
    try {
      const original = mutation.options!.memoryOriginal;
      if (typeof original !== 'string') throw new Error();
      const originalValue: unknown = JSON.parse(Buffer.from(original, 'base64').toString('utf8'));
      if (!Array.isArray(originalValue)) throw new Error();
      const record: unknown = originalValue[0];
      row = parsePolicy({ version: 1, format: 'pm-memory-policy', harness: 'agents-md', guidance: [record] }).guidance[0];
    } catch { throw new MemoryError('history', 'Unreadable node recovery payload', 'Preserve the owned intent and recover its verified portable export before retrying'); }
    return { ...mutation, id: ids.get(row.slug)!, options: { ...mutation.options, ...itemDocumentToMutationOptions(JSON.stringify({ dependencies: row.relationships.map(({ slug, ...edge }) => ({ id: ids.get(slug)!, ...edge })) }), mutation.op === 'create' ? 'create' : 'update') } };
  });
  const expected = await expectedTargets(store, plan.expected.map(target => ({ id: ids.get(target.slug)!, slug: target.slug })));
  return { ...plan, transactionId, mutations, expected, members: [...ids.values()], nodes: undefined, nodesDone: false, snapshots: undefined };
}
