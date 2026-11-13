/** Serialize one object without throwing on cycles; nested objects are walked separately. */
function safeJson(value: object): string {
  try { return JSON.stringify(value); } catch { return Object.entries(value).map(([key, child]) => `${key}=${typeof child === 'object' ? '[object]' : String(child)}`).join(' '); }
}
/** Inspect non-enumerable cause messages and nested aggregates without looping on cyclic errors. */
export function causeDiagnostics(value: unknown): string {
  const pending = [value]; const seen = new Set<unknown>(); const messages: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    // Plain objects render as [object Object], so serialize them and walk their values too.
    messages.push(typeof current === 'object' && current !== null && !(current instanceof Error) ? safeJson(current) : String(current));
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
    if (current instanceof AggregateError) for (const error of current.errors) pending.push(error);
    if (typeof current === 'object' && current !== null) for (const child of Object.values(current)) if (typeof child === 'object' && child !== null) pending.push(child);
  }
  return messages.join('\n');
}
/** Preserve enumerable refusal fields while also inspecting non-enumerable nested Error messages. */
export function refusalDiagnostics(error: Error & { remedy?: string }): string {
  return JSON.stringify({ message: error.message, remedy: error.remedy, cause: error.cause }) + causeDiagnostics(error.cause);
}
