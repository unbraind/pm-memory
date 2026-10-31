import { trackerSchema } from './lifecycle.ts';
import { documentHash, validNativeProof } from './portable-write.ts';
import type { NativeProof } from './portable-write.ts';
import { validRelationship } from './portable-relationships.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, getItemAt, hashHistoryStream, readHistoryEntries, replayHistoryToTarget, itemDocumentToMutationOptions, createRelationshipKindRegistry } from '@unbrained/pm-cli/sdk';
import type { Dependency } from '@unbrained/pm-cli/sdk';
import { canonicalProvenance } from './portable.ts';
import type { PortableGuidance, PortableRelationship } from './portable.ts';
import type { Harness, Memory } from './types.ts';
import type { Store } from './store.ts';
import { digest, MemoryError } from './core.ts';
import type { PortableOrigin } from './portable-origin.ts';
import { birthDocument } from './portable-preview.ts';
import { sourceDocument, stemOf } from './portable-source.ts';
import type { Source } from './portable-source.ts';

const relationshipKinds = createRelationshipKindRegistry();

/** Only these semantic fields are represented by a policy document. */
export const PORTABLE_FIELDS = ['title', 'description', 'body', 'kind', 'why', 'how', 'pinned', 'tags'] as const;
/** A canonical SDK field fingerprint, independent of native bookkeeping. */
export type PortableFields = Record<typeof PORTABLE_FIELDS[number], string>;
/** Immutable export baseline distinguishes absence from an explicit portable edit. */
export interface PortableBaseline {
  /** Digest of the exact exported payload, excluding only the derived policy marker. */
  bodyHash?: string;
  /** Native complete-document ownership at export time, when represented. */
  documentHash?: string;
  /** Native raw policy-payload ownership at export time, when present. */
  policyBodyHash?: string;
  /** SDK-normalized source projection of the actual exported file, independent of native overrides. */
  sourceFields?: PortableFields;
  /** Explicit fields and wiki references in the actual exported payload, not an older source snapshot. */
  sourcePresence?: Source['represented'];
  /** Only these text references grant source-removal authority. */
  sourceLinks?: string[];
  /** Immutable originating subject and tracker namespace; aliases never select a target. */
  origin?: PortableOrigin;
  /** Original native identity distinguishes source edits from unrelated slug collisions. */
  id?: string;
  /** Exported identity is stable even when native-only slug metadata later changes. */
  slug?: string;
  /** SDK-normalized fingerprints of the exported semantic fields. */
  fields: PortableFields;
  /** Only relationships explicitly represented by this export. */
  relationships: PortableRelationship[];
}
/** Durable ownership receipt carried by the SDK transaction, never native item fields. */
export interface OwnedTarget {
  /** Exact SDK publication position; a message only locates the receipt, never grants authority. */
  proof?: NativeProof;
  /** Complete document state positively retained by this publication. */
  documentHash?: string;
  /** Exact policy-payload state this publication actually wrote or retained as owned. */
  policyBodyHash?: string;
  /** Native target identity. */
  id: string;
  /** Requested portable field fingerprints; conflicts do not adopt native values. */
  fields: Partial<PortableFields>;
  /** Requested, represented relationships with resolved native identities. */
  relationships: Dependency[];
  /** Complete resulting graph retained for identity remapping during recovery. */
  graph: Dependency[];
  /** Legacy source bytes retained outside the native original-source metadata. */
  source?: { original: string };
}
/** Native changes invalidate only the affected part of a prior portable receipt. */
export interface PreviousOwnership {
  /** Last positively owned complete document, independent of native field edits. */
  documentHash?: string;
  /** Last positively owned exact policy payload, independent of later semantic edits. */
  policyBodyHash?: string;
  /** A native document edit cannot be overwritten by a later harness revision. */
  sourceEdited?: boolean;
  /** Native changes to exact policy payload bytes must survive import. */
  bodyEdited?: boolean;
  /** SDK birth values grant field authority without claiming a committed graph receipt. */
  creation?: boolean;
  /** Native values positively retained by the last exact publication; never write authority. */
  retainedFields?: Partial<PortableFields>;
  /** Unrepresented or subsequently native-edited fields grant no portable authority. */
  fields: Partial<PortableFields>;
  /** Prior represented edges remain authoritative outside the actual native edit scope. */
  relationships?: Dependency[];
  /** SDK-read edge identities changed natively after the portable receipt. */
  nativeRelationships?: Dependency[];
  /** Latest represented legacy source, when this receipt came from a text harness. */
  source?: OwnedTarget['source'];
}
/** Compare values through the SDK storage normalizer used by policy provenance. */
export function portableFields(row: Parameters<typeof canonicalProvenance>[0], body: string): PortableFields {
  const document = canonicalProvenance(row, body, []);
  const values = { title: document.metadata.title, description: document.metadata.description, body: document.body, kind: document.metadata.memory_kind, why: document.metadata.memory_why, how: document.metadata.memory_how, pinned: document.metadata.memory_pinned, tags: document.metadata.tags };
  return Object.fromEntries(PORTABLE_FIELDS.map(key => [key, digest(JSON.stringify(values[key]))])) as PortableFields;
}
/** Both full policy payloads and legacy companions project only explicit source edits onto native fields. */
export function projectSourceFields(row: PortableGuidance, source: Source, baseline: PortableFields, before?: readonly Source['represented'][number][]): void {
  const decoded = portableFields({ ...source, pinned: false, tags: [] }, source.body);
  for (const field of ['title', 'description', 'kind', 'why', 'how'] as const) if (decoded[field] !== baseline[field] || before?.includes(field) && !source.represented.includes(field)) Object.assign(row, { [field]: source[field] });
}
/** Older exports grant body-derived removal authority only when their source snapshot matches the exported body. */
export function exportedSource(row: PortableGuidance): { present: Source['represented']; links: string[] } {
  if (row.baseline?.sourcePresence !== undefined && row.baseline.sourceLinks !== undefined) return { present: row.baseline.sourcePresence, links: row.baseline.sourceLinks };
  if (row.document?.format !== 'legacy') return { present: [], links: [] };
  const source = sourceDocument(row.document.path, Buffer.from(row.document.original, 'base64'), row.document.harness);
  const fields = portableFields({ ...source, pinned: false, tags: [] }, source.body);
  if (fields.body === (row.baseline?.sourceFields ?? row.baseline?.fields)?.body) return { present: source.represented, links: source.links };
  const prefix = Buffer.from(row.document.original, 'base64').toString('utf8').slice(0, -source.body.length || undefined);
  return { present: sourceDocument(row.document.path, Buffer.from(prefix), row.document.harness).represented, links: [] };
}
/** Source-carried wiki edges own removals; snapshot-only and native-only edges remain untouched. */
export function projectSourceLinks(row: PortableGuidance, source: Source, before: readonly string[], inventory: readonly { slug: string; path: string }[]): void {
  const resolve = (links: readonly string[]) => links.flatMap(link => {
    const exact = inventory.filter(target => target.slug === link);
    const choices = exact.length > 0 ? exact : inventory.filter(target => stemOf(target.path) === link);
    return choices.length === 1 && choices[0].slug !== row.slug ? [choices[0].slug] : [];
  });
  const old = resolve(before); const next = resolve(source.links);
  for (const slug of old.filter(slug => !next.includes(slug))) if (row.relationships.filter(edge => edge.slug === slug && edge.kind === 'related').length > 1) throw new MemoryError('conflict', 'Source relationship namespace is ambiguous', 'Edit the explicit manifest relationships to select a namespace; source text cannot remove multiple native namespaces');
  row.relationships = row.relationships.filter(edge => edge.kind !== 'related' || !old.includes(edge.slug) || next.includes(edge.slug));
  for (const slug of next) if (!old.includes(slug) && !row.relationships.some(edge => edge.slug === slug && edge.kind === 'related')) row.relationships.push({ slug, kind: 'related' });
}
/** SDK base for a source-field removal whose logical default did not change. */
export interface SourceRemovalBase {
  /** Exact prior source establishes presence independently of decoded defaults. */
  present: readonly Source['represented'][number][];
  /** Current SDK-decoded semantic fields. */
  native: Memory;
  /** Complete current SDK metadata distinguishes absent fields from empty values. */
  metadata: Record<string, unknown>;
  /** Saved SDK-normalized field bases, never values adopted from a peer. */
  fields: PortableFields;
  /** Last positively retained field values, if available. */
  owned?: Partial<PortableFields>;
}
/** Translate proven source absences into SDK unsets, reporting moved field bases. */
export function unsetSourceFields(options: Record<string, unknown>, source: Source, base?: SourceRemovalBase): string[] {
  const removed: string[] = []; const conflicts: string[] = [];
  const native = base === undefined ? undefined : portableFields(base.native, base.native.body);
  const desired = portableFields({ ...source, pinned: false, tags: [] }, source.body);
  for (const field of ['description', 'kind', 'why', 'how'] as const) {
    if (source.represented.includes(field)) continue;
    const option = field === 'description' ? field : `memory${field[0].toUpperCase()}${field.slice(1)}`; const key = field === 'description' ? field : `memory_${field}`;
    if (Object.hasOwn(options, option)) { if (field !== 'description') { delete options[option]; removed.push(key); } }
    else if (base?.present.includes(field) && base.metadata[key] !== undefined) {
      if (field === 'description' && native![field] === desired[field]) continue;
      if (base.owned?.[field] === native![field] || base.fields[field] === native![field]) {
        if (field === 'description') options.description = source.description; else removed.push(key);
      } else conflicts.push(field);
    }
  }
  if (removed.length > 0) options.unset = [...(options.unset as string[] | undefined ?? []), ...removed];
  return conflicts;
}
/** Reject malformed baselines rather than silently widening import ownership. */
export function validFields(value: unknown): value is PortableFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).sort().join(',') === [...PORTABLE_FIELDS].sort().join(',') && PORTABLE_FIELDS.every(key => typeof fields[key] === 'string' && /^[a-f0-9]{64}$/.test(fields[key]));
}
/** Private receipts grant authority only to fields explicitly carried by their harness. */
function validOwnedFields(value: unknown): value is Partial<PortableFields> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = Object.entries(value);
  return fields.length > 0 && fields.every(([key, hash]) => PORTABLE_FIELDS.some(field => field === key) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
}
/** Validate stored ownership edges before interpreting a private recovery record. */
export function validOwnedTarget(value: unknown): value is OwnedTarget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  /** Foreign edge shapes never become deletion authority. */
  const edges = (values: unknown): values is Dependency[] => Array.isArray(values) && values.every(value => validRelationship(value, 'id'));
  const source = target.source;
  return (target.proof === undefined || validNativeProof(target.proof)) && typeof target.id === 'string' && validOwnedFields(target.fields) && edges(target.relationships) && edges(target.graph) && (target.documentHash === undefined || (typeof target.documentHash === 'string' && /^[a-f0-9]{64}$/.test(target.documentHash))) && (target.policyBodyHash === undefined || (typeof target.policyBodyHash === 'string' && /^[a-f0-9]{64}$/.test(target.policyBodyHash))) && (source === undefined || (source !== null && typeof source === 'object' && !Array.isArray(source) && 'original' in source && typeof source.original === 'string'));
}
/** Immutable creation metadata remains authoritative when native bookkeeping is edited. */
export async function creationMetadata(store: Store, id: string): Promise<ReturnType<typeof replayHistoryToTarget>['metadata'] | undefined> {
  try {
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
    return entries.length === 0 ? undefined : replayHistoryToTarget(entries, 0).metadata;
  } catch { return undefined; }
}
/** Admit matching SDK birth bodies and grant authority only to agreeing, represented source fields. */
export async function legacyBirth(store: Store, id: string, created: NonNullable<Awaited<ReturnType<typeof creationMetadata>>>): Promise<Pick<PreviousOwnership, 'fields' | 'source'> | undefined> {
  try {
    const source = sourceDocument(String(created.memory_path), Buffer.from(String(created.memory_original), 'base64'), String(created.memory_source).split(':')[0] as Harness);
    const { document } = await getItemAt(id, '1', { pmRoot: store.workspace });
    const [born] = await store.read(new Set([id]), [{ ...document.metadata, body: document.body }]);
    const actual = portableFields(born, born.body); const decoded = portableFields({ ...source, pinned: false, tags: [] }, source.body);
    if (actual.body !== decoded.body) return undefined;
    return { fields: Object.fromEntries(['body' as const, ...source.represented].filter(field => actual[field] === decoded[field]).map(field => [field, actual[field]])), source: { original: source.original } };
  } catch { return undefined; }
}
/** Resolve portable identities without adopting references absent from the inventory. */
export function resolvedRelationships(edges: readonly PortableRelationship[], ids: ReadonlyMap<string, string>): Dependency[] {
  return edges.flatMap(({ slug, ...edge }) => ids.has(slug) ? [{ ...edge, kind: relationshipKinds.resolve(edge.kind)!.kind as Dependency['kind'], id: ids.get(slug)! }] : []);
}
/** SDK mutation projection compares only provenance that its writer can retain. */
function edgeHash(edge: Dependency | undefined): string {
  return JSON.stringify(edge === undefined ? null : itemDocumentToMutationOptions(JSON.stringify({ dependencies: [edge] }), 'update'));
}
/** A relationship identity includes the native source namespace as well as kind and target. */
function edgeKey(edge: Dependency): string { return JSON.stringify([edge.id, edge.kind, edge.source_kind ?? '']); }
/** Missing edge provenance means unknown: inherit it from the actual SDK value. */
function inheritEdges(edges: readonly Dependency[], current: readonly Dependency[], strict: boolean): Dependency[] {
  return edges.map(edge => {
    const matches = current.filter(prior => prior.id === edge.id && prior.kind === edge.kind && (edge.source_kind === undefined || prior.source_kind === edge.source_kind));
    if (strict && matches.length > 1) throw new MemoryError('conflict', 'Portable relationship namespace is ambiguous', 'Export again and retain source_kind to select the represented relationship; native edges were not changed');
    return matches.length === 1 ? { ...matches[0], ...edge } : edge;
  });
}
/** Express selective changes using SDK-serialized additions and removal selectors. */
export function relationshipPatch(before: readonly Dependency[], after: readonly Dependency[]): Record<string, unknown> {
  const additions = after.filter(edge => !before.some(prior => edgeKey(prior) === edgeKey(edge) && edgeHash(prior) === edgeHash(edge)));
  const removed = before.filter(edge => !after.some(next => edgeKey(next) === edgeKey(edge)));
  const selectors = removed.map(({ id, kind, source_kind }) => {
    const serialized = itemDocumentToMutationOptions(JSON.stringify({ dependencies: [{ id, kind, source_kind }] }), 'update');
    return (serialized.dep as string[])[0];
  });
  return { ...(additions.length === 0 ? {} : itemDocumentToMutationOptions(JSON.stringify({ dependencies: additions }), 'update')), ...(selectors.length === 0 ? {} : { depRemove: selectors }) };
}
/** Three-way merge: an unchanged portable value cannot overwrite a native edit. */
export function ownershipPatch(current: Memory, row: PortableGuidance, body: string, ids: ReadonlyMap<string, string>, baselineIds: ReadonlyMap<string, string>, prior?: PreviousOwnership, removeRepresented = true, fields: readonly (keyof PortableFields)[] = PORTABLE_FIELDS): { options: Record<string, unknown>; ownership: OwnedTarget; conflicts: string[]; base: Record<string, unknown>; current: Record<string, unknown> } {
  const incoming = portableFields(row, body); const native = portableFields(current, current.body);
  const baseline = row.baseline?.fields ?? prior?.fields ?? native;
  const options: Record<string, unknown> = {}; const conflicts: string[] = []; const baseValues: Record<string, unknown> = { ...baseline }; const currentValues: Record<string, unknown> = { ...native };
  for (const key of fields) {
    if (incoming[key] === native[key]) continue;
    if (prior?.fields[key] === native[key] || (incoming[key] !== baseline[key] && native[key] === baseline[key])) {
      const name = ['kind', 'why', 'how', 'pinned'].includes(key) ? `memory${key[0].toUpperCase()}${key.slice(1)}` : key;
      options[name] = key === 'body' ? body : key === 'tags' ? itemDocumentToMutationOptions(JSON.stringify({ tags: row.tags }), 'update').tags : row[key];
    } else if (incoming[key] !== baseline[key]) conflicts.push(key);
  }
  const desired = inheritEdges(resolvedRelationships(row.relationships, ids), current.relationships, true);
  const exported = inheritEdges(resolvedRelationships(row.baseline?.relationships ?? row.relationships, baselineIds), current.relationships, false);
  const previouslyOwned = prior?.relationships === undefined ? undefined : inheritEdges(prior.relationships, current.relationships, false);
  const scope = new Set([...ids.values(), ...exported.map(edge => edge.id)]);
  const graph = [...current.relationships];
  const keys = new Set([...graph, ...desired, ...exported, ...(previouslyOwned ?? [])].filter(edge => scope.has(edge.id)).map(edgeKey));
  for (const key of keys) {
    const now = graph.find(edge => edgeKey(edge) === key); const next = desired.find(edge => edgeKey(edge) === key);
    const base = exported.find(edge => edgeKey(edge) === key); const old = previouslyOwned?.find(edge => edgeKey(edge) === key);
    if (edgeHash(now) === edgeHash(next)) continue;
    if (next === undefined && !removeRepresented) continue;
    const nativeEdit = prior?.nativeRelationships?.some(changed => [now, next, old].some(edge => edge !== undefined && edge.id === changed.id && edge.kind === changed.kind && (edge.source_kind === undefined || edge.source_kind === changed.source_kind)));
    if ((previouslyOwned !== undefined && !nativeEdit && edgeHash(now) === edgeHash(old)) || (edgeHash(next) !== edgeHash(base) && edgeHash(now) === edgeHash(base))) {
      const position = graph.findIndex(edge => edgeKey(edge) === key); if (position !== -1) graph.splice(position, 1);
      if (next !== undefined) graph.push(next);
    } else if (edgeHash(next) !== edgeHash(base)) { const field = `relationship:${key}`; conflicts.push(field); baseValues[field] = edgeHash(base); currentValues[field] = edgeHash(now); }
  }
  Object.assign(options, relationshipPatch(current.relationships, graph));
  if (Object.keys(options).length === 0) for (const key of fields) if (incoming[key] !== native[key] && prior?.retainedFields?.[key] !== native[key] && !conflicts.includes(key)) conflicts.push(key);
  return { options, conflicts, base: baseValues, current: currentValues, ownership: { id: current.id, fields: incoming, relationships: desired, graph } };
}
/** Read one complete, committed package receipt; missing or foreign journals prove nothing. */
async function committedReceipt(store: Store, transactionId: string, id: string): Promise<OwnedTarget | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(store.workspace, 'transactions', 'sdk', `${transactionId}-snapshot.json`), 'utf8')); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  const journal = value as { status?: unknown; results?: Record<string, { owner?: unknown; targets?: OwnedTarget[] }> };
  if (journal.status !== 'committed' || journal.results === undefined || journal.results === null || typeof journal.results !== 'object') return undefined;
  for (const receipt of Object.values(journal.results)) {
    if (receipt === null || typeof receipt !== 'object' || receipt.owner !== 'pm-memory-policy-ownership:1' || !Array.isArray(receipt.targets)) continue;
    const target = receipt.targets.find(target => validOwnedTarget(target) && target.id === id);
    if (target !== undefined) return target;
  }
  return undefined;
}
/** Verify complete birth evidence from immutable SDK history; older markers use publication receipts. */
export async function recordedCreation(store: Store, id: string): Promise<boolean> {
  try {
    const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
    if (entries.length === 0) return true;
    const born = replayHistoryToTarget([entries[0]], 0);
    const format = born.metadata.memory_birth;
    if (format !== undefined && format !== 'portable-v1') return false;
    if (!/^bulk-item-transaction memory-policy-(?:mutate-[a-f0-9]{24}|[a-f0-9]{40})-nodes /.test(entries[0].message ?? '')) return format === undefined;
    const seal = / memory-birth-v1:([a-f0-9]{64})$/.exec(entries[0].message!);
    if (seal !== null) return digest(birthDocument((await getItemAt(id, '1', { pmRoot: store.workspace })).document, await trackerSchema(store.workspace))) === seal[1];
    if (format !== undefined) return false;
    const attempted = new Set<string>();
    for (const entry of entries) {
      const match = /^bulk-item-transaction (memory-policy-(?:mutate-[a-f0-9]{24}|[a-f0-9]{40}))(?:-nodes)? /.exec(entry.message ?? '');
      if (match === null || attempted.has(match[1])) continue;
      attempted.add(match[1]);
      if (await committedReceipt(store, match[1], id) !== undefined) return true;
    }
    return false;
  } catch { return false; }
}

