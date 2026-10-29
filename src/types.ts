import type { PmClient, Dependency } from '@unbrained/pm-cli/sdk';

/** Supported semantic memory classes shared by every harness. */
export const KINDS = ['user', 'feedback', 'project', 'reference'] as const;
/** One supported memory class. */
export type MemoryKind = typeof KINDS[number];
/** A supported memory import harness. */
export type Harness = 'claude-code' | 'agents-md' | 'cursor';
/** Exact editable document, independent of native semantic fields and birth bookkeeping. */
export interface HarnessDocument {
  /** Version of the complete-byte representation. */
  version: 1;
  /** Parser and exporter for the source bytes. */
  harness: Harness;
  /** Legacy stores the full file; policy stores exact body bytes framed by retained legacy metadata. */
  format: 'legacy' | 'policy';
  /** Confined source file name. */
  path: string;
  /** Every source byte, encoded without changing order, keys or whitespace. */
  original: string;
}
/** A memory claim's current evidence state. */
export type Verdict = 'verified' | 'stale' | 'unknown';
/** Explicit tracker binding; no ancestor tracker discovery is performed. */
export interface MemoryOptions {
  /** Initialized pm tracker directory. */
  workspace: string;
  /** Attributable mutation identity. */
  author?: string;
  /** Host-bound client preserving native attribution and mutation policy. */
  client?: PmClient;
}
/** Inputs accepted by the remember API. */
export interface RememberOptions extends MemoryOptions {
  /** Required semantic memory class. */
  kind: MemoryKind;
  /** Stable unique key; an existing key updates its item. */
  slug?: string;
  /** Explicit existing key to revise. */
  update?: string;
  /** Rationale retained for retrieval. */
  why?: string;
  /** Application instructions retained for retrieval. */
  how?: string;
  /** Standing guidance receives ranking priority. */
  pin?: boolean;
  /** Native item identifiers or memory slugs to relate. */
  links?: string[];
  /** Explicitly permit a distinct similar item. */
  forceNew?: boolean;
  /** Permit email addresses, but never credentials. */
  allowEmail?: boolean;
  /** Additional lexical search terms. */
  tags?: string[];
}
/** Complete projection of one validated Knowledge item. */
export interface Memory {
  /** Latest complete harness document, persisted through SDK item mutations. */
  document?: HarnessDocument;
  /** Exact policy payload bytes; a changed native body supersedes a stale representation. */
  policyBody?: HarnessDocument;
  /** Native pm item identity. */
  id: string;
  /** Encoded source consent and text-free output lineage; absence is legacy unscoped data. */
  consent?: string;
  /** Legacy import digest retained for read compatibility; it grants no field ownership. */
  importSnapshot?: string;
  /** Latest evidence-backed policy window, if explicitly bounded. */
  validity?: GuidanceWindow;
  /** Stable memory key. */
  slug: string;
  /** Imported description or native retrieval hook. */
  description: string;
  /** Confident stale evidence retained for consolidation. */
  reason?: string;
  /** Short human-facing heading. */
  title: string;
  /** Complete semantic memory content. */
  body: string;
  /** Semantic class. */
  kind: MemoryKind;
  /** Rationale. */
  why: string;
  /** Application instructions. */
  how: string;
  /** Standing guidance. */
  pinned: boolean;
  /** Harness and relative path class. */
  source: string;
  /** Last content-change time, independent of recall and verification writes. */
  updated: string;
  /** Durable pending merge receipt; empty after completion. */
  merge: string;
  /** Number of emitted recall appearances. */
  recalls: number;
  /** Evidence state. */
  verdict: Verdict;
  /** Native lifecycle state. */
  status: string;
  /** SDK registry cancellation for a custom status; the native status id is retained. */
  canceled?: boolean;
  /** Searchable tags. */
  tags: string[];
  /** Safe relative import name, retained only for export. */
  path: string;
  /** Exact original bytes encoded as text. */
  original: string;
  /** Original content must be regenerated after a semantic edit. */
  edited: boolean;
  /** Directory indexes are lossless artifacts rather than facts. */
  artifact: boolean;
  /** Complete typed native edges retained by portable policy transfers. */
  relationships: Dependency[];
  /** Native relationship targets used by generated export. */
  links: string[];
  /** Native supersession targets, distinct from general related links. */
  supersedes?: string[];
}
/** A ranked, bounded recall row. */
export interface RecallRow {
  /** Latest-window status; absent on legacy unbounded memories. */
  validity?: GuidanceState;
  /** Inclusive validity start, present with a status label. */
  valid_from?: string;
  /** Exclusive validity end, present with a status label. */
  valid_until?: string;
  /** Origin label distinguishing native guidance from imported content. */
  source?: string;
  /** Stable key usable with --update. */
  slug: string;
  /** Heading. */
  title?: string;
  /** Semantic memory class. */
  kind?: MemoryKind;
  /** Standing guidance indicator. */
  pinned?: boolean;
  /** Compact retrieval hook. */
  description?: string;
  /** Deterministic ranking score. */
  score?: number;
  /** Query-centered excerpt. */
  text?: string;
}
/** A whole response measured in both native host encodings. */
export interface Packet {
  /** Durable receipt for feedback on emitted memories, included in token accounting. */
  recall?: string;
  /** One-line semantic fallback diagnostic, included in token accounting. */
  note?: string;
  /** Estimated tokens including envelope and receipt. */
  estimated_tokens: number;
  /** Memories removed by the declared budget. */
  omitted: number;
  /** Completeness of the underlying SDK read. */
  complete: true;
  /** Ranked recall rows, absent for indexes. */
  memories?: RecallRow[];
  /** Markdown index with terminal omission receipt. */
  text?: string;
}
/** Claim extractor output; values are never shell-interpolated. */
export interface Claim {
  /** Evidence checker to invoke. */
  type: 'file' | 'symbol' | 'flag' | 'package' | 'url' | 'repo';
  /** Exact extracted claim. */
  value: string;
  /** Conservative context marker for nonasserted path mentions. */
  uncertainty?: string;
  /** Home anchoring retained without storing an absolute path. */
  home?: boolean;
  /** Source-file context for otherwise ambiguous symbols. */
  context?: string;
}
/** A checkable claim and its evidence state. */
export interface ClaimResult extends Claim {
  /** Result of local or optional network checking. */
  verdict: Verdict;
  /** Evidence or uncertainty explanation, required on stale claims. */
  reason?: string;
}
/** One auditable consolidation operation. */
export interface Proposal {
  /** Semantic candidates are advisory and cannot be applied automatically. */
  previewOnly?: true;
  /** Duplicate merge, contradictory supersession, or unused stale archive. */
  action: 'merge' | 'supersedes' | 'archive';
  /** Older or archived memory key. */
  slug: string;
  /** Surviving or superseding memory key. */
  target?: string;
  /** Deterministic reason for the proposal. */
  reason: string;
}

