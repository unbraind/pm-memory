import { randomBytes } from 'node:crypto';
import type { Memory, MemoryOptions, Packet } from './types.ts';
import { accounted, budget, digest, MemoryError, slug, text } from './core.ts';
import { active, scored } from './memory.ts';
import { eligibleGuidance } from './guidance.ts';
import { memoryRevision } from './utility.ts';
import { Store } from './store.ts';

/** The only content fields a source can authorize for a purpose. */
export const VIEW_FIELDS = ['title', 'description', 'body', 'why', 'how'] as const;
/** A content field subject to explicit minimization. */
export type ViewField = typeof VIEW_FIELDS[number];
/** Current source authorization, bound to the exact semantic revision. */
export interface ConsentPolicy {
  /** Opaque purpose identifier; never free-form evidence. */
  purpose: string;
  /** Monotonic policy version; withdrawal and regrant both advance it. */
  revision: number;
  /** Exact authorized source revision, retained as a digest only. */
  content: string;
  /** Empty after withdrawal. */
  fields: ViewField[];
}
/** Text-free lineage for one source appearance in an output. */
export interface ViewSource {
  /** Native source identity, without its title or slug. */
  id: string;
  /** Policy revision which authorized the appearance. */
  revision: number;
  /** Fields actually disclosed. */
  fields: ViewField[];
}
/** Portable manifest; contains no source text or query. */
export interface ViewManifest {
  /** Opaque output identity. */
  packet: string;
  /** Explicit purpose identifier. */
  purpose: string;
  /** Only sources actually emitted within the budget. */
  sources: ViewSource[];
}
/** Budgeted result with no unapproved content fields. */
export interface ViewPacket extends Packet {
  /** Text-free provenance included in token accounting. */
  manifest: ViewManifest;
  /** Minimized content; native identity is the only implicit field. */
  rows: { id: string; fields: Partial<Record<ViewField, string>> }[];
  /** Sources excluded by missing, withdrawn, stale or insufficient consent. */
  excluded: number;
}
/** Purpose and requested fields are always explicit. */
export interface ViewOptions extends MemoryOptions {
  /** Opaque purpose identifier. */
  purpose: string;
  /** Required subset of authorized content fields. */
  fields: readonly ViewField[];
  /** Whole-packet token ceiling, including its manifest. */
  budget?: number;
}
/** Durable policy and lineage; never stores recalled content or query text. */
export interface ConsentLedger {
  /** Persisted format version. */
  version: 1;
  /** Independent authorization for each declared purpose. */
  policies: ConsentPolicy[];
  /** Prior outputs retained for withdrawal propagation. */
  outputs: { packet: string; purpose: string; revision: number; fields: ViewField[] }[];
}
/** Safe refusal for malformed authorization metadata. */
function invalidConsent(): never { throw new MemoryError('consent', 'Invalid memory consent metadata', 'Inspect native history and restore valid consent metadata through an audited update'); }
/** Narrow untrusted JSON to a plain object. */
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** Match identifiers without echoing their rejected contents. */
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value); }
/** Validate a canonical unique field list, including a withdrawn empty list. */
function fieldList(value: unknown): value is ViewField[] { return Array.isArray(value) && value.every(field => VIEW_FIELDS.includes(field)) && new Set(value).size === value.length; }
/** Require an explicit, safe purpose identifier at the authorization boundary. */
export function viewPurpose(value: unknown): string {
  if (!identifier(value)) throw new MemoryError('consent', 'Invalid recall purpose', 'Supply a lowercase purpose identifier of 1-64 letters, digits or hyphens');
  return value;
}
/** Validate requested fields before reading or mutating any source. */
export function viewFields(value: unknown): ViewField[] {
  if (!fieldList(value) || value.length === 0) throw new MemoryError('consent', 'Explicit content fields are required', `Choose unique fields from ${VIEW_FIELDS.join(',')}`);
  return [...value].sort();
}
/** Decode fail-closed policy metadata, refusing partial or ambiguous ledgers. */
export function readConsent(raw: string | undefined): ConsentLedger {
  if (raw === undefined) return { version: 1, policies: [], outputs: [] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalidConsent(); }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.policies) || !Array.isArray(value.outputs)) return invalidConsent();
  const policies: ConsentPolicy[] = [];
  for (const policy of value.policies) {
    if (!object(policy) || !identifier(policy.purpose) || !Number.isSafeInteger(policy.revision) || Number(policy.revision) < 1 || typeof policy.content !== 'string' || !/^[a-f0-9]{64}$/.test(policy.content) || !fieldList(policy.fields) || policies.some(entry => entry.purpose === policy.purpose)) return invalidConsent();
    policies.push({ purpose: policy.purpose, revision: Number(policy.revision), content: policy.content, fields: policy.fields });
  }
  const outputs: ConsentLedger['outputs'] = [];
  for (const output of value.outputs) {
    if (!object(output) || typeof output.packet !== 'string' || !/^[a-f0-9]{24}$/.test(output.packet) || !identifier(output.purpose) || !Number.isSafeInteger(output.revision) || Number(output.revision) < 1 || !fieldList(output.fields) || output.fields.length === 0 || !policies.some(policy => policy.purpose === output.purpose && policy.revision >= Number(output.revision)) || outputs.some(entry => entry.packet === output.packet)) return invalidConsent();
    outputs.push({ packet: output.packet, purpose: output.purpose, revision: Number(output.revision), fields: output.fields });
  }
  return { version: 1, policies, outputs };
}
/** Bind consent to semantic content and source provenance, independently of counters. */
function sourceRevision(memory: Memory): string { return digest(JSON.stringify([memoryRevision(memory), memory.source])); }
/** Resolve an explicit source even after archive, without leaking its content on failure. */
function source(memories: readonly Memory[], key: string): Memory {
  const item = memories.find(memory => memory.slug === key && !memory.artifact);
  if (item === undefined) throw new MemoryError('missing', 'Consent source does not exist', 'Select an existing memory slug; index artifacts cannot authorize recall');
  return item;
}
/** Change one purpose under the same lock used by all memory writers and recall. */
async function changeConsent(key: string, options: MemoryOptions & { purpose: string }, fields: ViewField[]): Promise<{ id: string; purpose: string; revision: number; affected: string[] }> {
  slug(key); const purpose = viewPurpose(options.purpose); const store = new Store(options);
  return store.write(async () => {
    const item = source(await store.read(), key); const ledger = readConsent(item.consent);
    const previous = ledger.policies.find(policy => policy.purpose === purpose);
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new MemoryError('consent', 'Consent revision exhausted', 'Create a new source identity before granting further consent');
    const affected = ledger.outputs.filter(output => output.purpose === purpose).map(output => output.packet);
    ledger.policies = ledger.policies.filter(policy => policy.purpose !== purpose);
    ledger.policies.push({ purpose, revision, content: sourceRevision(item), fields });
    await store.register(); await store.fields(item.id, { consent: JSON.stringify(ledger) });
    return { id: item.id, purpose, revision, affected };
  });
}
/** Explicitly authorize the current source revision and selected fields for a purpose. */
export async function grantConsent(key: string, options: MemoryOptions & { purpose: string; fields: readonly ViewField[] }) {
  return changeConsent(key, options, viewFields(options.fields));
}
/** Withdraw a purpose irreversibly for old outputs, preserving only text-free lineage. */
export async function withdrawConsent(key: string, options: MemoryOptions & { purpose: string }) { return changeConsent(key, options, []); }
/** Build and record minimized recall under the source-consent serialization boundary. */
export async function createView(query: string, options: ViewOptions): Promise<ViewPacket> {
  text(query); const purpose = viewPurpose(options.purpose); const fields = viewFields(options.fields); const limit = budget(options.budget ?? 800);
  const store = new Store(options);
  return store.write(async () => {
    const all = active(await store.read());
    const eligible = eligibleGuidance(all, 'exclude', Date.now());
    const candidates = eligible.flatMap(item => {
      const ledger = readConsent(item.consent); const policy = ledger.policies.find(policy => policy.purpose === purpose);
      if (policy === undefined || policy.content !== sourceRevision(item) || !fields.every(field => policy.fields.includes(field))) return [];
      // Rank only the requested, authorized fields: hidden fields cannot affect ordering.
      const projected: Memory = { ...item, slug: '', title: '', description: '', body: '', why: '', how: '', tags: [], pinned: false };
      for (const field of fields) projected[field] = item[field];
      return [{ item, projected, ledger, policy }];
    });
    const positions = new Map(candidates.map(candidate => [candidate.item.id, candidate]));
    const manifest: ViewManifest = { packet: randomBytes(12).toString('hex'), purpose, sources: [] };
    let packet: ViewPacket = { manifest, rows: [], excluded: all.length - candidates.length, omitted: candidates.length, complete: true, estimated_tokens: 0 };
    packet.estimated_tokens = accounted(packet).estimated_tokens;
    if (packet.estimated_tokens > limit) throw new MemoryError('budget', 'Budget cannot hold the consent manifest', 'Increase --budget');
    for (const row of scored(candidates.map(candidate => candidate.projected), query)) {
      const candidate = positions.get(row.item.id)!;
      const next: ViewPacket = { ...packet, rows: [...packet.rows, { id: candidate.item.id, fields: Object.fromEntries(fields.map(field => [field, candidate.item[field]])) }], manifest: { ...manifest, sources: [...packet.manifest.sources, { id: candidate.item.id, revision: candidate.policy.revision, fields }] }, omitted: packet.omitted - 1, estimated_tokens: 0 };
      next.estimated_tokens = accounted(next).estimated_tokens;
      if (next.estimated_tokens > limit) break;
      packet = next;
    }
    // A failed partial metadata write emits no packet; conservative lineage may remain.
    for (const emitted of packet.manifest.sources) {
      const candidate = positions.get(emitted.id)!;
      candidate.ledger.outputs.push({ packet: manifest.packet, purpose, revision: emitted.revision, fields });
      await store.fields(emitted.id, { consent: JSON.stringify(candidate.ledger) });
    }
    return packet;
  });
}
/** Recheck a prior nonempty packet against current policies without reproducing its text. */
export async function inspectView(packet: string, options: MemoryOptions): Promise<{ packet: string; sources: number; affected: string[]; complete: true }> {
  if (!/^[a-f0-9]{24}$/.test(packet)) throw new MemoryError('consent', 'Invalid packet identifier', 'Supply the packet identifier from a view manifest');
  const store = new Store(options);
  return store.write(async () => {
    let sources = 0; const affected: string[] = [];
    for (const item of await store.read()) {
      const ledger = readConsent(item.consent); const output = ledger.outputs.find(output => output.packet === packet);
      if (output === undefined) continue;
      sources++;
      const policy = ledger.policies.find(policy => policy.purpose === output.purpose)!;
      if (item.status === 'canceled' || policy.revision !== output.revision || policy.content !== sourceRevision(item) || !output.fields.every(field => policy.fields.includes(field))) affected.push(item.id);
    }
    if (sources === 0) throw new MemoryError('missing', 'No retained sources for this packet', 'Use a nonempty packet manifest; retain the portable manifest if sources are deleted');
    return { packet, sources, affected, complete: true };
  });
}
