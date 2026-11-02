import { resolveRuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import type { RuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import type { Memory } from './types.ts';

import { trackerSchema } from './native-revision.ts';
export { trackerSchema } from './native-revision.ts';
export type { TrackerSchema } from './native-revision.ts';

/** Resolve lifecycle roles from the SDK's hydrated schema, including workflow files. */
export async function statusRegistry(workspace: string): Promise<RuntimeStatusRegistry> {
  return resolveRuntimeStatusRegistry(await trackerSchema(workspace));
}
/** Honor registry-derived cancellation while retaining legacy in-memory caller compatibility. */
export function isCanceled(item: Pick<Memory, 'status' | 'canceled'>): boolean { return item.canceled ?? item.status === 'canceled'; }

/** Retain literal legacy cancellation even when a custom registry names different terminal states. */
export function canceledStatus(status: string, registry: Pick<RuntimeStatusRegistry, 'terminal_canceled_statuses' | 'canceled_status'>): boolean {
  return status === 'canceled' || registry.terminal_canceled_statuses.has(status) || registry.canceled_status === status;
}
