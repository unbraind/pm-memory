import { createHash } from 'node:crypto';
import { estimatePmOutputTokens, tokenizeSimilarityText, jaccardSimilarity } from '@unbrained/pm-cli/sdk';
import { encode } from '@toon-format/toon';
import { KINDS } from './types.ts';
import type { MemoryKind, Packet } from './types.ts';

/** Typed refusal with a safe, actionable remedy; offending content is never echoed. */
export class MemoryError extends Error {
  /** Machine-readable refusal category. */
  readonly code: string;
  /** Safe next action for callers. */
  readonly remedy: string;
  /** Bind a safe diagnostic and an explicit remedy. */
  constructor(code: string, message: string, remedy: string) {
    super(message); this.code = code; this.remedy = remedy;
  }
}
/** Validate nonblank string input without coercing structured data. */
export function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new MemoryError('invalid', 'Expected nonblank text', 'Supply the required text operand');
  return value;
}
/** Validate the semantic class before any tracker writes. */
export function kind(value: unknown): MemoryKind {
  if (!KINDS.includes(value as MemoryKind)) throw new MemoryError('invalid', 'Unsupported memory kind', 'Use user, feedback, project or reference');
  return value as MemoryKind;
}
/** Validate a finite positive token budget before any tracker writes. */
export function budget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new MemoryError('budget', 'Invalid token budget', 'Use a positive integer budget large enough for the receipt');
  return value;
}
/** Stable lower-case key generation and validation, independent of local paths. */
export function slug(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/.test(value)) throw new MemoryError('invalid', 'Invalid memory slug', 'Use up to 120 lower-case letters, digits, underscores or hyphens');
  return value;
}
/** Content-address a new key without leaking the fact into item identifiers. */
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
/** Refuse credentials, private keys and unapproved email addresses before persistence. */
export function privacy(value: string, allowEmail = false): void {
  const secret = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk|pk|rk)-(?:proj-)?[a-z0-9_-]{16,}|\b(?:gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b|\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i;
  const assignments = [...value.matchAll(/\b(password|passwd|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|token)\b\s*(=|:)\s*["']?([^\s"'`<>]{8,})/gi)];
  const literal = assignments.some(([, name, separator, assigned]) => {
    if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.test(assigned)) return false;
    return !(name.toLowerCase() === 'token' && separator === ':' && /^[a-z]{8,19}[.,;:]?$/.test(assigned));
  });
  if (secret.test(value) || literal || credentialJwt(value) || credentialUrl(value)) throw new MemoryError('privacy', 'Credential-shaped memory refused', 'Remove credentials and reference a secret manager instead');
  if (!allowEmail && /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}\b/i.test(value)) throw new MemoryError('privacy', 'Email address refused', 'Remove addresses or explicitly use --allow-email');
}
/** Consume each JWT header run once and anchor the remaining segments without restarting. */
function credentialJwt(value: string): boolean {
  const tail = /[a-z0-9_-]{12,}\.[a-z0-9_-]{8,}\b/iy;
  for (const match of value.matchAll(/\beyJ[a-z0-9_-]*/gi)) {
    const end = match.index + match[0].length;
    if (match[0].length < 15 || value[end] !== '.') continue;
    tail.lastIndex = end + 1;
    if (tail.test(value)) return true;
  }
  return false;
}
/** Scan each URL authority once; delimiter positions avoid ambiguous regex backtracking. */
function credentialUrl(value: string): boolean {
  for (const match of value.matchAll(/:\/\/[^\s/?#]+/g)) {
    const authority = match[0].slice(3);
    const colon = authority.indexOf(':'); const at = authority.lastIndexOf('@');
    if (colon >= 0 && at > colon + 1) return true;
  }
  return false;
}
/** Normalize both heading and body through the host's Unicode-aware primitives. */
export function words(value: string): Set<string> { return new Set(tokenizeSimilarityText(value)); }
/** Inclusive Jaccard similarity across normalized title and body tokens. */
export function similarity(left: string, right: string): number { return jaccardSimilarity([...words(left)], [...words(right)]); }
/** Measure the full output, including its final newline, using the host's UTF-8 estimator. */
export function packetTokens(value: unknown): number {
  return estimatePmOutputTokens(Math.max(Buffer.byteLength(JSON.stringify(value, null, 2) + '\n'), Buffer.byteLength(encode(value) + '\n')));
}
/** Stabilize the self-accounting receipt before deciding whether a candidate fits. */
export function accounted(packet: Packet): Packet {
  let count = packetTokens(packet);
  while (count !== packet.estimated_tokens) { packet.estimated_tokens = count; count = packetTokens(packet); }
  return packet;
}
/** Pack complete ranked rows or markdown lines, counting every envelope and omission byte. */
export function pack<T>(rows: readonly T[], limit: number, render: (selected: T[], omitted: number) => Omit<Packet, 'estimated_tokens'>): Packet {
  budget(limit);
  const selected: T[] = [];
  let result = accounted({ ...render(selected, rows.length), estimated_tokens: 0 });
  if (result.estimated_tokens > limit) throw new MemoryError('budget', 'Budget cannot hold the omission receipt', 'Increase --budget');
  for (const row of rows) {
    const next = accounted({ ...render([...selected, row], rows.length - selected.length - 1), estimated_tokens: 0 });
    if (next.estimated_tokens <= limit) { selected.push(row); result = next; }
  }
  return result;
}
