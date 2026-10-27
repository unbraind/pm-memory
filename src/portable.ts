import { getHistoryPath, readHistoryEntries, readSettings, certifyCompleteListResult, resolveAuthorIdentity, canonicalDocument, DEPENDENCY_KIND_VALUES, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation, CommitItemMutationsOptions, Dependency } from '@unbrained/pm-cli/sdk';
import { recoverInput, applyImport, expectedTargets, validateImportPlan, previewImport, importIdentity } from './portable-plan.ts';
import { digest, kind, MemoryError, privacy, slug } from './core.ts';
import { readWindow, instant } from './guidance.ts';
import { metadata, Store } from './store.ts';
import type { GuidanceWindow, Harness, Memory, MemoryKind, MemoryOptions } from './types.ts';
import { portableFields, validFields, ownershipPatch, previousOwnership, resolvedRelationships, creationMetadata } from './portable-ownership.ts';
import type { PortableBaseline, OwnedTarget, PortableFields } from './portable-ownership.ts';
import { itemOrigin, validOrigin, originCatalog, selectOrigin, sameOrigin } from './portable-origin.ts';
import type { PortableOrigin } from './portable-origin.ts';

/** Reserved inventory file: keep it with the Markdown files through harness edits. */
export const POLICY_MANIFEST = 'pm-memory-policy.json';
const OWNED_SOURCES = ['native:item', 'portable:policy-v1', 'claude-code:relative-file', 'agents-md:relative-file', 'cursor:relative-file'];
/** Filter foreign records before interpreting any package-specific metadata. */
export function foreignMemories<T extends { type: string; memory_slug?: unknown; memory_source?: unknown }>(items: readonly T[]): T[] {
  return items.filter(item => item.memory_slug !== undefined && (item.type !== 'Knowledge' || typeof item.memory_source !== 'string' || !OWNED_SOURCES.includes(item.memory_source)));
}
/** Decode ownership and semantic values from one complete native SDK snapshot. */
export async function ownedMemories(store: Store, corpus: Awaited<ReturnType<Store['client']['listAllComplete']>>['items']) {
  const foreign = foreignMemories(corpus);
  // A foreign native record cannot acquire memory ownership by changing only its current tags.
  for (const item of corpus) if (item.type === 'Knowledge' && item.memory_slug !== undefined && !foreign.some(row => row.id === item.id)) {
    const born = await creationMetadata(store, item.id);
    if (born !== undefined && (born.type !== 'Knowledge' || typeof born.memory_slug !== 'string' || typeof born.memory_source !== 'string' || !OWNED_SOURCES.includes(born.memory_source))) foreign.push(item);
  }
  const allowed = new Set(corpus.filter(item => !foreign.some(record => record.id === item.id)).map(item => item.id));
  return { foreign, memories: await store.read(allowed, corpus) };
}
/** Typed native edge whose target is represented by a portable memory slug. */
export type PortableRelationship = Omit<Dependency, 'id'> & { slug: string };
/** Semantic memory projection that is independent of native ids and tracker bookkeeping. */
export interface PortableGuidance {
  /** Immutable lineage remains bound even when older tools omit ownership baselines. */
  origin?: PortableOrigin;
  /** Immutable owned-field and relationship baseline; absent only in older exports. */
  baseline?: PortableBaseline;
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
  /** Explicitly recreate a deleted or otherwise missing previously bound origin. */
  createMissingOrigins?: boolean;
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
/** Exact semantic field names that an export can explicitly report as unrepresentable. */
export type PortableLossyField = keyof PortableFields | 'slug' | 'artifact' | 'relationships' | 'relationships.author_source';
/** Export counts plus explicit receipts for references outside the active inventory. */
export interface PortableExportResult {
  /** Exact semantic fields the complete export cannot reproduce through native SDK writes. */
  lossy?: { slug: string; fields: PortableLossyField[]; reason: string }[];
  /** Number of published harness files. */
  exported: number;
  /** Original source files retained without rewriting their bytes. */
  byte_preserved: number;
  /** Native edges deliberately excluded from the portable local graph. */
  omitted_links?: { slug: string; target: string; kind: Dependency['kind']; reason: 'canceled' | 'artifact' | 'missing' }[];
  /** Unrecognized records excluded before package metadata is decoded. */
  skipped?: { slug: string; reason: string }[];
}
/** Original legacy provenance retained by the shared policy transaction path. */
export interface LegacyPortableSource {
  /** Raw source bytes encoded as base64. */
  original: string;
  /** Confined source path. */
  path: string;
  /** Non-fact harness index marker. */
  artifact: boolean;
  /** Original harness discriminator. */
  harness: Harness;
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
    const hasIdentity = value !== null && typeof value === 'object' && 'origin' in value;
    const hasBaseline = value !== null && typeof value === 'object' && 'baseline' in value;
    const row = shape(value, ['slug', 'title', 'description', 'kind', 'why', 'how', 'pinned', 'tags', 'path', 'updated', 'validity', 'renewals', 'snapshotHash', 'relationships', ...(hasBaseline ? ['baseline'] : []), ...(hasIdentity ? ['origin'] : [])]);
    for (const key of ['slug', 'title', 'description', 'why', 'how', 'path', 'updated']) if (typeof row[key] !== 'string') invalid();
    if (hasIdentity && !validOrigin(row.origin)) invalid();
    const key = slug(row.slug as string);
    instant(row.updated);
    if (typeof row.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.snapshotHash)) invalid();
    if (row.path !== `memories/${key}.md` || typeof row.pinned !== 'boolean' || !Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string') || !Array.isArray(row.renewals)) invalid();
    if (!Array.isArray(row.relationships)) invalid();
    /** Validate both current and immutable relationship inventories identically. */
    const parseRelationships = (values: unknown[]): PortableRelationship[] => values.map((value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
      const edge = value as PortableRelationship;
      if (Object.keys(edge).some(key => !['slug', 'kind', 'created_at', 'author', 'source_kind', 'author_source'].includes(key)) || !DEPENDENCY_KIND_VALUES.some(kind => kind === edge.kind)) invalid();
      slug(edge.slug);
      return edge;
    });
    const relationships = parseRelationships(row.relationships);
    let baseline: PortableBaseline | undefined;
    if (hasBaseline) {
      const hasId = row.baseline !== null && typeof row.baseline === 'object' && 'id' in row.baseline;
      const hasSlug = row.baseline !== null && typeof row.baseline === 'object' && 'slug' in row.baseline;
      const hasOrigin = row.baseline !== null && typeof row.baseline === 'object' && 'origin' in row.baseline;
      const fields = shape(row.baseline, ['fields', 'relationships', ...(hasId ? ['id'] : []), ...(hasSlug ? ['slug'] : []), ...(hasOrigin ? ['origin'] : [])]);
      if (!validFields(fields.fields) || !Array.isArray(fields.relationships)) invalid();
      if (hasId && (typeof fields.id !== 'string' || fields.id.length === 0 || /[\r\n/\\\0]/.test(fields.id))) invalid();
      if (hasSlug && fields.slug !== key) throw new MemoryError('format', 'Portable identities cannot be renamed by editing the manifest', 'Restore the exported slug and path; rename native guidance explicitly, then export again');
      if (hasOrigin && !validOrigin(fields.origin)) invalid();
      baseline = { ...(hasId ? { id: fields.id as string } : {}), ...(hasSlug ? { slug: key } : {}), ...(hasOrigin ? { origin: fields.origin as NonNullable<PortableBaseline['origin']> } : {}), fields: fields.fields, relationships: parseRelationships(fields.relationships) };
    }
    if (hasIdentity && baseline?.origin !== undefined && !sameOrigin(row.origin as PortableOrigin, baseline.origin)) invalid();
    const renewals = row.renewals.map(window);
    for (const [index, entry] of renewals.entries()) if (entry.revision !== index + 1 || (index > 0 && entry.recordedAt < renewals[index - 1].recordedAt)) invalid();
    const validity = row.validity === null ? null : window(row.validity);
    if (!equal(validity, renewals.at(-1) ?? null)) invalid();
    return { ...(hasIdentity ? { origin: row.origin as PortableOrigin } : {}), ...(baseline === undefined ? {} : { baseline }), relationships, snapshotHash: row.snapshotHash, slug: key, title: row.title as string, description: row.description as string, kind: kind(row.kind), why: row.why as string, how: row.how as string, pinned: row.pinned, tags: row.tags as string[], path: row.path, updated: row.updated as string, validity, renewals };
  });
  if (new Set(guidance.map(row => row.slug)).size !== guidance.length) invalid();
  const origins = guidance.flatMap(row => { const origin = guidanceOrigin(row); return origin === undefined ? [] : [JSON.stringify([origin.tracker, origin.id, origin.creation])]; });
  if (new Set(origins).size !== origins.length) throw new MemoryError('origin_missing', 'Duplicate immutable origins in one inventory', 'Delete unintended duplicate native copies explicitly, then export again; aliases cannot select a lineage');
  return { version: 1, format: 'pm-memory-policy', harness: manifest.harness as PortablePolicyManifest['harness'], guidance };
}
/** Recover every renewal from verified native history, including imported ancestry. */
export async function policyRecord(store: Store, item: Memory, memories?: readonly Memory[], origins?: Awaited<ReturnType<typeof originCatalog>>): Promise<PortableGuidance> {
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
  row.origin = await itemOrigin(store, item.id, origins);
  row.baseline = { id: item.id, slug: item.slug, origin: row.origin, fields: portableFields(row, item.body), relationships };
  return parsePolicy({ version: 1, format: 'pm-memory-policy', harness: 'agents-md', guidance: [row] }).guidance[0];
}
/** Retain local typed edges; excluded targets are reported in the export receipt. */
export function portableRelationships(item: Memory, memories: readonly Memory[]): PortableRelationship[] {
  return item.relationships.flatMap(({ id, ...edge }) => {
    const target = memories.find(memory => memory.id === id);
    return target === undefined || target.status === 'canceled' || target.artifact ? [] : [{ slug: target.slug, ...edge }];
  });
}
/** Normalize semantic provenance with the same SDK canonical document path used by storage. */
export function canonicalProvenance(row: Pick<PortableGuidance, 'title' | 'description' | 'kind' | 'why' | 'how' | 'pinned' | 'tags'>, body: string, relationships: PortableRelationship[]) {
  return canonicalDocument({ metadata: { id: 'portable-provenance', title: row.title, description: row.description, type: 'Knowledge', status: 'open', priority: 2, tags: row.tags, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', memory_kind: row.kind, memory_why: row.why, memory_how: row.how, memory_pinned: row.pinned, dependencies: relationships.map(({ slug, ...edge }) => ({ id: slug, ...edge })) }, body });
}
/** Bind exported snapshots to SDK-canonical content and relationship topology. */
export function snapshotDigest(row: Parameters<typeof canonicalProvenance>[0], body: string, relationships: PortableRelationship[]): string { return digest(JSON.stringify(canonicalProvenance(row, body, relationships))); }
/** Close every refusal transitively over the portable graph, retaining the root reason. */
export function closeSkips(rows: readonly Pick<PortableGuidance, 'slug' | 'relationships'>[], skipped: Map<string, string>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (!skipped.has(row.slug)) {
      const reason = row.relationships.map(edge => skipped.get(edge.slug)).find(reason => reason !== undefined);
      if (reason !== undefined) { skipped.set(row.slug, reason); changed = true; }
    }
  }
}
/** Resolve one validated immutable lineage, independently of optional ownership baselines. */
export function guidanceOrigin(row: Pick<PortableGuidance, 'origin' | 'baseline'>): PortableOrigin | undefined { return row.origin ?? row.baseline?.origin; }
/** Reserve planned identities without adopting an unrelated native record. */
export function skipOccupiedIdentities(rows: readonly PortableGuidance[], existing: ReadonlySet<string>, occupied: ReadonlySet<string>, ids: ReadonlyMap<string, string>, skipped: Map<string, string>): void {
  for (const row of rows) if (!existing.has(row.slug) && occupied.has(ids.get(row.slug)!)) skipped.set(row.slug, 'Foreign record occupies the reserved import id');
}
/** Bind a file to its inventory row without embedding unbounded advice in the index. */
export function policyBody(row: PortableGuidance, body: string): Buffer { return Buffer.from(`<!-- pm-memory-policy:v1 ${row.slug}; policy ${digest(JSON.stringify([row.validity, row.renewals, row.pinned, ...(row.baseline === undefined ? [] : [row.baseline]), ...(row.origin === undefined ? [] : [row.origin])]))}; keep ${POLICY_MANIFEST} -->\n${body}`); }
/** Parse only files owned by the manifest; foreign adjacent records are skipped with a reason. */
export async function importPolicy(input: readonly { path: string; bytes: Buffer }[], options: PortableImportOptions, legacy?: ReadonlyMap<string, LegacyPortableSource>): Promise<PortableImportResult> {
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
    const recovered = await recoverInput(store, inputHash, options);
    if (recovered !== undefined) return recovered;
    const corpus = certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
    const { foreign, memories: current } = await ownedMemories(store, corpus);
    await options.onStep?.('read');
    const settings = await readSettings(store.workspace);
    const occupied = new Set(corpus.map(item => item.id));
    const identity = await importIdentity(store, inputHash); const { transactionId } = identity;
    const selected = new Map<string, Memory>(); const originSkips = new Map<string, string>();
    const catalog = await originCatalog(store, new Set(corpus.map(item => item.id)));
    for (const row of manifest.guidance) {
      const origin = guidanceOrigin(row);
      if (origin === undefined) {
        if (!options.createMissingOrigins) throw new MemoryError('origin_missing', 'Export has no immutable origin binding', 'Export again from the source tracker, or use memory import --create for an explicit new origin');
      } else {
        const foreignOrigin = catalog.creators.some(entry => sameOrigin(entry.origin, origin) && corpus.some(item => item.id === entry.id) && !current.some(item => item.id === entry.id));
        if (foreignOrigin) { originSkips.set(row.slug, 'Foreign record owns the exported origin'); continue; }
        const target = selectOrigin(origin, current, catalog, options.createMissingOrigins === true);
        if (target !== undefined) selected.set(row.slug, target);
      }
      if (!selected.has(row.slug) && current.some(item => item.slug === row.slug)) throw new MemoryError('origin_missing', 'A display alias is occupied by a different origin', 'Retain the original item or rename the unrelated alias before an explicit --create');
      if (!selected.has(row.slug) && foreign.some(item => item.memory_slug === row.slug)) originSkips.set(row.slug, 'Foreign record has no package-owned source');
    }
    const ids = new Map(manifest.guidance.map(row => [row.slug, selected.get(row.slug)?.id ?? `${settings.id_prefix}${digest(`${transactionId}:${row.slug}`).slice(0, 24)}`]));
    const mutations: BulkItemMutation[] = [];
    const ownership: OwnedTarget[] = [];
    const baselineIds = new Map([...current.map(item => [item.slug, item.id] as const), ...ids]);
    const skipped = originSkips;
    skipOccupiedIdentities(manifest.guidance, new Set(selected.keys()), occupied, ids, skipped);
    closeSkips(manifest.guidance, skipped);
    const decisions = new Map<string, 'imported' | 'updated' | 'unchanged'>();
    const result: PortableImportResult = { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: foreign.filter(item => !manifest.guidance.some(row => row.slug === item.memory_slug && originSkips.has(row.slug))).map(item => ({ slug: item.id, reason: 'Foreign record has no package-owned source' })) };
    for (const file of input) if (file.path !== POLICY_MANIFEST && file.path !== 'AGENTS.md' && file.path !== 'MEMORY.md' && !manifest.guidance.some(row => row.path === file.path)) result.skipped.push({ slug: file.path, reason: 'Foreign file absent from the policy inventory' });
    for (const [index, row] of manifest.guidance.entries()) {
      if (skipped.has(row.slug)) continue;
      const previous = selected.get(row.slug);
      const id = ids.get(row.slug)!;
      const body = bodies[index];
      let update: ReturnType<typeof ownershipPatch> | undefined;
      if (previous !== undefined) {
        if (previous.slug !== row.slug) result.skipped.push({ slug: row.slug, reason: `Native identity retained as ${previous.slug}` });
        const prior = await policyRecord(store, previous, current, catalog);
        if (!equal(prior.validity, row.validity) || JSON.stringify(prior.renewals) !== JSON.stringify(row.renewals)) invalid();
        update = ownershipPatch(previous, row, body, ids, baselineIds, await previousOwnership(store, previous, baselineIds));
        if (update.conflicts.length > 0) {
          const reason = `Independently edited native content retained: ${update.conflicts.join(', ')}`;
          if (Object.keys(update.options).length === 0) { skipped.set(row.slug, reason); continue; }
          result.skipped.push({ slug: row.slug, reason });
        }
        if (Object.keys(update.options).length === 0) { decisions.set(row.slug, 'unchanged'); continue; }
        decisions.set(row.slug, 'updated');
      } else decisions.set(row.slug, 'imported');
      const wire = legacy?.get(row.slug);
      const fields = { slug: row.slug, kind: row.kind, why: row.why, how: row.how, pinned: row.pinned, source: wire === undefined ? 'portable:policy-v1' : `${wire.harness}:relative-file`, original: wire?.original ?? Buffer.from(JSON.stringify([row, body])).toString('base64'), path: wire?.path ?? row.path, edited: false, artifact: wire?.artifact ?? false, changed_at: row.updated, renewals: JSON.stringify(row.renewals), ...(guidanceOrigin(row) === undefined ? {} : { origin: JSON.stringify(guidanceOrigin(row)) }), ...(row.validity === null ? {} : { validity: JSON.stringify(row.validity) }) };
      // Stable create ids and payloads let the SDK resume an interrupted batch without duplicates.
      const creating = previous === undefined;
      const relationships = resolvedRelationships(row.relationships, ids);
      ownership.push({ ...(update?.ownership ?? { id, fields: portableFields(row, body), relationships, graph: relationships }), ...(wire === undefined ? {} : { source: { original: wire.original } }) });
      mutations.push({ op: creating ? 'create' : 'update', id: previous?.id ?? id, ...(creating ? { unique: { key: 'memory_slug', value: row.slug } } : { match: { key: 'updated_at', value: corpus.find(item => item.id === previous.id)!.updated_at } }), options: creating ? { title: row.title, description: row.description, body, type: 'Knowledge', allowDuplicate: true, allowUnresolvedDeps: true, tags: row.tags.join(','), ...itemDocumentToMutationOptions(JSON.stringify({ dependencies: relationships }), 'create'), ...metadata(fields) } : update!.options });
    }
    closeSkips(manifest.guidance, skipped);
    for (const [slug, reason] of skipped) result.skipped.push({ slug, reason });
    const admitted = manifest.guidance.filter(row => !skipped.has(row.slug));
    const planned = mutations.filter(mutation => admitted.some(row => ids.get(row.slug) === mutation.id));
    for (const row of admitted) result[decisions.get(row.slug)!]++;
    if (planned.length === 0) return result;
    const expected = await expectedTargets(store, admitted.map(row => ({ id: ids.get(row.slug)!, slug: selected.get(row.slug)?.slug ?? row.slug, origin: guidanceOrigin(row) })), corpus);
    const plan = { identityVersion: 1 as const, pmRoot: store.workspace, author: resolveAuthorIdentity(options.author, settings.author_default).author, ...identity, mutations: planned, ownership: ownership.filter(target => planned.some(row => row.id === target.id)), input: inputHash, result, expected, initial: expected, members: admitted.map(row => ids.get(row.slug)!) };
    await validateImportPlan(store, plan, options.onStep);
    await store.register(options.onStep);
    await previewImport(store, plan, options.onStep);
    await options.onStep?.('previewed');
    return applyImport(store, plan, options);
  });
}
