import { getHistoryPath, readHistoryEntries, readSettings, hashHistoryStream, previewItemMutations, certifyCompleteListResult, resolveAuthorIdentity, canonicalDocument, DEPENDENCY_KIND_VALUES, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation, CommitItemMutationsOptions, Dependency } from '@unbrained/pm-cli/sdk';
import { pendingImport, applyImport, expectedTargets, validateImportPlan, planError, foreignIntentResult } from './portable-plan.ts';
import { digest, kind, MemoryError, privacy, slug } from './core.ts';
import { readWindow, instant } from './guidance.ts';
import { metadata, Store } from './store.ts';
import type { GuidanceWindow, Harness, Memory, MemoryKind, MemoryOptions } from './types.ts';

/** Reserved inventory file: keep it with the Markdown files through harness edits. */
export const POLICY_MANIFEST = 'pm-memory-policy.json';
/** Typed native edge whose target is represented by a portable memory slug. */
export type PortableRelationship = Omit<Dependency, 'id'> & { slug: string };
/** Semantic memory projection that is independent of native ids and tracker bookkeeping. */
export interface PortableGuidance {
  /** Stable interoperable guidance identity. */
  slug: string;
  /** Human-facing heading. */
  title: string;
  /** Retrieval hook. */
  description: string;
  /** Semantic class. */
  kind: MemoryKind;
  /** Rationale. */
  why: string;
  /** Application instructions. */
  how: string;
  /** Standing-guidance flag; false remains false on import. */
  pinned: boolean;
  /** Search terms bound by renewal evidence. */
  tags: string[];
  /** Complete native relationship kinds and provenance, with portable targets. */
  relationships: PortableRelationship[];
  /** Digest of the exported semantic snapshot, independent of later harness body edits. */
  snapshotHash: string;
  /** Canonical body file; editable without changing the evidence hash. */
  path: string;
  /** Last semantic edit time retained across trackers. */
  updated: string;
  /** Latest authored window, or null for explicitly unbounded legacy guidance. */
  validity: GuidanceWindow | null;
  /** Complete ordered renewal ancestry, including the latest window. */
  renewals: GuidanceWindow[];
}
/** Portable inventory with explicit format and policy semantics. */
export interface PortablePolicyManifest {
  /** Version of this exact contract. */
  version: 1;
  /** Stable format discriminator. */
  format: 'pm-memory-policy';
  /** Harness that owns the adjacent Markdown files. */
  harness: Exclude<Harness, 'cursor'>;
  /** Complete semantic records; bodies live in the referenced files. */
  guidance: PortableGuidance[];
}
/** Deterministic transition observer for import crash and contention validation. */
export interface PortableImportOptions extends MemoryOptions {
  /** Source harness, validated by the normal transfer entry point. */
  from: Harness;
  /** Explicit email opt-in; secrets remain forbidden. */
  allowEmail?: boolean;
  /** Package preparation and publication boundaries for deterministic diagnostics. */
  onStep?: (step: string) => void | Promise<void>;
  /** SDK transaction transitions; throwing its interruption error simulates a crash. */
  onTransition?: CommitItemMutationsOptions['onTransition'];
}
/** Counts and safe reasons, with no full guidance echoed to agent output. */
export interface PortableImportResult {
  /** Newly created records. */
  imported: number;
  /** Revised package-owned records. */
  updated: number;
  /** Already identical records, including peer-completed work. */
  unchanged: number;
  /** Wiki-link resolution is not required by policy body files. */
  unresolved_links: number;
  /** Foreign records left untouched. */
  skipped: { slug: string; reason: string }[];
}
/** Refuse ambiguity without echoing source content. */
function invalid(): never {
  throw new MemoryError('validity', 'Invalid or expanded portable policy window', 'Restore the exported manifest and all body files; use memory renew with evidence to change bounds or renewal history');
}
/** Require an exact object shape so unknown future policy fields cannot silently disappear. */
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) invalid();
  return value as Record<string, unknown>;
}
/** Parse canonical windows without permitting discarded or coerced metadata. */
function window(value: unknown): GuidanceWindow {
  shape(value, ['from', 'until', 'evidence', 'recordedAt', 'contentHash', 'revision']);
  try { return readWindow(JSON.stringify(value))!; } catch { return invalid(); }
}
/** Compare policy values independently of JSON property order. */
function equal(a: GuidanceWindow | null, b: GuidanceWindow | null): boolean { return JSON.stringify(a) === JSON.stringify(b); }
/** Validate the full inventory before any schema, item or history write. */
export function parsePolicy(value: unknown): PortablePolicyManifest {
  const manifest = shape(value, ['version', 'format', 'harness', 'guidance']);
  if (manifest.version !== 1 || manifest.format !== 'pm-memory-policy' || !['claude-code', 'agents-md'].includes(String(manifest.harness)) || !Array.isArray(manifest.guidance)) invalid();
  const guidance = manifest.guidance.map((value: unknown): PortableGuidance => {
    const row = shape(value, ['slug', 'title', 'description', 'kind', 'why', 'how', 'pinned', 'tags', 'path', 'updated', 'validity', 'renewals', 'snapshotHash', 'relationships']);
    for (const key of ['slug', 'title', 'description', 'why', 'how', 'path', 'updated']) if (typeof row[key] !== 'string') invalid();
    const key = slug(row.slug as string);
    instant(row.updated);
    if (typeof row.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.snapshotHash)) invalid();
    if (row.path !== `memories/${key}.md` || typeof row.pinned !== 'boolean' || !Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string') || !Array.isArray(row.renewals)) invalid();
    if (!Array.isArray(row.relationships)) invalid();
    const relationships = row.relationships.map((value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
      const edge = value as PortableRelationship;
      if (Object.keys(edge).some(key => !['slug', 'kind', 'created_at', 'author', 'source_kind', 'author_source'].includes(key)) || !DEPENDENCY_KIND_VALUES.some(kind => kind === edge.kind)) invalid();
      slug(edge.slug);
      return edge;
    });
    const renewals = row.renewals.map(window);
    for (const [index, entry] of renewals.entries()) if (entry.revision !== index + 1 || (index > 0 && entry.recordedAt < renewals[index - 1].recordedAt)) invalid();
    const validity = row.validity === null ? null : window(row.validity);
    if (!equal(validity, renewals.at(-1) ?? null)) invalid();
    return { relationships, snapshotHash: row.snapshotHash, slug: key, title: row.title as string, description: row.description as string, kind: kind(row.kind), why: row.why as string, how: row.how as string, pinned: row.pinned, tags: row.tags as string[], path: row.path, updated: row.updated as string, validity, renewals };
  });
  if (new Set(guidance.map(row => row.slug)).size !== guidance.length) invalid();
  return { version: 1, format: 'pm-memory-policy', harness: manifest.harness as PortablePolicyManifest['harness'], guidance };
}
/** Recover every renewal from verified native history, including imported ancestry. */
export async function policyRecord(store: Store, item: Memory, memories?: readonly Memory[]): Promise<PortableGuidance> {
  await store.history(item.id);
  const revisions = new Map<number, GuidanceWindow>();
  /** Refuse conflicting historical claims rather than replacing prior evidence. */
  const record = (renewal: GuidanceWindow): void => {
    const prior = revisions.get(renewal.revision);
    if (prior !== undefined && !equal(prior, renewal)) invalid();
    revisions.set(renewal.revision, renewal);
  };
  for (const entry of await readHistoryEntries(getHistoryPath(store.workspace, item.id), item.id)) for (const patch of entry.patch) {
    if (patch.op !== 'add' && patch.op !== 'replace') continue;
    if (patch.path === '/metadata/memory_renewals') for (const value of JSON.parse(String(patch.value)) as unknown[]) { const renewal = window(value); record(renewal); }
    if (patch.path === '/metadata/memory_validity') { const renewal = readWindow(patch.value)!; record(renewal); }
  }
  const corpus = memories ?? await store.read();
  const relationships = portableRelationships(item, corpus);
  const row: PortableGuidance = { relationships, snapshotHash: snapshotDigest(item, item.body, relationships), slug: item.slug, title: item.title, description: item.description, kind: item.kind, why: item.why, how: item.how, pinned: item.pinned, tags: item.tags, path: `memories/${item.slug}.md`, updated: item.updated, validity: item.validity ?? null, renewals: [...revisions.values()].sort((a, b) => a.revision - b.revision) };
  return parsePolicy({ version: 1, format: 'pm-memory-policy', harness: 'agents-md', guidance: [row] }).guidance[0];
}
/** Retain every typed edge, refusing an unavailable target instead of silently dropping it. */
export function portableRelationships(item: Memory, memories: readonly Memory[]): PortableRelationship[] {
  return item.relationships.map(({ id, ...edge }) => {
    const target = memories.find(memory => memory.id === id);
    if (target === undefined) throw new MemoryError('relationship', 'Portable relationship target is unavailable', 'Include every linked memory in the export; retain non-memory relationships in the native tracker');
    return { slug: target.slug, ...edge };
  });
}
/** Normalize semantic provenance with the same SDK canonical document path used by storage. */
export function canonicalProvenance(row: Pick<PortableGuidance, 'title' | 'description' | 'kind' | 'why' | 'how' | 'pinned' | 'tags'>, body: string, relationships: PortableRelationship[]) {
  return canonicalDocument({ metadata: { id: 'portable-provenance', title: row.title, description: row.description, type: 'Knowledge', status: 'open', priority: 2, tags: row.tags, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', memory_kind: row.kind, memory_why: row.why, memory_how: row.how, memory_pinned: row.pinned, dependencies: relationships.map(({ slug, ...edge }) => ({ id: slug, ...edge })) }, body });
}
/** Bind exported snapshots to SDK-canonical content and relationship topology. */
export function snapshotDigest(row: Parameters<typeof canonicalProvenance>[0], body: string, relationships: PortableRelationship[]): string { return digest(JSON.stringify(canonicalProvenance(row, body, relationships))); }
/** Compare current and desired values through SDK storage and mutation projections. */
export function mutationDigest(row: Parameters<typeof canonicalProvenance>[0], body: string, relationships: Dependency[]): string {
  const document = canonicalProvenance(row, body, relationships.map(({ id, ...edge }) => ({ slug: id, ...edge })));
  const { dependencies, ...metadata } = document.metadata;
  return digest(JSON.stringify([metadata, document.body, itemDocumentToMutationOptions(JSON.stringify({ dependencies }), 'update')]));
}
/** Close every refusal transitively over the portable graph, retaining the root reason. */
export function closeSkips(rows: readonly PortableGuidance[], skipped: Map<string, string>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (!skipped.has(row.slug)) {
      const reason = row.relationships.map(edge => skipped.get(edge.slug)).find(reason => reason !== undefined);
      if (reason !== undefined) { skipped.set(row.slug, reason); changed = true; }
    }
  }
}
/** Bind a file to its inventory row without embedding unbounded advice in the index. */
export function policyBody(row: PortableGuidance, body: string): Buffer { return Buffer.from(`<!-- pm-memory-policy:v1 ${row.slug}; policy ${digest(JSON.stringify([row.validity, row.renewals, row.pinned]))}; keep ${POLICY_MANIFEST} -->\n${body}`); }
/** Parse only files owned by the manifest; foreign adjacent records are skipped with a reason. */
export async function importPolicy(input: readonly { path: string; bytes: Buffer }[], options: PortableImportOptions): Promise<PortableImportResult> {
  let value: unknown;
  try { value = JSON.parse(input.find(file => file.path === POLICY_MANIFEST)!.bytes.toString('utf8')); } catch { return invalid(); }
  const manifest = parsePolicy(value);
  if (manifest.harness !== options.from) invalid();
  const bodies = manifest.guidance.map(row => {
    const file = input.find(file => file.path === row.path);
    if (file === undefined) return invalid();
    const content = file.bytes.toString('utf8'); const prefix = policyBody(row, '').toString('utf8');
    if (!Buffer.from(content).equals(file.bytes) || !content.startsWith(prefix)) return invalid();
    privacy(content, options.allowEmail);
    return content.slice(prefix.length);
  });
  privacy(JSON.stringify(manifest), options.allowEmail);
  for (const row of manifest.guidance) if (row.relationships.some(edge => !manifest.guidance.some(target => target.slug === edge.slug))) invalid();
  const inputHash = digest(JSON.stringify([manifest, bodies]));
  await options.onStep?.('validated');
  const store = new Store(options);
  return store.write(async () => {
    const pending = await pendingImport(store, options.onStep);
    if (pending === 'foreign') return foreignIntentResult();
    if (pending !== undefined) {
      if (pending.input !== inputHash) throw new MemoryError('conflict', 'Another portable import needs recovery', 'Rerun the interrupted input before importing a different manifest');
      return applyImport(store, pending, options);
    }
    const corpus = certifyCompleteListResult(await store.client.listAllComplete()).items;
    const sources = ['native:item', 'portable:policy-v1', 'claude-code:relative-file', 'agents-md:relative-file', 'cursor:relative-file'];
    const foreign = corpus.filter(item => item.type === 'Knowledge' && item.memory_slug !== undefined && !sources.includes(String(item.memory_source)));
    const current = await store.read(new Set(corpus.filter(item => !foreign.some(record => record.id === item.id)).map(item => item.id)));
    await options.onStep?.('read');
    const settings = await readSettings(store.workspace);
    const occupied = new Set(corpus.map(item => item.id));
    const revisions = await Promise.all(current.map(async item => [item.id, await store.history(item.id), hashHistoryStream(await readHistoryEntries(getHistoryPath(store.workspace, item.id), item.id))]));
    const transactionId = `memory-policy-${digest(JSON.stringify([inputHash, revisions.sort()])).slice(0, 40)}`;
    const ids = new Map(manifest.guidance.map(row => [row.slug, current.find(item => item.slug === row.slug)?.id ?? `${settings.id_prefix}${digest(`${transactionId}:${row.slug}`).slice(0, 24)}`]));
    const mutations: BulkItemMutation[] = [];
    const skipped = new Map(manifest.guidance.filter(row => foreign.some(item => item.memory_slug === row.slug)).map(row => [row.slug, 'Foreign Knowledge record has no package-owned source']));
    closeSkips(manifest.guidance, skipped);
    const decisions = new Map<string, 'imported' | 'updated' | 'unchanged'>();
    const result: PortableImportResult = { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: foreign.filter(item => !manifest.guidance.some(row => row.slug === item.memory_slug)).map(item => ({ slug: item.id, reason: 'Foreign Knowledge record has no package-owned source' })) };
    for (const file of input) if (file.path !== POLICY_MANIFEST && file.path !== 'AGENTS.md' && file.path !== 'MEMORY.md' && !manifest.guidance.some(row => row.path === file.path)) result.skipped.push({ slug: file.path, reason: 'Foreign file absent from the policy inventory' });
    for (const [index, row] of manifest.guidance.entries()) {
      if (skipped.has(row.slug)) continue;
      const previous = current.find(item => item.slug === row.slug);
      const id = ids.get(row.slug)!;
      const body = bodies[index];
      if (previous === undefined && occupied.has(id)) { skipped.set(row.slug, 'Foreign record occupies the deterministic import id'); continue; }
      if (previous !== undefined) {
        if (previous.source !== 'portable:policy-v1') {
          if (snapshotDigest(previous, previous.body, portableRelationships(previous, current)) !== row.snapshotHash || previous.pinned !== row.pinned) { skipped.set(row.slug, 'Foreign native content differs from the exported guidance'); continue; }
        } else {
          try {
            const parsed: unknown = JSON.parse(Buffer.from(previous.original, 'base64').toString('utf8'));
            if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== 'string') invalid();
            parsePolicy({ version: 1, format: 'pm-memory-policy', harness: options.from, guidance: [parsed[0]] });
          } catch { skipped.set(row.slug, 'Foreign or unreadable import provenance'); continue; }
          const sameInput = mutationDigest(previous, previous.body, previous.relationships) === mutationDigest(row, body, row.relationships.map(({ slug, ...edge }) => ({ id: ids.get(slug)!, ...edge })));
          const last = sameInput ? (await readHistoryEntries(getHistoryPath(store.workspace, previous.id), previous.id)).at(-1) : undefined;
          const ownProgress = last?.op === 'create' || last?.message?.startsWith('bulk-item-transaction memory-policy-');
          if (!ownProgress && snapshotDigest(previous, previous.body, portableRelationships(previous, current)) !== previous.importSnapshot && snapshotDigest(previous, previous.body, portableRelationships(previous, current)) !== row.snapshotHash) { skipped.set(row.slug, 'Independently edited native content'); continue; }
        }
        const prior = await policyRecord(store, previous, current);
        if (!equal(prior.validity, row.validity) || JSON.stringify(prior.renewals) !== JSON.stringify(row.renewals)) invalid();
        if (mutationDigest(previous, previous.body, previous.relationships) === mutationDigest(row, body, row.relationships.map(({ slug, ...edge }) => ({ id: ids.get(slug)!, ...edge })))) {
          decisions.set(row.slug, 'unchanged');
          if (previous.importSnapshot === snapshotDigest(previous, previous.body, portableRelationships(previous, current))) continue;
        } else decisions.set(row.slug, 'updated');
      } else decisions.set(row.slug, 'imported');
      const fields = { slug: row.slug, kind: row.kind, why: row.why, how: row.how, pinned: row.pinned, source: 'portable:policy-v1', original: Buffer.from(JSON.stringify([row, body])).toString('base64'), path: row.path, edited: false, artifact: false, changed_at: row.updated, renewals: JSON.stringify(row.renewals), ...(row.validity === null ? {} : { validity: JSON.stringify(row.validity) }) };
      // Stable create ids and payloads let the SDK resume an interrupted batch without duplicates.
      const creating = previous === undefined;
      mutations.push({ op: creating ? 'create' : 'update', id: previous?.id ?? id, ...(creating ? { unique: { key: 'memory_slug', value: row.slug } } : { match: { key: 'updated_at', value: corpus.find(item => item.id === previous.id)!.updated_at } }), options: { title: row.title, description: row.description, body, ...(creating ? { type: 'Knowledge', allowDuplicate: true, allowUnresolvedDeps: true } : {}), tags: row.tags.join(','), ...(creating ? {} : row.relationships.length === 0 ? { clearDeps: true } : { replaceDeps: true }), ...itemDocumentToMutationOptions(JSON.stringify({ dependencies: row.relationships.map(({ slug, ...edge }) => ({ id: ids.get(slug)!, ...edge })) }), creating ? 'create' : 'update'), ...metadata(fields) } });
    }
    closeSkips(manifest.guidance, skipped);
    for (const [slug, reason] of skipped) result.skipped.push({ slug, reason });
    const admitted = manifest.guidance.filter(row => !skipped.has(row.slug));
    const planned = mutations.filter(mutation => admitted.some(row => ids.get(row.slug) === mutation.id));
    for (const row of admitted) result[decisions.get(row.slug)!]++;
    if (planned.length === 0) return result;
    const expected = await expectedTargets(store, admitted.map(row => ({ id: ids.get(row.slug)!, slug: row.slug })));
    const plan = { pmRoot: store.workspace, author: resolveAuthorIdentity(options.author, settings.author_default).author, transactionId, mutations: planned, input: inputHash, result, expected, members: admitted.map(row => ids.get(row.slug)!) };
    await validateImportPlan(store, plan);
    await store.register(options.onStep);
    try { await previewItemMutations(plan); } catch (error) { return planError(error); }
    await options.onStep?.('previewed');
    return applyImport(store, plan, options);
  });
}
