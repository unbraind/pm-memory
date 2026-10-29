/** Revise content recency and invalidate prior verification in the same SDK item write. */
export function contentRevision(options: Record<string, unknown>, at = new Date().toISOString()): void {
  if (Object.keys(options).length === 0) return;
  delete options.memoryVerifiedAt; delete options.memoryReason;
  Object.assign(options, { memoryChangedAt: at, memoryVerdict: 'unknown' });
  options.unset = [...new Set([...(options.unset as string[] | undefined ?? []), 'memory_verified_at', 'memory_reason'])];
}