/** Read only committed package receipts linked by immutable SDK history markers. */
export async function previousOwnership(store: Store, item: Memory, ids: ReadonlyMap<string, string>): Promise<PreviousOwnership | undefined> {
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, item.id), item.id);
  const changed = new Set<string>(); const graphEdits = new Set<number>();
  let sourceEdited = false;
  let bodyEdited = false;
  /** Invalidate native-edited fields without discarding ownership of unrelated values. */
  const retained = (target: Pick<OwnedTarget, 'fields'> & Partial<Pick<OwnedTarget, 'relationships' | 'source' | 'policyBodyHash' | 'documentHash'>>, published?: PortableFields): PreviousOwnership => {
    const nativeEdges = new Map<string, Dependency>();
    for (const index of graphEdits) {
      const before = (replayHistoryToTarget(entries, index - 1).metadata.dependencies ?? []) as Dependency[];
      const after = (replayHistoryToTarget(entries, index).metadata.dependencies ?? []) as Dependency[];
      for (const key of new Set([...before, ...after].map(edgeKey))) {
        const old = before.find(edge => edgeKey(edge) === key); const current = after.find(edge => edgeKey(edge) === key);
        if (edgeHash(old) !== edgeHash(current)) nativeEdges.set(key, current ?? old!);
      }
    }
    return { retainedFields: published === undefined ? undefined : Object.fromEntries(PORTABLE_FIELDS.filter(key => !changed.has(key) && target.fields[key] !== undefined && target.fields[key] !== published[key]).map(key => [key, published[key]])), fields: Object.fromEntries(PORTABLE_FIELDS.filter(key => !changed.has(key) && target.fields[key] !== undefined).map(key => [key, target.fields[key]!])) as Partial<PortableFields>, relationships: target.relationships, nativeRelationships: [...nativeEdges.values()], sourceEdited, bodyEdited, documentHash: target.documentHash, policyBodyHash: target.policyBodyHash, ...(target.source === undefined ? {} : { source: target.source }) };
  };
  for (const [position, entry] of [...entries].reverse().entries()) {
    const match = /^bulk-item-transaction (memory-policy-(?:mutate-[a-f0-9]{24}|[a-f0-9]{40}))(?:-nodes)? /.exec(entry.message ?? '');
    if (match !== null) {
      const target = await committedReceipt(store, match[1], item.id);
      if (target !== undefined) {
        const index = entries.length - 1 - position;
        const { document } = await getItemAt(item.id, String(index + 1), { pmRoot: store.workspace });
        const [historical] = await store.read(new Set([item.id]), [{ ...document.metadata, body: document.body }]);
        const fields = portableFields(historical, historical.body);
        const exact = target.proof === undefined
          ? Object.entries(target.fields).every(([key, value]) => fields[key as keyof PortableFields] === value) && inheritEdges(target.relationships, historical.relationships, false).every(edge => historical.relationships.some(current => edgeKey(current) === edgeKey(edge) && edgeHash(current) === edgeHash(edge)))
          : target.proof.length === index + 1 && target.proof.history === hashHistoryStream(entries.slice(0, index + 1)) && target.proof.hash === documentHash(document, await trackerSchema(store.workspace));
        if (exact) return retained(target, fields);
      }
    }
    // Even a perfect copy of an import's marker is a native edit without an exact receipt.
    if (entry.op !== 'create') for (const patch of entry.patch) {
      if (patch.path === '/metadata/memory_document' || patch.path.startsWith('/metadata/memory_document/')) sourceEdited = true;
      if (patch.path === '/metadata/memory_policy_body' || patch.path.startsWith('/metadata/memory_policy_body/')) bodyEdited = true;
      for (const key of PORTABLE_FIELDS) {
        const path = key === 'body' ? '/body' : `/metadata/${['kind', 'why', 'how', 'pinned'].includes(key) ? `memory_${key}` : key}`;
        if (patch.path === path || patch.path.startsWith(`${path}/`)) changed.add(key);
      }
      if (patch.path.startsWith('/metadata/dependencies')) graphEdits.add(entries.length - 1 - position);
    }
  }
  const created = await creationMetadata(store, item.id);
  if (created?.memory_source === 'portable:policy-v1') {
    try {
      const [row, body] = JSON.parse(Buffer.from(String(created.memory_original), 'base64').toString('utf8')) as [PortableGuidance, string];
      return retained({ fields: portableFields(row, body), relationships: (await getItemAt(item.id, '1', { pmRoot: store.workspace })).document.metadata.dependencies ?? [] });
    } catch { return undefined; }
  }
  if (typeof created?.memory_source === 'string' && created.memory_source.endsWith(':relative-file')) {
    const born = await legacyBirth(store, item.id, created);
    if (born !== undefined) return { ...retained({ ...born, relationships: (await getItemAt(item.id, '1', { pmRoot: store.workspace })).document.metadata.dependencies ?? [] }), creation: true };
  }
  return undefined;
}
