import { contentRevision } from './content.ts';
import { isCanceled } from './lifecycle.ts';
import { validRelationship } from './portable-relationships.ts';
import { getHistoryPath, readHistoryEntries, readSettings, certifyCompleteListResult, resolveAuthorIdentity, canonicalDocument, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation, CommitItemMutationsOptions, Dependency } from '@unbrained/pm-cli/sdk';
import { recoverInput, applyImport, expectedTargets, validateImportPlan, previewImport, importIdentity } from './portable-plan.ts';
import { importConflict } from './portable-write.ts';
import { digest, kind, MemoryError, privacy, slug } from './core.ts';
import { readWindow, instant } from './guidance.ts';
import { metadata, Store } from './store.ts';
import type { GuidanceWindow, Harness, HarnessDocument, Memory, MemoryKind, MemoryOptions } from './types.ts';
import { readDocument, documentPatch, encodeDocument, sourceDocument, frontmatter } from './portable-source.ts';
import { portableFields, validFields, ownershipPatch, previousOwnership, resolvedRelationships, creationMetadata, legacyBirth, recordedCreation, projectSourceFields, projectSourceLinks, unsetSourceFields, exportedSource } from './portable-ownership.ts';
import type { PortableBaseline, OwnedTarget, PortableFields } from './portable-ownership.ts';
import { itemOrigin, validOrigin, originCatalog, selectOrigin, sameOrigin, creatorMatchesOrigin } from './portable-origin.ts';
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
  for (const item of corpus) if (item.memory_slug !== undefined && ((item.memory_document !== undefined && readDocument(item.memory_document) === undefined) || (item.memory_policy_body !== undefined && readDocument(item.memory_policy_body)?.format !== 'policy')) && !foreign.some(row => row.id === item.id)) foreign.push(item);
  // A foreign native record cannot acquire memory ownership by changing only its current tags.
  for (const item of corpus) if (item.type === 'Knowledge' && item.memory_slug !== undefined && !foreign.some(row => row.id === item.id)) {
    const born = await creationMetadata(store, item.id);
    if (born !== undefined && (born.type !== 'Knowledge' || typeof born.memory_slug !== 'string' || typeof born.memory_source !== 'string' || !OWNED_SOURCES.includes(born.memory_source) || (born.memory_source.endsWith(':relative-file') && await legacyBirth(store, item.id, born) === undefined) || !await recordedCreation(store, item.id))) foreign.push(item);
  }
  const allowed = new Set(corpus.filter(item => !foreign.some(record => record.id === item.id)).map(item => item.id));
  return { foreign, memories: await store.read(allowed, corpus) };
}
/** Typed native edge whose target is represented by a portable memory slug. */
export type PortableRelationship = Omit<Dependency, 'id'> & { slug: string };
/** Semantic memory projection that is independent of native ids and tracker bookkeeping. */
export interface PortableGuidance {
  /** Complete source bytes, including unrecognized frontmatter, carried across formats. */
  document?: HarnessDocument;
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
  /** Preparation/publication diagnostics; write-guard is the last pre-write check, not an atomic SDK precondition. */
  onStep?: (step: string) => void | Promise<void>;
  /** SDK transaction transitions; throwing its interruption error simulates a crash. */
  onTransition?: CommitItemMutationsOptions['onTransition'];
}
/** Typed per-item conflict; base/current contain safe fingerprints of SDK-normalized values. */
export interface ImportConflict {
  /** Stable machine-readable skip class. */
  code: 'import_conflict';
  /** Immutable target id, including for dependent skips. */
  item: string;
  /** Fields whose saved bases no longer match. */
  fields: string[];
  /** SDK-normalized saved-base fingerprints. */
  base: Record<string, string>;
  /** SDK-normalized current-value fingerprints. */
  current: Record<string, string>;
  /** Explicit reconciliation action. */
  remedy: string;
  /** Root target whose conflict caused this dependent item to be skipped. */
  dependency?: string;
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
  skipped: { slug: string; reason: string; conflict?: ImportConflict }[];
}
/** Exact semantic field names that an export can explicitly report as unrepresentable. */
export type PortableLossyField = keyof PortableFields | 'slug' | 'artifact' | 'document' | 'relationships' | 'relationships.author_source';
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
  /** Preserve a native source snapshot when only its projected native body changed. */
  document?: HarnessDocument;
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
    const hasDocument = value !== null && typeof value === 'object' && 'document' in value;
    const row = shape(value, ['slug', 'title', 'description', 'kind', 'why', 'how', 'pinned', 'tags', 'path', 'updated', 'validity', 'renewals', 'snapshotHash', 'relationships', ...(hasBaseline ? ['baseline'] : []), ...(hasIdentity ? ['origin'] : []), ...(hasDocument ? ['document'] : [])]);
    const document = hasDocument ? readDocument(row.document) : undefined;
    if (hasDocument && document === undefined) invalid();
    for (const key of ['slug', 'title', 'description', 'why', 'how', 'path', 'updated']) if (typeof row[key] !== 'string') invalid();
    if (hasIdentity && !validOrigin(row.origin)) invalid();
    const key = slug(row.slug as string);
    instant(row.updated);
    if (typeof row.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.snapshotHash)) invalid();
    if (row.path !== `memories/${key}.md` || typeof row.pinned !== 'boolean' || !Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string') || !Array.isArray(row.renewals)) invalid();
    if (!Array.isArray(row.relationships)) invalid();
    /** Validate both current and immutable relationship inventories identically. */
    const parseRelationships = (values: unknown[]): PortableRelationship[] => values.map((value: unknown) => {
      if (!validRelationship(value, 'slug')) throw new MemoryError('relationship', 'Invalid portable relationship provenance', 'Restore the exported relationship fields; use string provenance, an SDK-supported created_at timestamp, and asserted/detected/legacy author_source');
      const edge = value as PortableRelationship;
      slug(edge.slug);
      return edge;
    });
    const relationships = parseRelationships(row.relationships);
    let baseline: PortableBaseline | undefined;
    if (hasBaseline) {
      const hasId = row.baseline !== null && typeof row.baseline === 'object' && 'id' in row.baseline;
      const hasSlug = row.baseline !== null && typeof row.baseline === 'object' && 'slug' in row.baseline;
      const hasOrigin = row.baseline !== null && typeof row.baseline === 'object' && 'origin' in row.baseline;
      const snapshots = row.baseline !== null && typeof row.baseline === 'object' ? ['bodyHash', 'documentHash', 'policyBodyHash', 'sourceFields', 'sourcePresence', 'sourceLinks'].filter(key => Object.hasOwn(row.baseline!, key)) : [];
      const fields = shape(row.baseline, ['fields', 'relationships', ...(hasId ? ['id'] : []), ...(hasSlug ? ['slug'] : []), ...(hasOrigin ? ['origin'] : []), ...snapshots]);
      for (const key of snapshots) {
        const value = fields[key];
        if (key === 'sourcePresence' || key === 'sourceLinks') {
          if (!Array.isArray(value) || new Set(value).size !== value.length || !value.every(entry => typeof entry === 'string' && (key === 'sourcePresence' ? ['title', 'description', 'kind', 'why', 'how'].includes(entry) : /^[a-z0-9_-]+$/.test(entry)))) invalid();
        } else if (key === 'sourceFields' ? !validFields(value) : typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
      }
      if (!validFields(fields.fields) || !Array.isArray(fields.relationships)) invalid();
      if (hasId && (typeof fields.id !== 'string' || fields.id.length === 0 || /[\r\n/\\\0]/.test(fields.id))) invalid();
      if (hasSlug && fields.slug !== key) throw new MemoryError('format', 'Portable identities cannot be renamed by editing the manifest', 'Restore the exported slug and path; rename native guidance explicitly, then export again');
      if (hasOrigin && !validOrigin(fields.origin)) invalid();
      baseline = { ...Object.fromEntries(snapshots.map(key => [key, fields[key]])), ...(hasId ? { id: fields.id as string } : {}), ...(hasSlug ? { slug: key } : {}), ...(hasOrigin ? { origin: fields.origin as NonNullable<PortableBaseline['origin']> } : {}), fields: fields.fields, relationships: parseRelationships(fields.relationships) };
    }
    if (hasIdentity && baseline?.origin !== undefined && !sameOrigin(row.origin as PortableOrigin, baseline.origin)) invalid();
    const renewals = row.renewals.map(window);
    for (const [index, entry] of renewals.entries()) if (entry.revision !== index + 1 || (index > 0 && entry.recordedAt < renewals[index - 1].recordedAt)) invalid();
    const validity = row.validity === null ? null : window(row.validity);
    if (!equal(validity, renewals.at(-1) ?? null)) invalid();
    return { ...(document === undefined ? {} : { document }), ...(hasIdentity ? { origin: row.origin as PortableOrigin } : {}), ...(baseline === undefined ? {} : { baseline }), relationships, snapshotHash: row.snapshotHash, slug: key, title: row.title as string, description: row.description as string, kind: kind(row.kind), why: row.why as string, how: row.how as string, pinned: row.pinned, tags: row.tags as string[], path: row.path, updated: row.updated as string, validity, renewals };
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
  const row: PortableGuidance = { ...(item.document === undefined ? {} : { document: item.document }), relationships, snapshotHash: snapshotDigest(item, item.body, relationships), slug: item.slug, title: item.title, description: item.description, kind: item.kind, why: item.why, how: item.how, pinned: item.pinned, tags: item.tags, path: `memories/${item.slug}.md`, updated: item.updated, validity: item.validity ?? null, renewals: [...revisions.values()].sort((a, b) => a.revision - b.revision) };
  row.origin = await itemOrigin(store, item.id, origins);
  const payload = policyPayload(item);
  const source = item.document?.format === 'legacy' ? sourceDocument(item.document.path, Buffer.from(payload), item.document.harness) : undefined;
  row.baseline = { ...(source === undefined ? {} : { sourceFields: portableFields({ ...source, pinned: false, tags: [] }, source.body), sourcePresence: source.represented, sourceLinks: [...new Set(source.links)] }), bodyHash: digest(payload), ...(item.document === undefined ? {} : { documentHash: digest(encodeDocument(item.document)) }), ...(item.policyBody === undefined ? {} : { policyBodyHash: digest(encodeDocument(item.policyBody)) }), id: item.id, slug: item.slug, origin: row.origin, fields: portableFields(row, item.body), relationships };
  return parsePolicy({ version: 1, format: 'pm-memory-policy', harness: 'agents-md', guidance: [row] }).guidance[0];
}
/** Retain local typed edges; excluded targets are reported in the export receipt. */
export function portableRelationships(item: Memory, memories: readonly Memory[]): PortableRelationship[] {
  return item.relationships.flatMap(({ id, ...edge }) => {
    const target = memories.find(memory => memory.id === id);
    return target === undefined || isCanceled(target) || target.artifact ? [] : [{ slug: target.slug, ...edge }];
  });
}
/** Normalize semantic provenance with the same SDK canonical document path used by storage. */
export function canonicalProvenance(row: Pick<PortableGuidance, 'title' | 'description' | 'kind' | 'why' | 'how' | 'pinned' | 'tags'>, body: string, relationships: PortableRelationship[]) {
  return canonicalDocument({ metadata: { id: 'portable-provenance', title: row.title, description: row.description, type: 'Knowledge', status: 'open', priority: 2, tags: row.tags, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', memory_kind: row.kind, memory_why: row.why, memory_how: row.how, memory_pinned: row.pinned, dependencies: relationships.map(({ slug, ...edge }) => ({ id: slug, ...edge })) }, body });
}
/** One lossless framing path separates retained frontmatter from the current SDK-native body. */
export function policyParts(item: Memory): { prefix: string; body: string } {
  const cached = item.policyBody === undefined ? item.body : Buffer.from(item.policyBody.original, 'base64').toString('utf8');
  let body = canonicalProvenance(item, cached, []).body === item.body ? cached : item.body;
  if (item.document === undefined) return { prefix: '', body };
  const bytes = Buffer.from(item.document.original, 'base64'); const original = bytes.toString('utf8');
  if (item.document.format === 'policy') return { prefix: '', body: item.policyBody === undefined && canonicalProvenance(item, original, []).body === item.body ? original : body };
  const source = sourceDocument(item.document.path, bytes, item.document.harness);
  if (item.policyBody === undefined && canonicalProvenance(item, source.body, []).body === item.body) body = source.body;
  const prefix = original.slice(0, original.length - source.body.length);
  return { prefix: prefix === '' && frontmatter(body) !== null ? '---\n{}\n---\n' : prefix, body };
}
/** Preserve all unrecognized frontmatter and body bytes, excluding only the derived marker. */
export function policyPayload(item: Memory): string {
  const parts = policyParts(item); return parts.prefix + parts.body;
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
/** Preserve the root typed refusal while closing planning skips over dependent identities. */
export function appendImportSkips(result: PortableImportResult, skipped: ReadonlyMap<string, string>, ids: ReadonlyMap<string, string>): void {
  for (const [slug, reason] of skipped) if (!result.skipped.some(row => row.slug === slug)) {
    const root = result.skipped.find(row => row.reason === reason && row.conflict !== undefined)?.conflict;
    result.skipped.push({ slug, reason, ...(root === undefined ? {} : { conflict: { ...root, item: ids.get(slug)!, dependency: root.dependency ?? root.item } }) });
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
  const provenance = new Map(legacy);
  const payloads: string[] = [];
  const bodies = manifest.guidance.map(row => {
    const file = input.find(file => file.path === row.path);
    if (file === undefined) return invalid();
    const content = file.bytes.toString('utf8'); const prefix = policyBody(row, '').toString('utf8');
    if (!Buffer.from(content).equals(file.bytes) || !content.startsWith(prefix)) return invalid();
    privacy(content, options.allowEmail);
    const payload = content.slice(prefix.length); payloads.push(payload);
    if (!provenance.has(row.slug) && row.document?.format === 'legacy') {
      const before = sourceDocument(row.document.path, Buffer.from(row.document.original, 'base64'), row.document.harness);
      const source = sourceDocument(row.document.path, Buffer.from(payload), row.document.harness);
      projectSourceFields(row, source, row.baseline?.sourceFields ?? portableFields({ ...before, pinned: false, tags: [] }, before.body), exportedSource(row).present);
      projectSourceLinks(row, source, exportedSource(row).links, manifest.guidance.map(target => ({ slug: target.slug, path: target.document?.path ?? target.path })));
      const edited = row.baseline?.bodyHash === undefined ? payload !== Buffer.from(row.document.original, 'base64').toString('utf8') : digest(payload) !== row.baseline.bodyHash;
      provenance.set(row.slug, { harness: row.document.harness, path: row.document.path, original: source.original, artifact: false, document: edited ? { ...row.document, original: source.original } : row.document });
      return source.body;
    }
    return payload;
  });
  privacy(JSON.stringify(manifest), options.allowEmail);
  for (const row of manifest.guidance) if (row.document !== undefined) privacy(Buffer.from(row.document.original, 'base64').toString('utf8'), options.allowEmail);
  for (const row of manifest.guidance) if (row.relationships.some(edge => !manifest.guidance.some(target => target.slug === edge.slug))) invalid();
  const inputHash = digest(JSON.stringify([manifest, payloads, [...provenance]]));
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
        const foreignOrigin = catalog.creators.some(entry => creatorMatchesOrigin(entry, origin) && corpus.some(item => item.id === entry.id) && !current.some(item => item.id === entry.id));
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
      const wire = provenance.get(row.slug);
      const document: HarnessDocument | undefined = wire === undefined ? row.document : wire.document ?? { version: 1, format: 'legacy', harness: wire.harness, path: wire.path, original: wire.original };
      const retainedDocument = document ?? previous?.document;
      const sourceBody = retainedDocument?.format === 'legacy' ? sourceDocument(retainedDocument.path, Buffer.from(retainedDocument.original, 'base64'), retainedDocument.harness).body : retainedDocument === undefined ? undefined : Buffer.from(retainedDocument.original, 'base64').toString('utf8');
      const changedPayload = previous === undefined
        ? canonicalProvenance(row, body, []).body !== body && sourceBody !== body || sourceBody !== undefined && sourceBody !== body && canonicalProvenance(row, sourceBody, []).body === body
        : (wire === undefined || previous.policyBody !== undefined) && policyParts(previous).body !== body && (previous.policyBody !== undefined || canonicalProvenance(row, body, []).body !== body || sourceBody !== undefined && sourceBody !== body && canonicalProvenance(row, sourceBody, []).body === body);
      const policyBody: HarnessDocument | undefined = changedPayload ? { version: 1, format: 'policy', harness: options.from, path: row.path, original: Buffer.from(body).toString('base64') } : undefined;
      let policyBodyHash = previous === undefined && policyBody !== undefined ? digest(encodeDocument(policyBody)) : undefined;
      let documentHash = previous === undefined && document !== undefined ? digest(encodeDocument(document)) : undefined;
      let update: ReturnType<typeof ownershipPatch> | undefined;
      if (previous !== undefined) {
        if (previous.slug !== row.slug) result.skipped.push({ slug: row.slug, reason: `Native identity retained as ${previous.slug}` });
        const prior = await policyRecord(store, previous, current, catalog);
        if (!equal(prior.validity, row.validity) || JSON.stringify(prior.renewals) !== JSON.stringify(row.renewals)) invalid();
        const owned = await previousOwnership(store, previous, baselineIds);
        if (previous.document !== undefined && owned?.documentHash === digest(encodeDocument(previous.document))) documentHash = owned.documentHash;
        if (previous.policyBody !== undefined && owned?.policyBodyHash === digest(encodeDocument(previous.policyBody))) policyBodyHash = owned.policyBodyHash;
        update = ownershipPatch(previous, row, body, ids, baselineIds, owned);
        if (wire !== undefined) {
          const before = row.document?.format === 'legacy' ? sourceDocument(row.document.path, Buffer.from(row.document.original, 'base64'), row.document.harness) : undefined;
          const base = before === undefined ? undefined : { present: exportedSource(row).present, native: previous, metadata: corpus.find(item => item.id === id)!, fields: row.baseline?.fields ?? portableFields({ ...before, pinned: false, tags: [] }, before.body), owned: owned?.fields };
          update.conflicts = [...new Set([...update.conflicts, ...unsetSourceFields(update.options, sourceDocument(wire.path, Buffer.from(wire.original, 'base64'), wire.harness), base)])];
        }
        if (document !== undefined) {
          const patch = documentPatch(previous, document, wire === undefined ? document.original : row.document?.original ?? owned?.source?.original ?? previous.original, owned?.sourceEdited, documentHash ?? row.baseline?.documentHash);
          Object.assign(update.options, patch.options); if (patch.conflict) { update.conflicts.push('document'); update.base.document = documentHash ?? row.baseline?.documentHash; update.current.document = previous.document === undefined ? undefined : digest(encodeDocument(previous.document)); }
          if (patch.options.memoryDocument !== undefined) documentHash = digest(encodeDocument(document));
        }
        if (policyBody !== undefined && !update.conflicts.includes('body')) {
          const expectedBody = policyBodyHash ?? row.baseline?.policyBodyHash;
          const patch = documentPatch({ document: previous.policyBody }, policyBody, undefined, owned?.bodyEdited || (previous.policyBody !== undefined && expectedBody === undefined), expectedBody);
          if (patch.conflict) { delete update.options.body; update.conflicts.push('policy_body'); update.base.policy_body = expectedBody; update.current.policy_body = previous.policyBody === undefined ? undefined : digest(encodeDocument(previous.policyBody)); }
          if (patch.options.memoryDocument !== undefined) { update.options.memoryPolicyBody = patch.options.memoryDocument; policyBodyHash = digest(encodeDocument(policyBody)); }
        }
        if (update.conflicts.length > 0) {
          const reason = `import_conflict: Independently edited native content retained: ${update.conflicts.join(', ')}`;
          result.skipped.push({ slug: row.slug, reason, conflict: importConflict(id, update.conflicts, update.base, update.current) });
          skipped.set(row.slug, reason); continue;
        }
        if (Object.keys(update.options).length === 0) { decisions.set(row.slug, 'unchanged'); ownership.push(update.ownership); continue; }
        contentRevision(update.options, undefined, previous.updated);
        decisions.set(row.slug, 'updated');
      } else decisions.set(row.slug, 'imported');
      const changedSource = row.baseline?.bodyHash !== undefined && digest(wire === undefined ? payloads[index] : Buffer.from(wire.original, 'base64').toString('utf8')) !== row.baseline.bodyHash;
      const fields = { ...(document === undefined ? {} : { document: encodeDocument(document) }), ...(policyBody === undefined ? {} : { policy_body: encodeDocument(policyBody) }), slug: row.slug, kind: row.kind, why: row.why, how: row.how, pinned: row.pinned, source: wire === undefined ? 'portable:policy-v1' : `${wire.harness}:relative-file`, original: wire?.original ?? Buffer.from(JSON.stringify([row, body])).toString('base64'), path: wire?.path ?? row.path, edited: false, artifact: wire?.artifact ?? false, changed_at: !changedSource && snapshotDigest(row, body, row.relationships) === row.snapshotHash ? row.updated : new Date().toISOString(), renewals: JSON.stringify(row.renewals), ...(guidanceOrigin(row) === undefined ? {} : { origin: JSON.stringify(guidanceOrigin(row)) }), ...(row.validity === null ? {} : { validity: JSON.stringify(row.validity) }) };
      // Stable create ids and payloads let the SDK resume an interrupted batch without duplicates.
      const creating = previous === undefined;
      const relationships = resolvedRelationships(row.relationships, ids);
      ownership.push({ ...(update?.ownership ?? { id, fields: portableFields(row, body), relationships, graph: relationships }), ...(documentHash === undefined ? {} : { documentHash }), ...(policyBodyHash === undefined ? {} : { policyBodyHash }), ...(wire === undefined ? {} : { source: { original: wire.original } }) });
      mutations.push({ op: creating ? 'create' : 'update', id: previous?.id ?? id, ...(creating ? { unique: { key: 'memory_slug', value: row.slug } } : { match: { key: 'updated_at', value: corpus.find(item => item.id === previous.id)!.updated_at } }), options: creating ? { title: row.title, description: row.description, body, type: 'Knowledge', allowDuplicate: true, allowUnresolvedDeps: true, ...itemDocumentToMutationOptions(JSON.stringify({ tags: row.tags, dependencies: relationships }), 'create'), ...metadata(fields) } : update!.options });
    }
    closeSkips(manifest.guidance, skipped);
    appendImportSkips(result, skipped, ids);
    const admitted = manifest.guidance.filter(row => !skipped.has(row.slug));
    const planned = mutations.filter(mutation => admitted.some(row => ids.get(row.slug) === mutation.id));
    for (const row of admitted) result[decisions.get(row.slug)!]++;
    if (planned.length === 0) return result;
    const expected = await expectedTargets(store, admitted.map(row => ({ id: ids.get(row.slug)!, slug: selected.get(row.slug)?.slug ?? row.slug, origin: guidanceOrigin(row) })), corpus);
    const plan = { identityVersion: 1 as const, pmRoot: store.workspace, author: resolveAuthorIdentity(options.author, settings.author_default).author, ...identity, mutations: planned, outcomes: Object.fromEntries(admitted.map(row => [ids.get(row.slug)!, decisions.get(row.slug)!])), ownership: ownership.filter(target => admitted.some(row => ids.get(row.slug) === target.id)), input: inputHash, result, expected, members: admitted.map(row => ids.get(row.slug)!) };
    await validateImportPlan(store, plan, options.onStep);
    await store.register(options.onStep);
    await previewImport(store, plan, options.onStep);
    await options.onStep?.('previewed');
    return applyImport(store, plan, options);
  });
}
