/** Invalidate content or pin verification atomically; other operational patches retain age and evidence. */
export function contentRevision(options: Record<string, unknown>, at = new Date().toISOString(), baseAt?: string): void {
  if (Object.keys(options).length === 0) return;
  const content = ['title', 'description', 'body', 'tags', 'memoryKind', 'memoryWhy', 'memoryHow', 'memoryDocument', 'memoryPolicyBody', 'memoryOriginal'];
  const removed = ['title', 'description', 'body', 'tags', 'memory_kind', 'memory_why', 'memory_how', 'memory_document', 'memory_policy_body', 'memory_original'];
  if (baseAt !== undefined && !Object.keys(options).some(key => content.includes(key)) && !(options.unset as string[] | undefined ?? []).some(key => removed.includes(key))) {
    if (!Object.hasOwn(options, 'memoryPinned') && !(options.unset as string[] | undefined ?? []).includes('memory_pinned')) return;
    at = baseAt;
  }
  delete options.memoryVerifiedAt; delete options.memoryReason;
  Object.assign(options, { memoryChangedAt: at, memoryVerdict: 'unknown' });
  options.unset = [...new Set([...(options.unset as string[] | undefined ?? []), 'memory_verified_at', 'memory_reason'])];
}
