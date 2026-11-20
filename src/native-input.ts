import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  createCheckpointId, createStdinTokenResolver, derivePmBulkMutationEffect, EXIT_CODE,
  itemDocumentToMutationOptions, loadMutationCheckpoint, PmCliError, PmClient,
  preserveMutationStdinTokenLiterals, printError, readSettings, refreshSearchArtifactsForMutation,
  resolveBodyFileContent, resolveRuntimeFieldRegistry, runUpdate, runUpdateMany,
  suppressHostOutput, transferMutationStdinTokenPolicy, withCliMutationInput, writeMutationCheckpoint,
} from '@unbrained/pm-cli/sdk';
import { declineServiceOverride, handleServiceOverride } from '@unbrained/pm-cli/sdk/authoring';
import type { ServiceOverrideContext } from '@unbrained/pm-cli/sdk/authoring';
import { isGuidanceField, nativeContentRevision } from './content.ts';

/** CLI parser marker for a native no-op followed by document decoding. */
export const DOCUMENT_INPUT = `pmMemoryDocumentInput:${randomUUID()}`;
/** CLI parser marker for applying a validated native bulk preview. */
export const APPLY_BULK = `pmMemoryApplyBulk:${randomUUID()}`;
const CHECKPOINT_DIRECTORY = 'update-many';
const COMBINED_CHECKPOINT = 'update-many-memory';
type BulkOptions = Parameters<typeof runUpdateMany>[0];
type BulkResult = Awaited<ReturnType<typeof runUpdateMany>>;
type BulkRow = NonNullable<BulkResult['rows']>[number];
type BulkCheckpoint = NonNullable<BulkResult['checkpoint']>;
type Global = Parameters<typeof runUpdateMany>[1];
type NativeResult = {
  command: string; args: string[]; pm_root: string; options: Record<string, unknown>; global: Global; result: BulkResult;
};

/** The SDK verifies the native checkpoint inverse under each item lock. */
const checkpointRestore = new AsyncLocalStorage<string>();

/** Match the native item identity used by memory reads and write guards. */
export function isMemory(item: { type?: string; memory_slug?: unknown }): boolean {
  return item.type === 'Knowledge' && item.memory_slug !== undefined;
}

/** Recognize an SDK-proven inverse dispatched from this invocation's checkpoint. */
export function isCheckpointRestore(operation: string, root: string): boolean {
  return operation === 'restore' && checkpointRestore.getStore() === root;
}

/** Select native bulk inputs that can propose a guidance change. */
export function needsBulkPreparation(options: Record<string, unknown>): boolean {
  return options.dryRun !== true && options.rollback === undefined &&
    ['title', 'description', 'body', 'tags', 'addTags', 'removeTags', 'add_tags', 'remove_tags', 'unset', 'field', 'memoryKind', 'memoryWhy', 'memoryHow']
      .some(option => options[option] !== undefined);
}

/** Submit verification through registered fields in both native command scopes. */
function prepareVerificationFields(options: Record<string, unknown>, item: Record<string, unknown>): void {
  if (!nativeContentRevision(options, item)) return;
  const fields = options.field as string[] | undefined ?? [];
  options.field = [...fields, `memory_changed_at=${options.memoryChangedAt}`, 'memory_verdict=unknown'];
  delete options.memoryChangedAt;
  delete options.memoryVerdict;
}

/** Feed the native full-document decoder before comparing or clearing verification evidence. */
async function applyDocument(context: NativeResult, raw: Record<string, unknown>): Promise<unknown> {
  const { pm_root, global, args: [id] } = context;
  const stdinFlags = ['body', 'bodyFile', 'description', 'dep', 'depRemove', 'comment', 'note', 'learning', 'file', 'test', 'doc', 'reminder', 'event', 'typeOption', 'field'];
  if (stdinFlags.some(key => [raw[key]].flat().some(value => typeof value === 'string' && value.trim() === '-'))) {
    throw new PmCliError('Only one option may consume stdin per command invocation.', EXIT_CODE.USAGE);
  }
  const input = await createStdinTokenResolver().resolveValue('-', '--stdin-json');
  const settings = await readSettings(pm_root);
  const decoded = itemDocumentToMutationOptions(input!, 'update', raw, resolveRuntimeFieldRegistry(settings.schema).definitions);
  const { bodyFile, ...fields } = decoded;
  const options = typeof bodyFile === 'string'
    ? transferMutationStdinTokenPolicy(decoded, { ...fields, body: await resolveBodyFileContent(bodyFile, fields.body as string | undefined) })
    : decoded;
  const client = PmClient.forActiveExtensionHost({ pmRoot: pm_root });
  const { item_hash } = await client.readItemRevision(id);
  const { item } = await client.get(id, { full: true });
  prepareVerificationFields(options, item);
  const { result } = await client.withExpectedItemRevisions([{ id, itemHash: item_hash }], () =>
    runUpdate(id, preserveMutationStdinTokenLiterals(withCliMutationInput(options)), { ...global, path: pm_root }));
  await refreshSearchArtifactsForMutation(pm_root, result.changed_fields.length ? [id] : [], { background: true });
  return result;
}

