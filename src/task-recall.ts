import { encode } from '@toon-format/toon';
import { certifyCompleteListResult, createOutputOmissionReceipt, fitOutputEnvelope, resolveContextIntentContract } from '@unbrained/pm-cli/sdk';
import type { FittedOutputEnvelope, OutputOmissionReceipt, PmContextIntentContract } from '@unbrained/pm-cli/sdk';
import { budget, MemoryError, text, words } from './core.ts';
import { eligibleGuidance } from './guidance.ts';
import { active, scored } from './memory.ts';
import { Store } from './store.ts';
import type { Memory, MemoryOptions } from './types.ts';

/** The SDK catalogs this intent by the registered extension action. */
export const contextIntents = [{
  command: 'memory-recall-task',
  intent: 'resume',
  source: 'package',
  description: 'Recall actionable knowledge for an existing work item.',
  included_field_groups: ['task_id', 'basis', 'memories'],
  token_budget: 450,
}] satisfies PmContextIntentContract[];

/** Explicit tracker and optional override to the resume intent's token ceiling. */
export interface TaskRecallOptions extends MemoryOptions {
  /** The package intent to apply. Defaults to resume. */
  intent?: string;
  /** Greatest whole-packet token estimate allowed in either supported format. */
  tokenBudget?: number;
}

/** The complete actionable fields, with a stable key for inspecting the source. */
export interface TaskRecallRow {
  /** Stable memory key accepted by memory get. */
  slug: string;
  /** Complete retained fact. */
  body: string;
  /** Rationale, when authored. */
  why?: string;
  /** Application instructions, when authored. */
  how?: string;
}

/** Domain payload passed to the SDK's envelope fitter. */
type TaskRecallProjection = {
  task_id: string;
  intent: string;
  basis: 'linked' | 'lexical';
  memories: readonly TaskRecallRow[];
  omission_receipt: OutputOmissionReceipt;
};

/** Ranked resume projection and SDK proof of whole-row admission. */
export type TaskRecallPacket = FittedOutputEnvelope<TaskRecallProjection>;

/** Common connective words alone are insufficient evidence of relevance. */
const CONNECTIVES = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'was', 'were', 'with']);

/** Resolve the native resume contract before opening a tracker. */
export function taskRecallIntent(id: string, requested?: string): PmContextIntentContract {
  const declaration = contextIntents[0];
  return resolveContextIntentContract(declaration.command, requested ?? declaration.intent, contextIntents, [id])!;
}

/** The local projection, before packet-specific provenance and budget are applied. */
type RankedTask = { id: string; basis: 'linked' | 'lexical'; rows: TaskRecallRow[]; ineligible: number };

/** Read every native item and body through the SDK's complete-list contract. */
export async function readTaskRecallCorpus(store: Store) {
  return certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
}

/** Rank one certified snapshot, filtering protected memories before relevance scoring. */
export async function rankTask(
  id: string, store: Store, items: Awaited<ReturnType<typeof readTaskRecallCorpus>>,
  canShare?: (row: TaskRecallRow) => boolean,
): Promise<RankedTask> {
  const task = items.find(item => item.id === id && item.type !== 'Knowledge');
  if (task === undefined) throw new MemoryError('missing', 'Work item does not exist', 'Use the full ID of a non-Knowledge item in this tracker');

  const current = eligibleGuidance(active(await store.read(items)), 'exclude', Date.now())
    .filter(item => item.verdict !== 'stale');
  let ineligible = 0;
  const eligible = current.filter(item => {
    if (item.consent === undefined && (canShare === undefined || canShare(taskRow(item)))) return true;
    ineligible++;
    return false;
  });
  const targets = new Set(task.dependencies?.map(edge => edge.id));
  const linked = eligible.filter(item => item.links.includes(task.id) || targets.has(item.id));
  const hasLinks = linked.length > 0;
  const basis = hasLinks ? 'linked' : 'lexical';
  const query = [...words([task.title, task.description].join('\n'))].filter(word => !CONNECTIVES.has(word)).join(' ');
  const rows = scored(hasLinks ? linked : eligible, query)
    .filter(entry => hasLinks || entry.lexical > 0)
    .map(({ item }) => taskRow(item));
  return { id: task.id, basis, rows, ineligible };
}

/** Project the complete actionable fields used by both resume forms. */
function taskRow(item: Memory): TaskRecallRow {
  return {
    slug: item.slug,
    body: item.body,
    ...(item.why ? { why: item.why } : {}),
    ...(item.how ? { how: item.how } : {}),
  };
}

/** Rank a certified same-tracker snapshot without recording recall exposures or calling embeddings. */
export async function recallTask(taskId: string, options: TaskRecallOptions): Promise<TaskRecallPacket> {
  const id = text(taskId).trim();
  const intent = taskRecallIntent(id, options.intent);
  const limit = budget(options.tokenBudget ?? intent.token_budget);
  const store = new Store(options);
  const { id: nativeId, basis, rows } = await rankTask(id, store, await readTaskRecallCorpus(store));
  return fitOutputEnvelope(rows, {
    tokenBudget: limit,
    buildEnvelope: (memories, receipt): TaskRecallProjection => ({
      task_id: nativeId,
      intent: intent.intent,
      basis,
      memories,
      omission_receipt: createOutputOmissionReceipt(receipt.omitted_count > 0
        ? [{ name: 'matching_memories', restore_with: '--token-budget <larger-number>' }]
        : []),
    }),
    renderers: {
      json: value => JSON.stringify(value, null, 2) + '\n',
      toon: value => encode(value) + '\n',
    },
  }).envelope;
}
