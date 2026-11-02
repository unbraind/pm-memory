/** Invalidate content or pin verification atomically; other operational patches retain age and evidence. */
export function contentRevision(options: Record<string, unknown>, at = new Date().toISOString(), baseAt?: string): void {
  if (Object.keys(options).length === 0) return;
  const content = ['title', 'description', 'body', 'tags', 'memoryKind', 'memoryWhy', 'memoryHow'];
  const removed = ['title', 'description', 'body', 'tags', 'memory_kind', 'memory_why', 'memory_how'];
  const changed = Object.keys(options).some(key => content.includes(key)) || (options.unset as string[] | undefined ?? []).some(key => removed.includes(key));
  if (!changed) {
    if (!Object.hasOwn(options, 'memoryPinned') && !(options.unset as string[] | undefined ?? []).includes('memory_pinned')) return;
    if (baseAt !== undefined) at = baseAt;
  }
  delete options.memoryVerifiedAt; delete options.memoryReason;
  Object.assign(options, { memoryChangedAt: at, memoryVerdict: 'unknown' });
  options.unset = [...new Set([...(options.unset as string[] | undefined ?? []), 'memory_verified_at', 'memory_reason'])];
}
