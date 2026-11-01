import assert from 'node:assert/strict';

/** Independent public content-revision contract; never import production revision or ownership helpers here. */
export function referenceRevision(action: Record<string, unknown>, before: Record<string, unknown>, at: string): boolean {
  const content = Object.keys(action).some(key => ['body', 'title', 'description', 'tags', 'memoryKind', 'memoryWhy', 'memoryHow'].includes(key)) || (action.unset as string[] | undefined ?? []).some(key => ['body', 'title', 'description', 'tags', 'memory_kind', 'memory_why', 'memory_how'].includes(key));
  const pin = Object.hasOwn(action, 'memoryPinned') || (action.unset as string[] | undefined ?? []).includes('memory_pinned');
  if (content || pin) {
    action.memoryVerdict = 'unknown';
    action.memoryChangedAt = content ? at : before.memory_changed_at ?? before.created_at;
    action.unset = [...new Set([...(action.unset as string[] | undefined ?? []), 'memory_verified_at', 'memory_reason'])];
  }
  return content;
}

/** Compare content clocks only to their own execution interval, never as identity or a conflict oracle. */
export function assertRevisionClock(item: Record<string, unknown>, changed: boolean, start: number, end: number, label: string): void {
  if (!changed) return;
  const clock = Date.parse(String(item.memory_changed_at));
  assert.ok(clock >= start && clock <= end, `${label}: content revision must be renewed during import`);
  assert.equal(item.memory_verdict, 'unknown', label);
  assert.equal(item.memory_verified_at, undefined, label); assert.equal(item.memory_reason, undefined, label);
}
