import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, getItemAt, readHistoryEntries, replayHistoryToTarget, itemDocumentToMutationOptions, DEPENDENCY_KIND_VALUES, createRelationshipKindRegistry } from '@unbrained/pm-cli/sdk';
import type { Dependency } from '@unbrained/pm-cli/sdk';
import { canonicalProvenance } from './portable.ts';
import type { PortableGuidance, PortableRelationship } from './portable.ts';
import type { Harness, Memory } from './types.ts';
import type { Store } from './store.ts';
import { digest, MemoryError } from './core.ts';
import type { PortableOrigin } from './portable-origin.ts';
import { sourceDocument } from './portable-source.ts';

const relationshipKinds = createRelationshipKindRegistry();

/** Only these semantic fields are represented by a policy document. */
export const PORTABLE_FIELDS = ['title', 'description', 'body', 'kind', 'why', 'how', 'pinned', 'tags'] as const;
/** A canonical SDK field fingerprint, independent of native bookkeeping. */
export type PortableFields = Record<typeof PORTABLE_FIELDS[number], string>;
/** Immutable export baseline distinguishes absence from an explicit portable edit. */
export interface PortableBaseline {
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
  /** SDK birth values grant field authority without claiming a committed graph receipt. */
  creation?: boolean;
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
  const edges = (values: unknown): values is Dependency[] => Array.isArray(values) && values.every(value => value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string' && DEPENDENCY_KIND_VALUES.includes(value.kind));
  const source = target.source;
  return typeof target.id === 'string' && validOwnedFields(target.fields) && edges(target.relationships) && edges(target.graph) && (source === undefined || (source !== null && typeof source === 'object' && !Array.isArray(source) && 'original' in source && typeof source.original === 'string'));
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
export function ownershipPatch(current: Memory, row: PortableGuidance, body: string, ids: ReadonlyMap<string, string>, baselineIds: ReadonlyMap<string, string>, prior?: PreviousOwnership, removeRepresented = true): { options: Record<string, unknown>; ownership: OwnedTarget; conflicts: string[] } {
  const incoming = portableFields(row, body); const native = portableFields(current, current.body);
  const baseline = row.baseline?.fields ?? prior?.fields ?? native;
  const options: Record<string, unknown> = {}; const conflicts: string[] = [];
  for (const key of PORTABLE_FIELDS) {
    if (incoming[key] === native[key]) continue;
    if (prior?.fields[key] === native[key] || (incoming[key] !== baseline[key] && native[key] === baseline[key])) {
      const name = ['kind', 'why', 'how', 'pinned'].includes(key) ? `memory${key[0].toUpperCase()}${key.slice(1)}` : key;
      options[name] = key === 'body' ? body : key === 'tags' ? row.tags.join(',') : row[key];
    } else conflicts.push(key);
  }
  const desired = inheritEdges(resolvedRelationships(row.relationships, ids), current.relationships, true);
  const exported = resolvedRelationships(row.baseline?.relationships ?? row.relationships, baselineIds);
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
    } else if (edgeHash(next) !== edgeHash(base)) conflicts.push(`relationship:${key}`);
  }
  Object.assign(options, relationshipPatch(current.relationships, graph));
  return { options, conflicts, ownership: { id: current.id, fields: incoming, relationships: desired, graph } };
}
/** Read only committed package receipts linked by immutable SDK history markers. */
export async function previousOwnership(store: Store, item: Memory, ids: ReadonlyMap<string, string>): Promise<PreviousOwnership | undefined> {
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, item.id), item.id);
  const attempted = new Set<string>();
  const changed = new Set<string>(); const graphEdits = new Set<number>();
  /** Invalidate native-edited fields without discarding ownership of unrelated values. */
  const retained = (target: Pick<OwnedTarget, 'fields'> & Partial<Pick<OwnedTarget, 'relationships' | 'source'>>): PreviousOwnership => {
    const nativeEdges = new Map<string, Dependency>();
    for (const index of graphEdits) {
      const before = (replayHistoryToTarget(entries, index - 1).metadata.dependencies ?? []) as Dependency[];
      const after = (replayHistoryToTarget(entries, index).metadata.dependencies ?? []) as Dependency[];
      for (const key of new Set([...before, ...after].map(edgeKey))) {
        const old = before.find(edge => edgeKey(edge) === key); const current = after.find(edge => edgeKey(edge) === key);
        if (edgeHash(old) !== edgeHash(current)) nativeEdges.set(key, current ?? old!);
      }
    }
    return { fields: Object.fromEntries(PORTABLE_FIELDS.filter(key => !changed.has(key) && target.fields[key] !== undefined).map(key => [key, target.fields[key]!])) as Partial<PortableFields>, relationships: target.relationships, nativeRelationships: [...nativeEdges.values()], ...(target.source === undefined ? {} : { source: target.source }) };
  };
  for (const [position, entry] of [...entries].reverse().entries()) {
    const match = /^bulk-item-transaction (memory-policy-(?:mutate-[a-f0-9]{24}|[a-f0-9]{40})) /.exec(entry.message ?? '');
    if (match === null) {
      if (!entry.message?.startsWith('bulk-item-transaction memory-policy-') && entry.op !== 'create') for (const patch of entry.patch) {
        for (const key of PORTABLE_FIELDS) {
          const path = key === 'body' ? '/body' : `/metadata/${['kind', 'why', 'how', 'pinned'].includes(key) ? `memory_${key}` : key}`;
          if (patch.path === path || patch.path.startsWith(`${path}/`)) changed.add(key);
        }
        if (patch.path.startsWith('/metadata/dependencies')) graphEdits.add(entries.length - 1 - position);
      }
      continue;
    }
    if (attempted.has(match[1])) continue;
    attempted.add(match[1]);
    let value: unknown;
    try { value = JSON.parse(await readFile(join(store.workspace, 'transactions', 'sdk', `${match[1]}-snapshot.json`), 'utf8')); } catch { continue; }
    if (value === null || typeof value !== 'object') continue;
    const journal = value as { status?: unknown; results?: Record<string, { owner?: unknown; targets?: OwnedTarget[] }> };
    if (journal.status !== 'committed' || journal.results === undefined || journal.results === null || typeof journal.results !== 'object') continue;
    for (const receipt of Object.values(journal.results)) {
      if (receipt === null || typeof receipt !== 'object' || receipt.owner !== 'pm-memory-policy-ownership:1' || !Array.isArray(receipt.targets)) continue;
      const target = receipt.targets.find(target => validOwnedTarget(target) && target.id === item.id);
      if (target !== undefined) return retained(target);
    }
  }
  const created = await creationMetadata(store, item.id);
  if (created?.memory_source === 'portable:policy-v1') {
    try {
      const [row, body] = JSON.parse(Buffer.from(String(created.memory_original), 'base64').toString('utf8')) as [PortableGuidance, string];
      return retained({ fields: portableFields(row, body), relationships: resolvedRelationships(row.relationships, ids) });
    } catch { return undefined; }
  }
  if (typeof created?.memory_source === 'string' && created.memory_source.endsWith(':relative-file')) {
    const born = await legacyBirth(store, item.id, created);
    if (born !== undefined) return { ...retained(born), creation: true };
  }
  return undefined;
}
