import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, resolve } from 'node:path';
import { createMutationGuardSdk, readSettings, resolveItemTypeRegistry, runActiveBeforeMutationHooks } from '@unbrained/pm-cli/sdk';
import type { CreateResult, UpdateResult } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook, ExtensionApi } from '@unbrained/pm-cli/sdk/authoring';
import type { Store } from './store.ts';
import { MemoryError } from './core.ts';

/** Private discovery operation denies before persistence and never represents an item transition. */
const PROBE = 'pm-memory-verification-guard-probe';
/** Results returned by genuine SDK native item mutations. */
type HostResult = UpdateResult | CreateResult | void;
/** One invocation's guard and attested in-process host write, isolated from concurrent callers. */
interface HostExpectation { store: Store; id: string; guard: BeforeMutationHook; phase: 'read' | 'probe' | 'write'; attested: boolean; publish: () => Promise<HostResult>; result?: Promise<HostResult> }
/** Async-local expectations cannot cross an RPC or subprocess transport. */
const expectations = new AsyncLocalStorage<HostExpectation>();

/** Refuse unsupported hosts before dispatching any native mutation. */
function unavailable(): MemoryError { return new MemoryError('host_guard', 'Host verification guard is unavailable', 'Activate pm-memory mutation hooks in an in-process host, or use the default client'); }

/** Deny discovery and any unexpected write in a read-only attestation with the same typed refusal. */
function denyHostWrite(): never { throw unavailable(); }

/** Register the revision guard and a read-only handshake without replacing any host hook set. */
export function registerNativeHost(api: ExtensionApi): void {
  api.hooks.beforeMutation(async context => {
    const task = expectations.getStore();
    if (task === undefined || resolve(context.pm_root) !== resolve(task.store.workspace)) return;
    if (task.phase === 'probe' && context.operation === PROBE) {
      task.attested = true;
      denyHostWrite(); // Deny the read-only discovery operation before persistence.
    }
    if (task.phase === 'write' && (context.before?.metadata.id ?? context.after?.metadata.id) === task.id) await task.guard(context);
  });
  api.hooks.onRead(async context => {
    const task = expectations.getStore();
    if (task === undefined || task.phase !== 'read') return;
    const path = relative(resolve(task.store.workspace), resolve(context.path));
    if (path.startsWith('..') || isAbsolute(path)) return;
    task.phase = 'probe';
    const settings = await readSettings(task.store.workspace);
    try {
      await runActiveBeforeMutationHooks({ pm_root: task.store.workspace, operation: PROBE, before: null, after: null, changed_fields: [], sdk: createMutationGuardSdk({ pmRoot: task.store.workspace, settings, typeToFolder: resolveItemTypeRegistry(settings).type_to_folder }) });
    } catch { /* Only this invocation's registered guard can attest; policy denials cannot authorize a write. */ }
    if (task.attested) {
      task.phase = 'write';
      task.result = task.publish();
      await task.result; // Keep the host scope alive until the separately guarded write settles.
    }
  });
}

/** Discover a live guard through a read, then dispatch inside that exact host scope; never write without attestation. */
async function guardedHostMutation(store: Store, id: string, guard: BeforeMutationHook, discover: () => Promise<unknown>, publish: () => Promise<HostResult>): Promise<HostResult> {
  const task: HostExpectation = { store, id, guard, phase: 'read', attested: false, publish };
  return expectations.run(task, async () => {
    try { await discover(); } catch { /* Discovery cannot authorize a write; retain any already-dispatched mutation's own result. */ }
    if (task.result === undefined) throw unavailable();
    return task.result;
  });
}
/** Preserve the merged native verification path and every active host mutation policy. */
export function guardedHostUpdate(store: Store, client: Store['client'], id: string, guard: BeforeMutationHook, options: Record<string, unknown>): Promise<UpdateResult> {
  return guardedHostMutation(store, id, guard, () => client.get(id, { full: true }), () => store.client.run('update', { id, options, fullChangedFields: true }) as Promise<UpdateResult>) as Promise<UpdateResult>;
}
/** Attest an active host even in an empty tracker before dispatching the actual guarded creation. */
export function guardedHostCreate(store: Store, client: Store['client'], id: string, guard: BeforeMutationHook, options: Record<string, unknown>): Promise<CreateResult> {
  return guardedHostMutation(store, id, guard, () => client.schemaListFields(), () => store.client.run('create', { options: { ...options, id } }) as Promise<CreateResult>) as Promise<CreateResult>;
}

/** Attest an injected host before import recovery or schema setup can persist anything. */
export async function assertNativeHost(store: Store): Promise<void> {
  if (store.hostClient === undefined) return;
  await guardedHostMutation(store, '', denyHostWrite, () => store.hostClient!.schemaListFields(), async () => {});
}