/** Collect native row receipts in selection order. */
function combineBulk(plan: BulkResult, parts: BulkResult[], mode: 'apply' | 'rollback'): BulkResult {
  const rows = parts.flatMap<BulkRow>(part => part.rows!);
  const ids = parts.flatMap(part => part.ids);
  const failed = rows.filter(row => row.status === 'failed').length;
  const skipped = rows.filter(row => row.status === 'skipped').length;
  const base = { ...plan };
  delete base.item_plans;
  return {
    ...base, ...derivePmBulkMutationEffect({ applied: ids.length, failed, skipped, unmatched: plan.unmatched_count ?? 0 }),
    mode, dry_run: false, rows: rows as BulkResult['rows'], ids,
    failed_count: failed, skipped_count: skipped,
    ...(mode === 'apply' ? { updated_count: ids.length } : { restored_count: ids.length }),
  };
}

/** Give one bulk command a single rollback entry backed by native row checkpoints. */
async function combineCheckpoints(root: string, parts: BulkCheckpoint[]): Promise<BulkCheckpoint> {
  const created_at = new Date().toISOString();
  const id = createCheckpointId(COMBINED_CHECKPOINT, created_at);
  const path = await writeMutationCheckpoint(root, CHECKPOINT_DIRECTORY, id, {
    schema_version: 2, id, created_at, items: [], rollback_strategy: 'guarded_inverse',
    memory_checkpoints: parts.map(part => part.id),
  });
  return { id, created_at, path, rollback_command: `pm update-many --rollback ${id}` };
}

/** Preserve the execution options that the native preview omits from its mutation summary. */
function bulkUpdate(options: Record<string, unknown>, normalized: Record<string, unknown>): BulkOptions['update'] {
  const update = { ...normalized };
  for (const key of ['author', 'message', 'force', 'allowUnresolvedDeps', 'ownershipMetadataBypass', 'ownershipDependencyBypass']) {
    if (options[key] !== undefined) update[key] = options[key];
  }
  return preserveMutationStdinTokenLiterals(withCliMutationInput(update));
}

/** Apply the SDK's validated native preview with a fresh, guarded preparation for each memory. */
async function applyBulk(context: NativeResult, plan: BulkResult): Promise<BulkResult> {
  const { pm_root, options, global } = context;
  const scope = { ...global, path: pm_root };
  const client = PmClient.forActiveExtensionHost({ pmRoot: pm_root });
  const planned_update_options = { ...plan.planned_update_options };
  delete planned_update_options[APPLY_BULK];
  const input = bulkUpdate(options, planned_update_options);
  const parts: BulkResult[] = [];
  for (const row of plan.item_plans!) {
    const apply = (update: BulkOptions['update']) =>
      runUpdateMany({ list: { ids: row.id }, update, checkpoint: options.checkpoint as boolean | undefined }, scope);
    if (!row.changes.some(change => isGuidanceField(change.field))) {
      parts.push(await apply(input));
      continue;
    }
    const { item_hash } = await client.readItemRevision(row.id);
    const { item } = await client.get(row.id, { full: true });
    const update = withCliMutationInput(input);
    if (isMemory(item)) prepareVerificationFields(update, item);
    const { result } = await client.withExpectedItemRevisions([{ id: row.id, itemHash: item_hash }], () => apply(update));
    parts.push(result);
  }
  const result = combineBulk({ ...plan, planned_update_options }, parts, 'apply');
  const checkpoints = parts.flatMap(part => part.checkpoint ?? []);
  if (checkpoints.length > 0) result.checkpoint = await combineCheckpoints(pm_root, checkpoints);
  await refreshSearchArtifactsForMutation(pm_root, result.ids, { background: true });
  return result;
}

/** Apply only the native guarded inverses named by a package bulk checkpoint. */
async function rollbackBulk(context: NativeResult, plan: BulkResult): Promise<BulkResult> {
  const { pm_root, options, global } = context;
  const { record } = await loadMutationCheckpoint(pm_root, CHECKPOINT_DIRECTORY, plan.rollback_checkpoint_id!, 2);
  const update = bulkUpdate(options, {});
  const parts: BulkResult[] = [];
  for (const rollback of record.memory_checkpoints as string[]) {
    parts.push(await checkpointRestore.run(pm_root, () =>
      runUpdateMany({ list: {}, update, rollback }, { ...global, path: pm_root })));
  }
  const result = combineBulk({ ...plan, matched_count: parts.reduce((count, part) => count + part.matched_count, 0) }, parts, 'rollback');
  await refreshSearchArtifactsForMutation(pm_root, result.ids, { background: true });
  return result;
}

/** Complete only invocations whose native planning or no-op was selected by the parser. */
export async function finishNativeInput({ payload }: ServiceOverrideContext) {
  const context = payload as NativeResult;
  const { command, options, global, result } = context;
  try {
    if (command === 'update' && options[DOCUMENT_INPUT] !== undefined) {
      return handleServiceOverride(await applyDocument(context, options[DOCUMENT_INPUT] as Record<string, unknown>));
    }
    if (command === 'update-many' && options[APPLY_BULK] === true) return handleServiceOverride(await applyBulk(context, result));
    if (command === 'update-many' && result.rollback_checkpoint_id?.startsWith(`${COMBINED_CHECKPOINT}-`)) {
      return handleServiceOverride(await rollbackBulk(context, result));
    }
  } catch (error) {
    const { message: detail, exitCode: exit_code = EXIT_CODE.GENERIC_FAILURE, context: { code } = {} } = error as PmCliError;
    printError(global.json ? JSON.stringify({ detail, code, exit_code }) : detail);
    return handleServiceOverride({ ...suppressHostOutput(), exit_code });
  }
  return declineServiceOverride();
}
