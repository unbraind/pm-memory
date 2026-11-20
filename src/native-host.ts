import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, resolve } from 'node:path';
import { createMutationGuardSdk, readSettings, PmClient, resolveItemTypeRegistry, runActiveBeforeMutationHooks } from '@unbrained/pm-cli/sdk';
import type { CreateResult, UpdateResult } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook, ExtensionApi } from '@unbrained/pm-cli/sdk/authoring';
import type { Store } from './store.ts';
import { MemoryError } from './core.ts';
import { isGuidanceField, nativeContentRevision } from './content.ts';
import { APPLY_BULK, DOCUMENT_INPUT, finishNativeInput, isCheckpointRestore, isMemory, needsBulkPreparation } from './native-input.ts';

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

/** Verify the final SDK proposal after input normalization, with the item lock held. */
function invalidatedVerification(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const prior = Date.parse(String(before.memory_changed_at ?? before.created_at));
  const changed = Date.parse(String(after.memory_changed_at));
  return Number.isFinite(changed) && !(changed <= prior) && after.memory_verdict === 'unknown'
    && after.memory_verified_at === undefined && after.memory_reason === undefined;
}

/** Prepare CLI content updates and register the native mutation and revision guards. */
export function registerNativeHost(api: ExtensionApi): void {
  api.registerParser('update', async ({ args, options, pm_root }) => {
    const client = PmClient.forActiveExtensionHost({ pmRoot: pm_root });
    const { item } = await client.get(args[0], { full: true });
    if (!isMemory(item)) return {};
    if (options.stdinJson === true) {
      const inactive = Object.fromEntries(Object.keys(options).map(key => [key, undefined]));
      return { options: { ...inactive, [DOCUMENT_INPUT]: options } };
    }
    nativeContentRevision(options, item);
    return { options };
  });
  api.registerParser('update-many', ({ options }) =>
    needsBulkPreparation(options) ? { options: { ...options, dryRun: true, [APPLY_BULK]: true } } : {});
  api.registerService('command_result', finishNativeInput);
  api.hooks.beforeMutation(async context => {
    const { before, after, changed_fields } = context;
    if (before !== null && after !== null && isMemory(before.metadata) && changed_fields.some(isGuidanceField)
      && !invalidatedVerification(before.metadata, after.metadata)
      && !isCheckpointRestore(context.operation, context.pm_root)) {
      return { allow: false, code: 'memory_revision_required', message: 'Memory guidance edits must invalidate verification', remediation: 'Use pm update or update the content with pm memory remember --update' };
    }
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
  return guardedHostMutation(store, id, guard, () => client.get(id, { full: true }), async () => {
    const { item } = await client.get(id, { full: true });
    const revision = { ...options };
    nativeContentRevision(revision, item);
    return store.client.run('update', { id, options: revision, fullChangedFields: true }) as Promise<UpdateResult>;
  }) as Promise<UpdateResult>;
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
