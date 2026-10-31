import { readSettings, resolveTransactionSchema, resolveRuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import type { RuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import type { Memory } from './types.ts';

/** Hydrated schema type derived from the public SDK resolver's actual return contract. */
export type TrackerSchema = Awaited<ReturnType<typeof resolveTransactionSchema>>['schema'];

/** Read the SDK's hydrated schema for the same normalization used by native mutations. */
export async function trackerSchema(workspace: string): Promise<TrackerSchema> { return (await resolveTransactionSchema(workspace, await readSettings(workspace))).schema; }

/** Resolve lifecycle roles from the SDK's hydrated schema, including workflow files. */
export async function statusRegistry(workspace: string): Promise<RuntimeStatusRegistry> {
  return resolveRuntimeStatusRegistry(await trackerSchema(workspace));
}
/** Honor registry-derived cancellation while retaining legacy in-memory caller compatibility. */
export function isCanceled(item: Pick<Memory, 'status' | 'canceled'>): boolean { return item.canceled ?? item.status === 'canceled'; }
