import { encode } from '@toon-format/toon';
import { certifyCompleteListResult, createOutputOmissionReceipt, fitOutputEnvelope, getHistoryPath, readHistoryEntries, resolveContextIntentContract, verifyHistoryEntries } from '@unbrained/pm-cli/sdk';
import type { FittedOutputEnvelope, OutputOmissionReceipt, OutputProjectionFieldGroup, PmClient, PmContextIntentContract } from '@unbrained/pm-cli/sdk';
import { isGuidanceField } from './content.ts';
import { contradicts } from './consolidate.ts';
import { budget, MemoryError, text, words } from './core.ts';
import { eligibleGuidance } from './guidance.ts';
import { active, scored } from './memory.ts';
import { Store } from './store.ts';
import type { Memory, MemoryOptions } from './types.ts';

const RESUME = 'resume';
const EVIDENCE = 'resume-evidence';
const FIELDS = ['task_id', 'basis', 'memories'];

/** The SDK catalogs both projections by the registered extension action. */
export const contextIntents = [{
  command: 'memory-recall-task',
  intent: RESUME,
  source: 'package',
  description: 'Recall actionable knowledge for an existing work item.',
  included_field_groups: FIELDS,
  token_budget: 450,
}, {
  command: 'memory-recall-task',
  intent: EVIDENCE,
  source: 'package',
  description: 'Recall knowledge with freshness and single-source conflict evidence.',
  included_field_groups: [...FIELDS, 'freshness', 'conflicts'],
  token_budget: 450,
}] satisfies PmContextIntentContract[];

/** Explicit tracker and optional override to the resume intent's token ceiling. */
export interface TaskRecallOptions extends MemoryOptions {
  /** The package intent to apply. Defaults to resume. */
  intent?: string;
  /** Greatest whole-packet token estimate allowed in either supported format. */
  tokenBudget?: number;
}

/** Native evidence attached to an admitted memory by the evidence projection. */
type Freshness = {
  /** Classification using persisted native evidence. */
  freshness: 'fresh' | 'stale' | 'unverified' | 'superseded';
  /** Native item that holds the evidence field. */
  source_id: string;
  /** Native field supporting the classification. */
  field: 'memory_verdict' | 'memory_verified_at' | 'memory_changed_at' | 'updated_at' | 'dependencies';
};

/** A pair with a single native field that records precedence or refutes one claim. */
export interface TaskRecallConflict {
  /** Competing memory slugs in recall rank order. */
  left: string;
  right: string;
  /** Native item to pass to pm get. */
  item_id: string;
  /** Native field to pass to pm get --fields. */
  field: 'dependencies' | 'memory_reason';
}

/** The complete actionable fields, with a stable key for inspecting the source. */
export interface TaskRecallRow extends Partial<Freshness> {
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
  conflicts?: readonly TaskRecallConflict[];
  omission_receipt: OutputOmissionReceipt;
};

/** Ranked resume projection and SDK proof of whole-row admission. */
export type TaskRecallPacket = FittedOutputEnvelope<TaskRecallProjection>;

/** Common connective words alone are insufficient evidence of relevance. */
const CONNECTIVES = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'was', 'were', 'with']);

type NativeItem = Awaited<ReturnType<PmClient['listAllComplete']>>['items'][number];
type Supersessions = Map<string, Set<string>>;

/** Index the incoming side of the SDK's native supersedes relationship. */
function supersessions(memories: readonly Memory[]): Supersessions {
  const incoming = new Map<string, Set<string>>();
  const ids = new Set(memories.map(item => item.id));
  for (const item of memories) for (const edge of item.relationships) {
    if (edge.kind !== 'supersedes' || !ids.has(edge.id)) continue;
    const successors = incoming.get(edge.id) ?? new Set<string>();
    successors.add(item.id);
    incoming.set(edge.id, successors);
  }
  return incoming;
}

/** Check history order when a legacy or extension-free edit may have bypassed native invalidation. */
async function verificationCoversGuidance(workspace: string, { body, ...metadata }: NativeItem): Promise<boolean> {
  const entries = await readHistoryEntries(getHistoryPath(workspace, metadata.id), metadata.id);
  if (!verifyHistoryEntries(entries, { metadata, body: String(body) }).ok) return false;
  const checked = entries.findLastIndex(entry => entry.patch.some(patch => patch.path === '/metadata/memory_verified_at'));
  const edited = entries.findLastIndex(entry => entry.patch.some(patch => {
    const [, scope, key] = patch.path.split('/');
    return isGuidanceField(scope === 'metadata' ? key : scope);
  }));
  return checked > edited || checked === 0 && entries[0].op === 'create';
}

/** Judge freshness against the content clock and the native verification history. */
async function freshness(item: Memory, native: NativeItem, replaced: Supersessions, workspace: string): Promise<Freshness> {
  const successorSource = replaced.get(item.id)?.values().next().value;
  if (successorSource !== undefined) return { freshness: 'superseded', source_id: successorSource, field: 'dependencies' };
  const source_id = item.id;
  if (item.verdict === 'stale') return { freshness: 'stale', source_id, field: 'memory_verdict' };
  if (item.verdict !== 'verified') return { freshness: 'unverified', source_id, field: 'memory_verdict' };
  const verified = Date.parse(String(native.memory_verified_at ?? ''));
  if (!Number.isFinite(verified)) return { freshness: 'unverified', source_id, field: 'memory_verified_at' };
  const field = native.memory_changed_at === undefined ? 'updated_at' : 'memory_changed_at';
  if (!(Date.parse(String(native[field])) <= verified)) return { freshness: 'unverified', source_id, field };
  const covered = await verificationCoversGuidance(workspace, native).catch(() => false);
  return { freshness: covered ? 'fresh' : 'unverified', source_id, field: 'memory_verified_at' };
}

