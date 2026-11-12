/** Inspect non-enumerable cause messages and nested aggregates without looping on cyclic errors. */
export function causeDiagnostics(value: unknown): string {
  const pending = [value]; const seen = new Set<unknown>(); const messages: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current); messages.push(String(current));
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
    if (current instanceof AggregateError) for (const error of current.errors) pending.push(error);
  }
  return messages.join('\n');
}
