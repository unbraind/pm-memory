import { defineExtension } from '@unbrained/pm-cli/sdk/authoring';
import { register } from './src/commands.ts';
/** Create or revise durable memory and retrieve bounded context packets. */
export { remember, recall, index } from './src/memory.ts';
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
