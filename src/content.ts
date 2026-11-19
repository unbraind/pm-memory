/** Guidance options and their persisted native field names. */
const guidance = {
  title: 'title', description: 'description', body: 'body', tags: 'tags',
  memoryKind: 'memory_kind', memoryWhy: 'memory_why', memoryHow: 'memory_how',
} as const;
const fields = new Set<string>(Object.values(guidance));

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
  Object.assign(options, { memoryChangedAt: at, memoryVerdict: 'unknown' });
  options.unset = [...new Set([...(options.unset as string[] | undefined ?? []), 'memory_verified_at', 'memory_reason'])];
}

/** Detect explicitly supplied guidance, including native field and transport aliases. */
function changesGuidance(options: Record<string, unknown>, before: Record<string, unknown>): boolean {
  const unset = options.unset as string[] | undefined ?? [];
  const fields = options.field as string[] | undefined ?? [];
  return Object.entries(guidance).some(([option, field]) => {
    const value = options[option];
    return (value !== undefined && value !== before[field]) || (unset.includes(field) && before[field] !== undefined);
  }) || options.bodyFile !== undefined || options.stdinJson === true
    || options.addTags !== undefined || options.removeTags !== undefined
    || fields.some(value => isGuidanceField(value.split('=')[0]));
}

/** Preserve the content timestamp of a prepared receipt and ignore identical native guidance. */
export function nativeContentRevision(options: Record<string, unknown>, before: Record<string, unknown>): void {
  if (!changesGuidance(options, before)) return;
  const previous = before.memory_changed_at ?? before.created_at;
  const prepared = options.memoryChangedAt;
  const at = typeof prepared === 'string' && Date.parse(prepared) > Date.parse(String(previous))
    ? prepared : nextContentTimestamp(new Date().toISOString(), previous);
  invalidateVerification(options, at);
}
