import { isDeepStrictEqual } from 'node:util';
import { applyTagRemovals, mergeAdditiveTags, parseTags } from '@unbrained/pm-cli/sdk';

/** Guidance options and their persisted native field names. */
const guidance = {
  title: 'title', description: 'description', body: 'body', tags: 'tags',
  memoryKind: 'memory_kind', memoryWhy: 'memory_why', memoryHow: 'memory_how',
} as const;
const fields = new Set<string>(Object.values(guidance));

/** Split the string assignments used by the SDK for registered memory fields. */
function fieldAssignment(raw: string): [string, string] {
  const assignment = raw.trim();
  const separator = assignment.indexOf('=');
  return [assignment.slice(0, separator).trim(), assignment.slice(separator + 1)];
}

/** Identify guidance from the SDK's canonical changed field names. */
export function isGuidanceField(field: string): boolean { return fields.has(field); }

/** Use a strictly later content timestamp even when the wall clock repeats or moves backward. */
export function nextContentTimestamp(at: string, previous?: unknown): string {
  const prior = Date.parse(String(previous));
  return Date.parse(at) <= prior ? new Date(prior + 1).toISOString() : at;
}

/** Invalidate content or pin verification atomically; other operational patches retain age and evidence. */
export function contentRevision(options: Record<string, unknown>, at = new Date().toISOString(), baseAt?: string): void {
  if (Object.keys(options).length === 0) return;
  const unset = options.unset as string[] | undefined ?? [];
  const changed = Object.keys(options).some(key => Object.hasOwn(guidance, key)) || unset.some(isGuidanceField);
  if (!changed && !Object.hasOwn(options, 'memoryPinned') && !unset.includes('memory_pinned')) return;
  invalidateVerification(options, changed ? nextContentTimestamp(at, baseAt) : baseAt ?? at);
}

/** Include verification invalidation in the same native update. */
function invalidateVerification(options: Record<string, unknown>, at: string): void {
  delete options.memoryVerifiedAt;
  delete options.memoryReason;
  delete options.memory_verified_at;
  delete options.memory_reason;
  delete options.memory_changed_at;
  delete options.memory_verdict;
  const fields = options.field as string[] | undefined;
  if (fields !== undefined) options.field = fields.filter(raw => {
    const [field] = fieldAssignment(raw);
    return !['memory_changed_at', 'memory_verdict', 'memory_verified_at', 'memory_reason'].includes(field);
  });
  Object.assign(options, { memoryChangedAt: at, memoryVerdict: 'unknown' });
  options.unset = [...new Set([...(options.unset as string[] | undefined ?? []), 'memory_verified_at', 'memory_reason'])];
}

/** Compare the complete tag proposal after applying the native collection rules. */
function changesTags(options: Record<string, unknown>, stored: unknown): boolean {
  if (options.tags === undefined && options.addTags === undefined && options.removeTags === undefined) return false;
  const raw = typeof options.tags === 'string' ? options.tags : JSON.stringify(options.tags);
  const tags = raw === undefined ? stored as string[] : parseTags(raw);
  const added = mergeAdditiveTags(tags, options.addTags as string[] | undefined);
  return !isDeepStrictEqual(applyTagRemovals(added, options.removeTags as string[] | undefined), stored);
}

/** Detect explicitly supplied guidance, including native field and transport aliases. */
function changesGuidance(options: Record<string, unknown>, before: Record<string, unknown>): boolean {
  const unset = (options.unset as string[] | undefined ?? []).flatMap(value => value.split(','))
    .map(value => value.trim().toLowerCase().replaceAll('-', '_'));
  const assignments = new Map((options.field as string[] | undefined ?? []).map(fieldAssignment));
  return Object.entries(guidance).some(([option, field]) => {
    const stored = before[field];
    if (unset.includes(field) && stored !== undefined) return true;
    if (field === 'tags') return changesTags(options, stored);
    const value = assignments.get(field) ?? options[option];
    if (field === 'title' && typeof value === 'string') return value.trim() !== stored;
    return value !== undefined && value !== stored;
  });
}

/** Preserve the content timestamp of a prepared receipt and ignore identical native guidance. */
export function nativeContentRevision(options: Record<string, unknown>, before: Record<string, unknown>): boolean {
  if (!changesGuidance(options, before)) return false;
  const previous = before.memory_changed_at ?? before.created_at;
  const prepared = options.memoryChangedAt;
  const at = typeof prepared === 'string' && Date.parse(prepared) > Date.parse(String(previous))
    ? prepared : nextContentTimestamp(new Date().toISOString(), previous);
  invalidateVerification(options, at);
  return true;
}