/** The latest evidence-backed policy window; earlier revisions remain in native history. */
export interface GuidanceWindow {
  /** Inclusive UTC instant. */
  from: string;
  /** Exclusive UTC instant. */
  until: string;
  /** Human-supplied renewal evidence, not an automatic truth attestation. */
  evidence: string;
  /** Actual renewal time; distinct from content recency and verification. */
  recordedAt: string;
  /** Digest binding the evidence to semantic content. */
  contentHash: string;
  /** Monotonic revision serialized across concurrent writers. */
  revision: number;
}
/** Status of the latest authored window at retrieval time. */
export type GuidanceState = 'current' | 'scheduled' | 'expired' | 'needs-renewal';
/** Explicit retrieval policy; label includes historical advice for auditing. */
export interface GuidanceOptions {
  /** Exclude noncurrent guidance by default; label includes it with its status. */
  validity?: 'exclude' | 'label';
}
/** Required evidence and explicit bounds for creating or renewing a policy window. */
export interface RenewOptions extends MemoryOptions {
  /** Inclusive UTC timestamp, in YYYY-MM-DDTHH:mm:ss.sssZ format. */
  from: string;
  /** Exclusive UTC timestamp, later than from. */
  until: string;
  /** Evidence explaining why this version of the guidance is valid. */
  evidence: string;
}
