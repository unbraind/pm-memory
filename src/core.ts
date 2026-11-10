import { createHash } from 'node:crypto';
import { estimatePmOutputTokens, tokenizeSimilarityText, jaccardSimilarity, scanMutationSecrets } from '@unbrained/pm-cli/sdk';
import type { SecretGuardFinding } from '@unbrained/pm-cli/sdk';
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
  constructor(code: string, message: string, remedy: string, options?: ErrorOptions) {
    super(message, options); this.code = code; this.remedy = remedy;
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
  for (const view of credentialViews(value)) {
    let literalSuffix = false;
    // Environment references carry no literal value. The SDK's npm/password rules
    // deliberately flag these forms, so mask whole reference assignments only at a value boundary.
    const literals = view.replace(/(\b(?:password|passphrase|passwd|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|token|_authToken)\b\s*[=:]\s*["']?)\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/gi, (match: string, prefix: string, offset: number) => {
      const end = offset + match.length;
      // A reference may carry bounded explanatory prose, but an arbitrary suffix
      // must retain the assignment key. Check its closing boundary in the full view.
      const explanation = view[end] === '(' ? /^\([A-Za-z]+(?: [A-Za-z,.'-]+)+\)/.exec(view.slice(end, end + 200)) : null;
      const following = view[end + (explanation?.[0].length ?? 0)];
      const boundary = following === undefined || /[\s"'`;,)}\]]/.test(following);
      if (view[end] === '(' && !boundary) literalSuffix = true;
      return boundary ? 'environment reference ' : prefix;
    });
    if (literalSuffix || sharedCredential(literals) || supplementalCredential(literals)) throw new MemoryError('privacy', 'Credential-shaped memory refused', 'Remove credentials and reference a secret manager instead');
  }
  if (!allowEmail && value.includes('@') && /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}\b/i.test(value)) throw new MemoryError('privacy', 'Email address refused', 'Remove addresses or explicitly use --allow-email');
}
/** Return the preserved privacy refusal, rethrowing any failure that is not one so defects never masquerade as policy. */
export function privacyRefusal(error: unknown): MemoryError {
  if (!(error instanceof MemoryError) || error.code !== 'privacy') throw error;
  return error;
}
/** Review SDK rule additions through its public literal union; unknown runtime findings refuse conservatively. */
const SDK_FINDING_POLICY = {
  private_key: true, github_token: true, npm_token: true, aws_access_key: true, google_api_key: true,
  slack_token: true, anthropic_api_key: true, openai_api_key: true, gitlab_token: true, jwt_like_token: true,
  npm_auth_token_assignment: true, sentry_user_token: true, sentry_org_token: true,
  private_ip: false, private_ssh_target: false, sshpass_inline_password: true, password_assignment: true,
  absolute_home_path: false, user_at_private_host: false, high_entropy_assignment: true,
} satisfies Record<SecretGuardFinding['rule'], boolean>;
const SDK_FINDINGS = new Map<string, boolean>(Object.entries(SDK_FINDING_POLICY));
/** Apply the shared credential findings while leaving identity/path policy local. */
function sharedSecret(value: string): boolean {
  return scanMutationSecrets(value).some(finding => SDK_FINDINGS.get(finding.rule) !== false);
}
/** Project complete quoted spans with bounded bodies and normalized prefix whitespace, retaining SDK-owned credential grammars. */
function* quotedCredentialViews(value: string): Generator<string, void, unknown> {
  if (!/["']/.test(value)) return;
  const quotes: { index: number; mark: string; context: string }[] = [];
  let context = ''; let cursor = 0;
  for (const match of value.matchAll(/\s+|["']/g)) {
    context = (context + value.slice(cursor, match.index)).slice(-64);
    const mark = match[0];
    if (mark === '"' || mark === "'") quotes.push({ index: match.index, mark, context });
    context = mark === '"' || mark === "'" ? '' : (context + ' ').slice(-64);
    cursor = match.index + mark.length;
  }
  const next = new Map<string, number>(); let nextAny: number | undefined;
  const seen = new Set<string>();
  for (const quote of quotes.reverse()) {
    const ends = new Set([nextAny, next.get(quote.mark)]);
    next.set(quote.mark, quote.index); nextAny = quote.index;
    for (const end of ends) {
      if (end === undefined) continue;
      // Short contiguous spans already fit a raw window, including their prefix.
      // Prefixes restart at quotes, which terminate the SDK's quoted-rule preambles.
      const start = quote.index - quote.context.length;
      if (end - start + 1 <= 64 && value.slice(start, quote.index) === quote.context) continue;
      // Eight body characters retain the pinned SDK's quoted six/eight-character floors.
      // Contiguous provider tokens are already inspected in the raw windows.
      const candidate = (quote.context.length < 64 ? '' : '0') + quote.context + quote.mark + value.slice(quote.index + 1, Math.min(end, quote.index + 9)) + value[end];
      if (seen.has(candidate)) continue;
      seen.add(candidate); yield candidate;
    }
  }
}
/** Bound the SDK's private-host matcher; complete quoted views preserve rules whose closing delimiter can lie beyond a window. */
function sharedCredential(value: string): boolean {
  for (const view of new Set([value, value.replace(/\s+/g, ' ')])) {
    let previous: string | undefined;
    for (let offset = 0; offset < view.length; offset += 64) {
      const window = (offset === 0 ? '' : '0' + view[offset - 1]) + view.slice(offset, offset + 128);
      if (window === previous) continue;
      previous = window;
      if (sharedSecret(window)) return true;
    }
  }
  for (const candidate of quotedCredentialViews(value)) if (sharedSecret(candidate)) return true;
  return false;
}
/** Bounded transport decoding supplements the SDK, which normalizes paths but scans credential rules literally. */
function credentialViews(value: string): string[] {
  const views = [value];
  for (let pass = 0; pass < 4; pass++) {
    const previous = views.at(-1)!;
    const next = previous.replace(/(?:%[a-f0-9]{2})+/gi, run => Buffer.from([...run.matchAll(/%([a-f0-9]{2})/gi)].map(([, byte]) => Number.parseInt(byte, 16))).toString('utf8')).replace(/\\+(?:u([a-f0-9]{4})|x([a-f0-9]{2}))?/gi, (match: string, unicode: string | undefined, byte: string | undefined) => { const code = unicode ?? byte; return code === undefined ? match : String.fromCharCode(Number.parseInt(code, 16)); }).normalize('NFKC').replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_)/gi, prefix => prefix.toLowerCase()).replace(/\b(?:AKIA|ASIA)[a-z0-9]{16}\b/gi, key => key.toUpperCase()).replace(/[\p{Bidi_Control}\u200b-\u200f\u2060-\u206f\ufeff]/gu, '');
    if (next === previous) break;
    views.push(next);
    if (pass === 3 && /%[a-f0-9]{2}|\\(?:u[a-f0-9]{4}|x[a-f0-9]{2})/i.test(next)) throw new MemoryError('privacy', 'Memory normalization limit exceeded', 'Replace repeatedly encoded content with plain text and secret-manager references');
  }
  return views;
}
/** Apply literal assignment policy after decoding JSON strings, preserving explicit references. */
function credentialLiteral(name: string, value: string): boolean {
  const normalized = credentialViews(value).at(-1)!;
  // Only recognizable placeholder shapes are exempt: letter-only words joined by separators.
  // Bracketed digits, symbols or credential material fall through to the full policy below.
  const trimmed = normalized.trim();
  if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(trimmed) || /^<(?:redacted|[A-Za-z]+(?:[ _-][A-Za-z]+)+)>$/i.test(trimmed)) return false;
  return value.length >= 8 || normalized.length >= 8 || sharedCredential((name.toLowerCase() === '_authtoken' ? '_authToken' : name) + '=' + normalized);
}
/** Inspect quoted scalar keys and bounded JSON string wrappers without copying SDK provider grammars. */
function quotedAssignmentCredential(value: string, depth = 0): boolean {
  const signal = /["'](?:password|passphrase|passwd|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|token|_authToken)\\*["']\s*[=:]/i;
  if (!signal.test(value)) return false;
  /** Decode only credential-bearing string copies, within the finite wrapper budget. */
  const nested = (text: string): boolean => {
    if (!signal.test(text)) return false;
    if (depth === 4) throw new MemoryError('privacy', 'Memory normalization limit exceeded', 'Replace repeatedly encoded content with plain text and secret-manager references');
    return quotedAssignmentCredential(text, depth + 1);
  };
  let parsed: unknown; let valid = false;
  const names = new Map<string, string>();
  try {
    // Give every JSON member a unique inspection key so duplicate assignments,
    // including object/array values, survive parsing with their original context.
    // Match only at the next quote; a failed token ends JSON inspection instead
    // of retrying every escaped quote in the same unterminated suffix.
    const token = /"(?:\\.|[^"\\])*"(\s*:)?/y; const parts: string[] = []; let kept = 0;
    for (let cursor = value.indexOf('"'); cursor >= 0; cursor = value.indexOf('"', kept)) {
      token.lastIndex = cursor;
      const found = token.exec(value);
      if (found === null) throw new SyntaxError('Unterminated JSON string');
      parts.push(value.slice(kept, cursor));
      if (found[1] === undefined) parts.push(found[0]);
      else {
        const name = JSON.parse(found[0].slice(0, -found[1].length)) as string;
        const key = String(names.size); names.set(key, name);
        parts.push(JSON.stringify(key) + found[1]);
      }
      kept = token.lastIndex;
    }
    parts.push(value.slice(kept));
    const distinct = parts.join('');
    parsed = JSON.parse(distinct); valid = true;
  } catch { /* Free text and YAML use the same scalar policy below. */ }
  if (valid) {
    const pending: { name?: string; value: unknown }[] = [{ value: parsed }];
    while (pending.length > 0) {
      const row = pending.pop()!;
      if (typeof row.value === 'string') {
        if (row.name !== undefined && credentialLiteral(row.name, row.value) || nested(row.value)) return true;
      } else if (typeof row.value === 'number') {
        if (row.name !== undefined && credentialLiteral(row.name, String(row.value))) return true;
      } else if (Array.isArray(row.value)) {
        for (const child of row.value) pending.push({ name: row.name, value: child });
      } else if (row.value !== null && typeof row.value === 'object') {
        for (const [key, child] of Object.entries(row.value)) {
          const name = names.get(key)!;
          pending.push({ name: /^(?:password|passphrase|passwd|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|token|_authToken)$/i.test(name) ? name : row.name, value: child });
        }
      }
    }
    return false;
  }
  for (const match of value.matchAll(/(["'])(password|passphrase|passwd|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|token|_authToken)\1\s*[=:]\s*("(?:\\.|[^"\\])*(?:"|$)|'(?:''|\\.|[^'\\])*(?:'|$)|[^\s"'\x60<>]+)/gi)) {
    let literal = match[3];
    if (literal.startsWith('"')) { try { literal = JSON.parse(literal) as string; } catch { literal = literal.slice(1, literal.endsWith('"') ? -1 : undefined); } }
    else if (literal.startsWith("'")) literal = literal.slice(1, literal.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
    if (credentialLiteral(match[2], literal)) return true;
  }
  // Inspect each adjacent unescaped quote pair, including a previous closing quote
  // as the next opening quote. Each span is scanned once, even after stray prose quotes.
  const token = /"(?:\\.|[^"\\])*"/y; const remainder: string[] = []; let kept = 0;
  for (let cursor = 0; cursor < value.length; cursor++) {
    if (value[cursor] !== '"') continue;
    token.lastIndex = cursor; const match = token.exec(value); if (match === null) break;
    let decoded: string;
    try { decoded = JSON.parse(match[0]) as string; } catch { cursor = token.lastIndex - 2; continue; }
    if (nested(decoded)) return true;
    remainder.push(value.slice(kept, cursor)); kept = token.lastIndex; cursor = token.lastIndex - 2;
  }
  remainder.push(value.slice(kept));
  const unresolved = remainder.join('');
  if (/\\["'](?:password|passphrase|passwd|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|token|_authToken)\\+["']\s*[=:]/i.test(unresolved)) {
    let decoded: string;
    try { decoded = JSON.parse('"' + unresolved.replace(/\\'/g, "'").replace(/[\u0000-\u001f]/g, char => JSON.stringify(char).slice(1, -1)) + '"') as string; }
    catch { throw new MemoryError('privacy', 'Escaped credential declaration refused', 'Use plain text with an environment or secret-manager reference'); }
    return nested(decoded);
  }
  return false;
}
/** Stronger memory policy: shorter/legacy keys, generic literal assignments, auth headers, URL passwords and short JWT signatures. */
function supplementalCredential(value: string): boolean {
  const legacy = /\b(?:sk|pk|rk)-(?:proj-)?[a-z0-9_-]{16,}|\b(?:gh[pousr]_[a-z0-9]{16,19}|github_pat_[a-z0-9_]{16,19})\b|\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i;
  // Shared findings already returned above; this fallback retains mixed-case and long markers.
  const privateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(value);
  for (const [, name, separator, assigned] of value.matchAll(/\b(password|passphrase|passwd|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|token)\b\s*(=|:)\s*["']?([^\s"'`<>]{8,})/gi)) {
    if (!(name.toLowerCase() === 'token' && separator === ':' && /^[a-z]{8,19}[.,;:]?$/.test(assigned))) return true;
  }
  // Bracket wrappers keep their full interior, including quotes. A quote is surrounding syntax, never a reason to stop before the closing bracket, and a quoted key uses the same wrapper.
  for (const [, name, , wrapped] of value.matchAll(/\b(password|passphrase|passwd|pwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|token)\b["']?\s*(=|:)\s*["']?<([^<>]*)>["']?/gi)) {
    if (credentialLiteral(name, '<' + wrapped + '>')) return true;
  }
  return quotedAssignmentCredential(value) || legacy.test(value) || privateKey || credentialJwt(value) || credentialUrl(value);
}
/** Cover arbitrarily long JWT segments across SDK windows with a linear scan, retaining the stronger eight-character signature floor. */
function credentialJwt(value: string): boolean {
  const tail = /([a-z0-9_-]{10,})\.([a-z0-9_-]{8,})\b/iy;
  for (const match of value.matchAll(/\beyJ[a-z0-9_-]*/gi)) {
    const end = match.index + match[0].length;
    if (match[0].length < 13 || value[end] !== '.') continue;
    tail.lastIndex = end + 1;
    const parts = tail.exec(value);
    if (parts !== null && (match[0].length >= 15 && parts[1].length >= 12 || match[0].startsWith('eyJ') && parts[2].length >= 10)) return true;
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
