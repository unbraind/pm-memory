import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { encode } from '@toon-format/toon';
import {
  CURRENT_ITEM_FORMAT_VERSION,
  createOutputOmissionReceipt,
  effectiveItemFormatVersion,
  fitOutputEnvelope,
  isSettingsReadFallback,
  loadGuardedRuntimeSchema,
  readSettingsWithMetadata,
  resolveItemTypeRegistry,
  resolvePmRoot,
  resolveRuntimeFieldRegistry,
  runWithActiveExtensions,
  runWithConfigurationOnlySettings,
} from '@unbrained/pm-cli/sdk';
import type { FittedOutputEnvelope, OutputOmissionReceipt } from '@unbrained/pm-cli/sdk';
import { budget, MemoryError, privacy, privacyRefusal, text } from './core.ts';
import { MEMORY_FIELDS, Store } from './store.ts';
import { rankTask, readTaskRecallCorpus, taskRecallIntent, type TaskRecallRow } from './task-recall.ts';

/** One explicitly selected tracker and its invocation-local sharing decision. */
export interface TaskRecallSource {
  /** Path to the tracker storage directory containing settings.json. */
  tracker: string;
  /** Native task ID in this tracker, defaulting to the command's task ID. */
  taskId?: string;
  /** Explicit approval to share unscoped memory from this tracker. */
  allowSharing?: boolean;
}

/** The entire federation read set and the shared resume intent and budget. */
export interface FederatedTaskRecallOptions {
  /** All selected trackers, in the desired source priority order. */
  sources: readonly TaskRecallSource[];
  /** The package intent to apply. Defaults to resume. */
  intent?: string;
  /** Whole-packet token budget across receipts and rows. */
  tokenBudget?: number;
}

/** A complete actionable row with the tracker path supplied by the caller. */
export type FederatedTaskRecallRow = TaskRecallRow & { tracker: string };

type SourceIdentity = { tracker: string; task_id: string };
type UnavailableReason = 'tracker_read_failed' | 'unsupported_version' | 'task_missing';
type Unavailable = SourceIdentity & { status: 'unavailable'; reason: UnavailableReason };
type NotShared = SourceIdentity & { status: 'ineligible'; reason: 'sharing_not_allowed' };
type ReadSource = SourceIdentity & {
  basis: 'linked' | 'lexical';
  included: number;
  omitted: number;
  ineligible: number;
};

/** Every selected tracker has a receipt, including sources with zero emitted rows. */
export type TaskRecallSourceReceipt = Unavailable | NotShared
  | (ReadSource & ({ status: 'included' | 'omitted' } | { status: 'ineligible'; reason: 'memory_policy' }));

type Projection = {
  task_id: string;
  intent: string;
  sources: readonly TaskRecallSourceReceipt[];
  memories: readonly FederatedTaskRecallRow[];
  omission_receipt: OutputOmissionReceipt;
};

/** Verified, provenance-bearing resume packet and its SDK budget receipt. */
export type FederatedTaskRecallPacket = FittedOutputEnvelope<Projection>;

type Selection = SourceIdentity & { workspace: string; allowSharing: boolean };
type SourceResult = Unavailable | NotShared | (SourceIdentity & {
  rank: Awaited<ReturnType<typeof rankTask>>;
});

/** Validate lexical selection before opening any tracker and refuse duplicate directories. */
function selectSources(id: string, sources: readonly TaskRecallSource[]): Selection[] {
  if (sources.length === 0) throw new MemoryError('invalid', 'Empty recall federation', 'Select at least one tracker');
  const seen = new Set<string>();
  return sources.map(source => {
    const tracker = text(source.tracker);
    const workspace = resolve(tracker);
    if (seen.has(workspace)) throw new MemoryError('invalid', 'Duplicate tracker selection', 'Select each tracker directory once');
    seen.add(workspace);
    return { tracker, workspace, task_id: text(source.taskId ?? id).trim(), allowSharing: source.allowSharing === true };
  });
}

/** Permit argv paths only when their exact selector also has an explicit sharing flag. */
export function taskRecallSources(selectors: readonly string[], approvals: readonly string[]): TaskRecallSource[] {
  const selected = new Set(selectors);
  if (approvals.some(approval => !selected.has(approval))) {
    throw new MemoryError('invalid', 'Sharing approval has no matching tracker selector', 'Repeat the exact --tracker value with --share-tracker');
  }
  const approved = new Set(approvals);
  return selectors.map(selector => {
    const separator = selector.indexOf('=');
    // Prefix a literal path containing an equals sign with ./ or use an absolute path.
    const taskId = separator >= 0 && /^[\w-]+$/.test(selector.slice(0, separator)) ? selector.slice(0, separator) : undefined;
    const tracker = taskId === undefined ? selector : selector.slice(separator + 1);
    return { tracker, taskId, allowSharing: approved.has(selector) };
  });
}

/** Refuse unexpected path indirection in the SDK's immediate item or cache directories. */
async function checkSourceDirectory(workspace: string, folder: string): Promise<void> {
  // The SDK type registry has already normalized and confined configured folders.
  const directory = join(workspace, folder);
  const actual = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (actual === undefined) return;
  if (actual !== directory || (await readdir(directory, { withFileTypes: true })).some(entry => entry.isSymbolicLink())) {
    throw new MemoryError('schema', 'Tracker directory contains a symbolic link', 'Use regular item and cache directories for federation');
  }
}

