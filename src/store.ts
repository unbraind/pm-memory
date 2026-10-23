import { certifyCompleteListResult, getHistoryPath, PmClient, readHistoryEntries, readSettings, verifyHistoryEntries } from '@unbrained/pm-cli/sdk';
import type { PmActionName, PmClientRunArgs } from '@unbrained/pm-cli/sdk';
import type { SchemaFieldDefinition } from '@unbrained/pm-cli/sdk/authoring';
import type { Memory, MemoryOptions } from './types.ts';
import { kind, MemoryError, slug } from './core.ts';
import { readWindow } from './guidance.ts';
import { writerLock } from './writer-lock.ts';

/** All memory metadata uses registered SDK fields, including lossless source artifacts. */
export const MEMORY_FIELDS: SchemaFieldDefinition[] = [
  ...['slug', 'kind', 'why', 'how', 'source', 'verified_at', 'verdict', 'path', 'original', 'reason', 'changed_at', 'merge', 'validity', 'utility', 'consent'].map(name => ({ name: `memory_${name}`, type: 'string' as const, optional: true })),
  ...['pinned', 'edited', 'artifact'].map(name => ({ name: `memory_${name}`, type: 'boolean' as const, optional: true })),
  { name: 'memory_recalls', type: 'number', optional: true },
];
/** Reuse host dispatch and active schema while restoring native author precedence. */
class HostClient extends PmClient {
  /** Injected native dispatcher retains the active extension context. */
  readonly host: PmClient;
  /** Explicit invocation identity; undefined delegates to the SDK environment/settings chain. */
  readonly author: string | undefined;
  /** Bind the dispatcher without inheriting its synthetic extension fallback identity. */
  constructor(host: PmClient, author: string | undefined) { super(); this.host = host; this.author = author; }
  /** Clear the host fallback when no invocation author exists; preserve per-call overrides. */
  override run(action: PmActionName, args: PmClientRunArgs = {}): Promise<unknown> {
    return this.host.run(action, { ...args, author: args.author ?? this.author });
  }
}
/** Tracker-bound native SDK client and serializable memory mutation boundary. */
export class Store {
  /** Native client with extension recursion disabled. */
  readonly client: PmClient;
  /** Explicit initialized tracker storage directory. */
  readonly workspace: string;
  /** Attribution used for SDK lock ownership. */
  readonly author: string;
  /** Bind only the explicit tracker; never discover a parent. */
  constructor(options: MemoryOptions) {
    this.workspace = options.workspace; this.author = options.author ?? 'pm-memory';
    this.client = options.client === undefined ? new PmClient({ pmRoot: this.workspace, ...(options.author === undefined ? {} : { author: options.author }), noExtensions: true }) : new HostClient(options.client, options.author);
  }
  /** Serialize read-modify-write operations across independent processes and clients. */
  async write<T>(run: () => Promise<T>): Promise<T> {
    const unlock = await writerLock(this.workspace, this.author);
    try { return await run(); } finally { await unlock(); }
  }
  /** Register the custom Knowledge type and compatible metadata through native schema writes. */
  async register(): Promise<void> {
    const settings = await readSettings(this.workspace);
    if (!settings.item_types.definitions.some(type => type.name === 'Knowledge')) await this.client.schemaAddType('Knowledge', { folder: 'knowledge', description: 'Durable agent knowledge', defaultStatus: 'open' });
    const fields = (await this.client.schemaListFields()).fields;
    for (const field of MEMORY_FIELDS) {
      const found = fields.find(entry => entry.key === field.name);
      if (found !== undefined && found.type !== field.type) throw new MemoryError('schema', 'Incompatible memory field definition', 'Restore the registered memory field type before retrying');
      if (found === undefined) await this.client.schemaAddField(field.name, { type: field.type, description: 'Typed agent memory metadata' });
    }
  }
  /** Read a certified full corpus and refuse duplicated or invalid memory identities. */
  async read(): Promise<Memory[]> {
    const corpus = certifyCompleteListResult(await this.client.listAllComplete({ includeBody: true }));
    const result: Memory[] = [];
    const seen = new Set<string>();
    for (const item of corpus.items) {
      if (item.type !== 'Knowledge' || item.memory_slug === undefined) continue;
      const key = slug(String(item.memory_slug));
      if (seen.has(key)) throw new MemoryError('duplicate', 'Memory slug is not unique', 'Repair duplicate slug metadata through audited pm updates');
      seen.add(key);
      const recalls = Number(item.memory_recalls ?? 0);
      if (!Number.isSafeInteger(recalls) || recalls < 0) throw new MemoryError('schema', 'Invalid memory recall counter', 'Restore a nonnegative integer counter through pm update');
      const verdict = item.memory_verdict ?? 'unknown';
      if (!['verified', 'stale', 'unknown'].includes(String(verdict))) throw new MemoryError('schema', 'Invalid memory verdict', 'Use verified, stale or unknown');
      result.push({ ...(item.memory_consent === undefined ? {} : { consent: String(item.memory_consent) }), validity: readWindow(item.memory_validity), id: item.id, slug: key, title: item.title, description: item.description, reason: String(item.memory_reason ?? ''), body: String(item.body), kind: kind(item.memory_kind), why: String(item.memory_why ?? ''), how: String(item.memory_how ?? ''), pinned: item.memory_pinned === true, source: String(item.memory_source ?? 'native:item'), updated: String(item.memory_changed_at ?? item.created_at), merge: String(item.memory_merge ?? ''), recalls, verdict: verdict as Memory['verdict'], status: item.status, tags: item.tags, path: String(item.memory_path ?? ''), original: String(item.memory_original ?? ''), edited: item.memory_edited === true, artifact: item.memory_artifact === true, links: (item.dependencies ?? []).map(edge => edge.id), supersedes: (item.dependencies ?? []).filter(edge => edge.kind === 'supersedes').map(edge => edge.id) });
    }
    return result;
  }
  /** Write registered fields through the contract-typed SDK mutation surface. */
  async fields(id: string, fields: Record<string, string | number | boolean>): Promise<void> {
    await this.client.run('update', { id, options: { ...metadata(fields), message: 'Update typed memory metadata' } });
  }
  /** Append a native relationship only when it is absent. */
  async link(source: string, target: string, kind = 'related'): Promise<void> {
    const item = (await this.client.get(source, { full: true })).item;
    if (!(item.dependencies ?? []).some(edge => edge.id === target && edge.kind === kind)) await this.client.update(source, { dep: [`id=${target},kind=${kind}`], message: 'Link shared agent context' });
  }
  /** Verify append-only history before destructive lifecycle consolidation or source export. */
  async history(id: string): Promise<number> {
    const entries = await readHistoryEntries(getHistoryPath(this.workspace, id), id);
    if (entries.length === 0 || !verifyHistoryEntries(entries).ok) throw new MemoryError('history', 'Memory history is missing or invalid', 'Inspect pm health and restore a valid tracker history');
    return entries.length;
  }
}

/** Convert registered schema keys to native option names for embedded clients without active extensions. */
export function metadata(fields: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [`memory_${key}`.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value]));
}