/** An explicit edge takes precedence over a lexical match and stale verification. */
function conflictSource(left: Memory, right: Memory, replaced: Supersessions): Pick<TaskRecallConflict, 'item_id' | 'field'> | 'unresolved' | undefined {
  const replacesLeft = replaced.get(left.id)?.has(right.id) === true;
  const replacesRight = replaced.get(right.id)?.has(left.id) === true;
  if (replacesLeft && replacesRight) return 'unresolved';
  if (replacesLeft) return { item_id: right.id, field: 'dependencies' };
  if (replacesRight) return { item_id: left.id, field: 'dependencies' };
  if (!contradicts(left, right)) return undefined;
  const [suspect, other] = left.verdict === 'stale' ? [left, right] : [right, left];
  if (suspect.verdict === 'stale' && other.verdict !== 'stale' && suspect.reason?.trim()) return { item_id: suspect.id, field: 'memory_reason' };
  return 'unresolved';
}

/** Extend conflict evidence once per admitted prefix, including the fitter's final trial row. */
function conflictProjection(ranked: readonly Memory[], replaced: Supersessions): (count: number) => {
  conflicts: readonly TaskRecallConflict[];
  unresolved: boolean;
} {
  const conflicts: TaskRecallConflict[] = [];
  let unresolved = false;
  let examined = 0;
  return count => {
    for (; examined < count; examined++) {
      const right = ranked[examined];
      for (let index = 0; index < examined; index++) {
        const left = ranked[index];
        const source = conflictSource(left, right, replaced);
        if (source === 'unresolved') unresolved = true;
        else if (source !== undefined) conflicts.push({ left: left.slug, right: right.slug, ...source });
      }
    }
    // A rejected trial must not mutate the fitter's previously accepted packet.
    return { conflicts: [...conflicts], unresolved };
  };
}

/** Rank a certified same-tracker snapshot without recording recall exposures or calling embeddings. */
export async function recallTask(taskId: string, options: TaskRecallOptions): Promise<TaskRecallPacket> {
  const id = text(taskId).trim();
  const declaration = contextIntents[0];
  const intent = resolveContextIntentContract(declaration.command, options.intent ?? declaration.intent, contextIntents, [id])!;
  const limit = budget(options.tokenBudget ?? intent.token_budget);
  const store = new Store(options);
  const { items } = certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true }));
  const task = items.find(item => item.id === id && item.type !== 'Knowledge');
  if (task === undefined) throw new MemoryError('missing', 'Work item does not exist', 'Use the full ID of a non-Knowledge item in this tracker');

  const withEvidence = intent.intent === EVIDENCE;
  const eligible = eligibleGuidance(active(await store.read(items)), 'exclude', Date.now())
    .filter(item => item.consent === undefined && (withEvidence || item.verdict !== 'stale'));
  const targets = new Set(task.dependencies?.map(edge => edge.id));
  const linked = eligible.filter(item => item.links.includes(task.id) || targets.has(item.id));
  const hasLinks = linked.length > 0;
  const basis = hasLinks ? 'linked' : 'lexical';
  const query = [...words([task.title, task.description].join('\n'))].filter(word => !CONNECTIVES.has(word)).join(' ');
  const ranked = scored(hasLinks ? linked : eligible, query)
    .filter(entry => hasLinks || entry.lexical > 0)
    .map(entry => entry.item);
  const sources = new Map(withEvidence ? items.map(item => [item.id, item]) : []);
  const replaced = withEvidence ? supersessions(eligible) : new Map();
  const projectConflicts = withEvidence ? conflictProjection(ranked, replaced) : undefined;
  const rows: TaskRecallRow[] = [];
  for (const item of ranked) rows.push({
    slug: item.slug,
    body: item.body,
    ...(item.why ? { why: item.why } : {}),
    ...(item.how ? { how: item.how } : {}),
    ...(withEvidence ? await freshness(item, sources.get(item.id)!, replaced, store.workspace) : {}),
  });

  return fitOutputEnvelope(rows, {
    tokenBudget: limit,
    buildEnvelope: (memories, receipt): TaskRecallProjection => {
      const evidence = projectConflicts?.(memories.length);
      const omissions: OutputProjectionFieldGroup[] = [];
      if (receipt.omitted_count > 0) omissions.push({ name: 'matching_memories', restore_with: '--token-budget <larger-number>' });
      if (evidence?.unresolved) omissions.push({ name: 'conflict_sources', restore_with: 'pm memory get <slug>' });
      return {
        task_id: task.id,
        intent: intent.intent,
        basis,
        memories,
        ...(evidence === undefined ? {} : { conflicts: evidence.conflicts }),
        omission_receipt: createOutputOmissionReceipt(omissions),
      };
    },
    renderers: {
      json: value => JSON.stringify(value, null, 2) + '\n',
      toon: value => encode(value) + '\n',
    },
  }).envelope;
}
