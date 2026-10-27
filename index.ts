import { defineExtension } from '@unbrained/pm-cli/sdk/authoring';
import { register } from './src/commands.ts';
/** Create or revise durable memory and retrieve bounded context packets. */
export { remember, recall, index, get } from './src/memory.ts';
/** Import and export portable harness files through native Knowledge items. */
export { importDir, exportDir } from './src/transfer.ts';
/** Check concrete memory claims against local and optional network evidence. */
export { verify } from './src/verify.ts';
/** Preview or explicitly apply non-destructive memory consolidation. */
export { consolidate } from './src/consolidate.ts';
/** Inspect typed refusals and full-packet host token accounting. */
export { MemoryError, packetTokens } from './src/core.ts';
/** Public typed harness, memory and receipt contracts. */
export type { MemoryOptions, RememberOptions, MemoryKind, Harness, Memory, Packet, RecallRow, Verdict, Claim, ClaimResult, Proposal } from './src/types.ts';
/** Activate memory commands and registered Knowledge fields in any pm host. */
export default defineExtension({ name: 'pm-memory', version: '2026.10.19', description: 'Shared long-term agent memory as typed pm context', activate: register });

/** Local embedding adapters and opt-in provider contracts. */
export { OllamaProvider, LexicalProvider, EmbeddingInputError } from './src/embeddings.ts';
export type { EmbeddingProvider, EmbeddingPurpose, SemanticMode, SemanticOptions } from './src/embeddings.ts';

/** Record explicit memory feedback and inspect auditable outcome denominators. */
export { observe, utility } from './src/utility.ts';
/** Public outcome, attribution, observation and utility evidence contracts. */
export type { TaskOutcome, Attribution, ObserveOptions, MemoryExposure, MemoryObservation, UtilityLedger, UtilityCounts, UtilityReport } from './src/utility-types.ts';
/** Renew standing guidance with explicit validity bounds and attributable evidence. */
export { renew, guidanceState } from './src/guidance.ts';
export type { GuidanceWindow, GuidanceState, GuidanceOptions, RenewOptions } from './src/types.ts';

/** Authorize purpose-limited recall, withdraw consent and inspect text-free output lineage. */
export { grantConsent, withdrawConsent, createView, inspectView, VIEW_FIELDS } from './src/consent.ts';
export type { ViewField, ConsentPolicy, ConsentLedger, ViewSource, ViewManifest, ViewPacket, ViewOptions } from './src/consent.ts';

/** Versioned portable policy metadata and validated atomic import contracts. */
export { POLICY_MANIFEST, parsePolicy } from './src/portable.ts';
export type { PortableRelationship, PortableGuidance, PortablePolicyManifest, PortableImportOptions, PortableImportResult, PortableExportResult, PortableLossyField } from './src/portable.ts';
/** Immutable portable ownership metadata used by selective harness updates. */
export type { PortableBaseline, PortableFields } from './src/portable-ownership.ts';

/** Immutable origin and byte-preserved legacy companion contracts. */
export { LEGACY_ORIGINS, parseLegacyOrigins } from './src/transfer.ts';
export type { LegacyOriginManifest, LegacyOriginRecord } from './src/transfer.ts';
export type { PortableOrigin } from './src/portable-origin.ts';
