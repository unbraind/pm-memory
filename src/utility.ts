import { readSettings, resolveRuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import type { Memory, MemoryOptions } from './types.ts';
import type { MemoryExposure, MemoryObservation, ObserveOptions, UtilityCounts, UtilityLedger, UtilityReport } from './utility-types.ts';
import { digest, MemoryError, privacy, slug, text } from './core.ts';
import { Store } from './store.ts';

/** Hash semantic guidance rather than operational counters, utility evidence or timestamps. */
export function memoryRevision(memory: Memory): string {
  return digest(JSON.stringify([memory.title, memory.description, memory.body, memory.kind, memory.why, memory.how, memory.pinned, memory.tags]));
}
/** Refuse malformed durable evidence instead of silently shrinking a denominator. */
function invalidLedger(): never {
  throw new MemoryError('schema', 'Invalid memory utility ledger', 'Inspect native item history and restore valid version-1 utility metadata through an audited update');
}
/** Narrow arbitrary JSON to an object without trusting its field values. */
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** Require a canonical receipt, content hash and ISO clock value. */
function exposure(value: unknown): value is MemoryExposure {
  return object(value) && typeof value.recall === 'string' && /^[a-f0-9]{24}$/.test(value.recall) && typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision) && timestamp(value.at);
}
/** Validate persisted timestamps without accepting loose date parsing or invalid calendar values. */
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** Check the closed vocabulary and bounded evidence before any mutation. */
function observationInput(value: Record<string, unknown>): boolean {
  return ['helpful', 'unhelpful'].includes(value.feedback as string) && ['improved', 'unchanged', 'worsened', 'unknown'].includes(value.outcome as string) && ['isolated', 'confounded', 'unknown'].includes(value.attribution as string) && typeof value.task === 'string' && /^[a-z0-9][a-z0-9_-]{0,119}$/.test(value.task) && typeof value.evidence === 'string' && value.evidence.trim().length > 0 && value.evidence.length <= 1000;
}
/** Decode all persisted records and verify unique identities plus exposure referential integrity. */
export function parseUtility(raw: unknown): UtilityLedger {
  if (raw === undefined || raw === '') return { version: 1, exposures: [], observations: [] };
  let value: unknown;
  try { value = JSON.parse(String(raw)); } catch { return invalidLedger(); }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.exposures) || !Array.isArray(value.observations)) return invalidLedger();
  const receipts = new Set<string>(); const tasks = new Set<string>();
  for (const row of value.exposures) {
    if (!exposure(row) || receipts.has(row.recall)) return invalidLedger();
    receipts.add(row.recall);
  }
  for (const row of value.observations) {
    if (!object(row) || !observationInput(row) || typeof row.recall !== 'string' || !receipts.has(row.recall) || tasks.has(String(row.task)) || !timestamp(row.at) || typeof row.task_status !== 'string' || typeof row.terminal !== 'boolean' || !(row.completed_at === '' || timestamp(row.completed_at))) return invalidLedger();
    tasks.add(String(row.task));
  }
  return value as unknown as UtilityLedger;
}
/** Read evidence through native SDK item access, never a sidecar or git subprocess. */
export async function readUtility(store: Store, memory: Memory): Promise<UtilityLedger> {
  const ledger = parseUtility((await store.client.get(memory.id, { full: true })).item.memory_utility);
  if (ledger.exposures.length > memory.recalls) return invalidLedger();
  return ledger;
}
/** Select a memory including archived guidance so historical feedback remains accessible. */
async function select(store: Store, key: string): Promise<Memory> {
  slug(key);
  const memory = (await store.read()).find(item => item.slug === key && !item.artifact);
  if (memory === undefined) throw new MemoryError('missing', 'Memory slug does not exist', 'Use memory index to select a memory slug; imported indexes cannot receive feedback');
  return memory;
}
/** Store one immutable explicit judgment per memory/task, with byte-stable idempotent retries. */
export async function observe(key: string, options: ObserveOptions): Promise<{ slug: string; task: string; recorded: boolean }> {
  if (!observationInput(options as unknown as Record<string, unknown>) || !/^[a-f0-9]{24}$/.test(options.recall)) throw new MemoryError('invalid', 'Invalid memory observation', 'Supply --recall, --task, --feedback helpful|unhelpful, --outcome improved|unchanged|worsened|unknown, --attribution isolated|confounded|unknown and --evidence of 1-1000 characters');
  for (const value of [options.task, options.evidence]) privacy(text(value));
  const store = new Store(options);
  return store.write(async () => {
    const memory = await select(store, key); const ledger = await readUtility(store, memory);
    const recalled = ledger.exposures.find(row => row.recall === options.recall);
    if (recalled === undefined) throw new MemoryError('missing', 'No matching memory recall receipt', 'Recall this memory first and pass the returned recall receipt; legacy counters cannot establish an exposure');
    const task = (await store.client.get(options.task, { full: true })).item;
    const input = { recall: options.recall, task: text(task.id), feedback: options.feedback, outcome: options.outcome, attribution: options.attribution, evidence: options.evidence };
    const previous = ledger.observations.find(row => row.task === input.task);
    if (previous !== undefined) {
      if (Object.entries(input).some(([name, value]) => previous[name as keyof MemoryObservation] !== value)) throw new MemoryError('conflict', 'This memory already has feedback for that task', 'Retry the original observation unchanged; retain contradictory evidence in native task comments rather than counting the task twice');
      return { slug: key, task: input.task, recorded: false };
    }
    if (task.type === 'Knowledge') throw new MemoryError('invalid', 'Feedback must link a task outcome', 'Select a native task item rather than another Knowledge item');
    const statuses = resolveRuntimeStatusRegistry((await readSettings(store.workspace)).schema);
    const completion = task.completed_at ?? task.closed_at ?? '';
    ledger.observations.push({ ...input, task_status: text(task.status), completed_at: completion, terminal: statuses.terminal_statuses.has(text(task.status)), at: new Date().toISOString() });
    await store.history(memory.id);
    await store.fields(memory.id, { utility: JSON.stringify(ledger) });
    return { slug: key, task: input.task, recorded: true };
  });
}
/** Exclude confounders first, then unknown evidence, then outcomes without proven later completion. */
function exclusion(row: MemoryObservation, recalled: MemoryExposure): keyof UtilityCounts['unscored'] | undefined {
  if (row.attribution === 'confounded') return 'confounded';
  if (row.attribution === 'unknown' || row.outcome === 'unknown') return 'unknown';
  if (!row.terminal || row.completed_at === '' || row.completed_at < recalled.at || row.completed_at > row.at) return 'not_later';
  return undefined;
}
/** Aggregate raw observations without inventing zero-case rates or losing excluded source rows. */
export function utilityCounts(exposures: MemoryExposure[], observations: MemoryObservation[]): UtilityCounts {
  const receipts = new Map(exposures.map(row => [row.recall, row]));
  const rows = observations.filter(row => receipts.has(row.recall));
  const observed = new Set(rows.map(row => row.recall)).size;
  const result: UtilityCounts = { exposures: exposures.length, observed_exposures: observed, unobserved_exposures: exposures.length - observed, observations: rows.length, helpful: 0, unhelpful: 0, attribution: { isolated: 0, confounded: 0, unknown: 0 }, outcomes: { improved: 0, unchanged: 0, worsened: 0, unknown: 0 }, scored: 0, unscored: { confounded: 0, unknown: 0, not_later: 0 }, by_feedback: { helpful: { scored: 0, improved: 0, unchanged: 0, worsened: 0 }, unhelpful: { scored: 0, improved: 0, unchanged: 0, worsened: 0 } } };
  for (const row of rows) {
    result[row.feedback]++; result.attribution[row.attribution]++; result.outcomes[row.outcome]++;
    const reason = exclusion(row, receipts.get(row.recall)!);
    if (reason !== undefined) result.unscored[reason]++;
    else {
      result.scored++; result.by_feedback[row.feedback].scored++;
      result.by_feedback[row.feedback][row.outcome as 'improved' | 'unchanged' | 'worsened']++;
    }
  }
  return result;
}
/** Return a compact, read-only report; all historical revisions and missing observations stay visible. */
export async function utility(key: string, options: MemoryOptions): Promise<UtilityReport> {
  const store = new Store(options);
  return store.write(async () => {
    const memory = await select(store, key); const ledger = await readUtility(store, memory); const revision = memoryRevision(memory);
    return { slug: key, complete: true, recalls: memory.recalls, legacy_exposures: memory.recalls - ledger.exposures.length, lifetime: utilityCounts(ledger.exposures, ledger.observations), revision, current: utilityCounts(ledger.exposures.filter(row => row.revision === revision), ledger.observations) };
  });
}