/** Validate the exact native settings and typed memory schema before loading the corpus. */
async function inspectTracker(workspace: string): Promise<void> {
  const { settings } = await readSettingsWithMetadata(workspace);
  if (isSettingsReadFallback(settings)) throw new MemoryError('schema', 'Tracker settings are invalid', 'Restore valid tracker settings');
  if (settings.version !== 1) throw new MemoryError('version', 'Unsupported tracker settings version', 'Use a compatible pm host');

  const { schema, type_definitions_from_file: types, warnings } = await loadGuardedRuntimeSchema(workspace, settings.schema);
  if (warnings.length > 0) throw new MemoryError('schema', 'Tracker schema could not be read', 'Restore valid tracker schema files');
  const registry = resolveItemTypeRegistry({ ...settings, item_types: { definitions: [...settings.item_types.definitions, ...(types ?? [])] } });
  if (Object.hasOwn(registry.type_to_folder, 'Knowledge')) {
    const fields = new Map(resolveRuntimeFieldRegistry(schema).definitions.map(field => [field.key, field.type]));
    if (fields.get('memory_consent') !== 'string' ||
        MEMORY_FIELDS.some(field => fields.has(field.name) && fields.get(field.name) !== field.type)) {
      throw new MemoryError('version', 'Incompatible memory schema', 'Use a tracker with the current memory field types');
    }
  }
  for (const folder of new Set([...Object.values(registry.type_to_folder), 'runtime'])) {
    await checkSourceDirectory(workspace, folder);
  }
}

/** Keep credential-bearing legacy rows and unapproved personal data inside their tracker. */
function canShareRow(row: TaskRecallRow): boolean {
  try { privacy(JSON.stringify(row)); return true; }
  catch (error) { privacyRefusal(error); return false; }
}

/** Map source-local operational failures to stable categories without disclosing diagnostics. */
function unavailableReason(error: unknown): UnavailableReason {
  if (error instanceof MemoryError) {
    if (error.code === 'version') return 'unsupported_version';
    if (error.code === 'missing') return 'task_missing';
  }
  return 'tracker_read_failed';
}

/** Disable extension loading and host hooks at the independent SDK read boundary. */
async function readSource({ tracker, workspace, task_id, allowSharing }: Selection): Promise<SourceResult> {
  const identity = { tracker, task_id };
  if (!allowSharing) return { ...identity, status: 'ineligible', reason: 'sharing_not_allowed' };
  try {
    const root = await realpath(workspace);
    await runWithConfigurationOnlySettings(root, () => inspectTracker(root));
    if (resolvePmRoot(process.cwd(), root) !== root) {
      throw new MemoryError('schema', 'Tracker path does not resolve exactly in pm', 'Select a tracker with an unambiguous directory path');
    }
    const rank = await runWithActiveExtensions({ path: root, noExtensions: true }, async () => {
      const store = new Store({ workspace: root });
      const items = await readTaskRecallCorpus(store);
      if (items.some(item => effectiveItemFormatVersion(item) > CURRENT_ITEM_FORMAT_VERSION)) {
        throw new MemoryError('version', 'Incompatible native item format version', 'Use a compatible pm host');
      }
      return rankTask(task_id, store, items, canShareRow);
    });
    return { ...identity, rank };
  } catch (error) {
    return { ...identity, status: 'unavailable', reason: unavailableReason(error) };
  }
}

/** Account separately for whole-row budget omission and policy withholding. */
function sourceReceipt(source: SourceResult, included: number): TaskRecallSourceReceipt {
  if (!('rank' in source)) return source;
  const { tracker, task_id, rank } = source;
  const { basis, rows, ineligible } = rank;
  const omitted = rows.length - included;
  const receipt = { tracker, task_id, basis, included, omitted, ineligible };
  if (rows.length === 0 && ineligible > 0) return { ...receipt, status: 'ineligible', reason: 'memory_policy' };
  return { ...receipt, status: omitted > 0 && included === 0 ? 'omitted' : 'included' };
}

/** Recall selected native tasks with one complete, SDK-fitted packet. */
export async function recallTaskFederated(taskId: string, options: FederatedTaskRecallOptions): Promise<FederatedTaskRecallPacket> {
  const id = text(taskId).trim();
  const intent = taskRecallIntent(id, options.intent);
  const tokenBudget = budget(options.tokenBudget ?? intent.token_budget);
  const sources: SourceResult[] = [];
  for (const source of selectSources(id, options.sources)) sources.push(await readSource(source));

  const candidates = sources.flatMap(source => 'rank' in source
    ? source.rank.rows.map(row => ({ tracker: source.tracker, ...row }))
    : []);
  return fitOutputEnvelope(candidates, {
    tokenBudget,
    policy: 'skip',
    buildEnvelope: (memories, receipt): Projection => {
      const counts = new Map<string, number>();
      for (const row of memories) counts.set(row.tracker, (counts.get(row.tracker) ?? 0) + 1);
      return {
        task_id: id,
        intent: intent.intent,
        sources: sources.map(source => sourceReceipt(source, counts.get(source.tracker) ?? 0)),
        memories,
        omission_receipt: createOutputOmissionReceipt(receipt.omitted_count > 0
          ? [{ name: 'matching_memories', restore_with: '--token-budget <larger-number>' }]
          : []),
      };
    },
    renderers: {
      json: value => JSON.stringify(value, null, 2) + '\n',
      toon: value => encode(value) + '\n',
    },
  }).envelope;
}
