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
/** Whole credential names share compound-prefix recognition without matching suffixes of ordinary setting names. */
const CREDENTIAL_KEY = String.raw`(?<![A-Za-z0-9_])(?<![A-Za-z0-9]-)(?:(?:[A-Za-z0-9]+[_-])*(?:password|passphrase|passwd|pwd|secret|token|api[_ -]?key|access[_ -]?(?:token|key)|auth[_ -]?token|private[_ -]?key|client[_ -]?secret|secret[_ -]?(?:access[_ -]?)?key)|_authToken)(?![A-Za-z0-9_-])`;
/** Reuse the shared grammar for complete decoded JSON member names. */
const CREDENTIAL_NAME = new RegExp(String.raw`^${CREDENTIAL_KEY}$`, 'i');
/** Bound complete-value scanner work; oversized values refuse instead of being partially inspected. */
function privacySize(value: string, aggregate = false): void {
  if (aggregate) aggregateSize(Buffer.byteLength(value));
  if (!aggregate && Buffer.byteLength(value) > 1024 * 1024) throw new MemoryError('privacy', 'Memory privacy scan size limit exceeded', 'Use at most 1 MiB per inspected value and simplify excessively long dotted or hyphenated identifiers');
  let work = 0;
  for (const [identifier] of value.matchAll(/[A-Za-z0-9_.-]+/g)) {
    let separators = 0;
    for (const character of identifier) if (character === '.' || character === '-') separators++;
    work += identifier.length * separators;
    if (aggregate && work > 32_000_000) throw new MemoryError('privacy', 'Memory aggregate scan work limit exceeded', 'Split the inventory and simplify excessively long dotted or hyphenated identifiers');
    if (!aggregate && work > 2_000_000) throw new MemoryError('privacy', 'Memory privacy scan size limit exceeded', 'Use at most 1 MiB per inspected value and simplify excessively long dotted or hyphenated identifiers');
  }
}
/** Refuse the union of complete SDK credential findings and complete local-policy matches before persistence. */
export function privacy(value: string, allowEmail = false): void { inspectPrivacy(value, allowEmail, false); }
/** Bound the complete wire inventory independently of each decoded memory value. */
export function aggregateSize(bytes: number): void {
  if (bytes > 16 * 1024 * 1024) throw new MemoryError('privacy', 'Memory aggregate size limit exceeded', 'Split the import or export into inventories of at most 16 MiB including companion manifests');
}
/** Inspect a bounded wire companion without imposing the decoded-value byte ceiling. */
export function aggregatePrivacy(value: string, allowEmail = false): void { inspectPrivacy(value, allowEmail, true); }
/** Preserve complete credential and email policy under the appropriate resource budget. */
function inspectPrivacy(value: string, allowEmail: boolean, aggregate: boolean): void {
  privacySize(value, aggregate);
  for (const view of credentialViews(value)) {
    privacySize(view, aggregate);
    if (sharedSecret(view) || supplementalCredential(view)) throw new MemoryError('privacy', 'Credential-shaped memory refused', 'Remove credentials and reference a secret manager instead');
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
  if (trimmed === '[scrubbed]' || COMPLETE_REFERENCE.test(trimmed) || /^<(?:redacted|[A-Za-z]+(?:[ _-][A-Za-z]+)+)>$/i.test(trimmed)) return false;
  return value.length >= 8 || normalized.length >= 8 || sharedSecret((name.toLowerCase() === '_authtoken' ? '_authToken' : name) + '=' + normalized);
}
/** Precompute greedy quote ends in one backwards pass; zero is invalid and negative is unterminated. */
function quoteEnds(value: string, quote: string): Int32Array {
  const ends = new Int32Array(value.length + 2); ends[value.length] = -value.length - 1;
  for (let at = value.length - 1; at >= 0; at--) {
    const character = value[at];
    if (character === '\\') ends[at] = at + 1 < value.length && !/[\n\r\u2028\u2029]/.test(value[at + 1]) ? ends[at + 2] : 0;
    else if (character === quote) ends[at] = quote === "'" && value[at + 1] === quote && ends[at + 2] !== 0 ? ends[at + 2] : at + 1;
    else ends[at] = ends[at + 1];
  }
  return ends;
}
/** Inspect quoted scalar keys and bounded JSON string wrappers without copying SDK provider grammars. */
function quotedAssignmentCredential(value: string, depth = 0): boolean {
  const signal = new RegExp(String.raw`["']${CREDENTIAL_KEY}\\*["']\s*[=:]`, 'i');
  if (!signal.test(value)) return false;
  /** Decode only credential-bearing string copies, within the finite wrapper budget. */
  const nested = (text: string): boolean => {
    if (!signal.test(text)) return false;
    if (depth === 4) throw new MemoryError('privacy', 'Memory normalization limit exceeded', 'Replace repeatedly encoded content with plain text and secret-manager references');
    return quotedAssignmentCredential(text, depth + 1);
  };
  let parsed: unknown; let valid = false;
  const names = new Map<string, string>();
  const doubleEnds = quoteEnds(value, '"');
  try {
    // Give every JSON member a unique inspection key so duplicate assignments,
    // including object/array values, survive parsing with their original context.
    // Match only at the next quote; a failed token ends JSON inspection instead
    // of retrying every escaped quote in the same unterminated suffix.
    const parts: string[] = []; let kept = 0;
    for (let cursor = value.indexOf('"'); cursor >= 0; cursor = value.indexOf('"', kept)) {
      const end = doubleEnds[cursor + 1];
      if (end <= 0) throw new SyntaxError('Unterminated JSON string');
      let colon = end; while (colon < value.length && /\s/.test(value[colon])) colon++;
      const member = value[colon] === ':';
      parts.push(value.slice(kept, cursor));
      if (!member) parts.push(value.slice(cursor, end));
      else {
        const name = JSON.parse(value.slice(cursor, end)) as string;
        const key = String(names.size); names.set(key, name);
        parts.push(JSON.stringify(key) + value.slice(end, colon + 1));
      }
      kept = member ? colon + 1 : end;
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
          pending.push({ name: CREDENTIAL_NAME.test(name) ? name : row.name, value: child });
        }
      }
    }
    return false;
  }
  const singleEnds = quoteEnds(value, "'");
  const assignments = new RegExp(String.raw`(["'])(${CREDENTIAL_KEY})\1\s*[=:]\s*`, 'gi');
  const unquoted = /[^\s"'`<>]+/y;
  for (let match; (match = assignments.exec(value)) !== null;) {
    const start = match.index + match[0].length;
    let end: number;
    if (value[start] === '"' || value[start] === "'") {
      end = (value[start] === '"' ? doubleEnds : singleEnds)[start + 1];
      if (end === 0) continue;
      if (end < 0) end = value.length;
    } else {
      unquoted.lastIndex = start; const found = unquoted.exec(value);
      if (found === null) continue;
      end = unquoted.lastIndex;
    }
    assignments.lastIndex = end;
    let literal = value.slice(start, end);
    if (literal.startsWith('"')) { try { literal = JSON.parse(literal) as string; } catch { literal = literal.slice(1, literal.endsWith('"') ? -1 : undefined); } }
    else if (literal.startsWith("'")) literal = literal.slice(1, literal.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
    if (credentialLiteral(match[2], literal)) return true;
  }
  // Inspect each adjacent unescaped quote pair, including a previous closing quote
  // as the next opening quote. Each span is scanned once, even after stray prose quotes.
  const remainder: string[] = []; let kept = 0;
  for (let cursor = 0; cursor < value.length; cursor++) {
    if (value[cursor] !== '"') continue;
    const end = doubleEnds[cursor + 1]; if (end <= 0) break;
    let decoded: string;
    try { decoded = JSON.parse(value.slice(cursor, end)) as string; } catch { cursor = end - 2; continue; }
    if (nested(decoded)) return true;
    remainder.push(value.slice(kept, cursor)); kept = end; cursor = end - 2;
  }
  remainder.push(value.slice(kept));
  const unresolved = remainder.join('');
  if (new RegExp(String.raw`\\["']${CREDENTIAL_KEY}\\+["']\s*[=:]`, 'i').test(unresolved)) {
    let decoded: string;
    try { decoded = JSON.parse('"' + unresolved.replace(/\\'/g, "'").replace(/[\u0000-\u001f]/g, char => JSON.stringify(char).slice(1, -1)) + '"') as string; }
    catch { throw new MemoryError('privacy', 'Escaped credential declaration refused', 'Use plain text with an environment or secret-manager reference'); }
    return nested(decoded);
  }
  return false;
}
/** The full local reference spelling, including the existing optional explanatory annotation. */
const REFERENCE_VALUE = String.raw`\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)(?:\([A-Za-z]+(?: [A-Za-z,.'-]+)+\))?`;
/** Classify an entire local reference value, never a scanned prefix. */
const COMPLETE_REFERENCE = new RegExp(String.raw`^${REFERENCE_VALUE}$`);
/** Retain the existing refusal of unknown parenthesized continuations using complete source matches. */
function referenceSuffixCredential(value: string): boolean {
  const references = new RegExp(String.raw`(${CREDENTIAL_KEY})\s*[=:]\s*((?:\\*["'])?)(\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*))`, 'gi');
  const explanation = /\([A-Za-z]+(?: [A-Za-z,.'-]+)+\)/y;
  const scalar = /[^\s"'`<>;,)}\]]+/y;
  const terminator = /\s*(?:[,}:\]]|$)/y;
  const boundaries = new Map<string, Int32Array>();
  let serialized: boolean | undefined;
  for (let match; (match = references.exec(value)) !== null;) {
    let end = match.index + match[0].length;
    const start = end - match[3].length;
    if (value[end] === '(') {
      explanation.lastIndex = end;
      const annotation = explanation.exec(value);
      if (annotation === null || annotation[0].length > 200) return true;
      end += annotation[0].length;
      const following = value[end];
      if (following !== undefined && !/[\s"'`;,)}\]]/.test(following)) return true;
    }
    let closed = match[2] !== '' && value.startsWith(match[2], end);
    if (closed) end += match[2].length;
    else if (match[2] !== '') {
      const closing = value.indexOf(match[2], end);
      if (credentialLiteral(match[1], value.slice(start, closing < 0 ? value.length : closing))) return true;
      if (closing >= 0) { end = closing + match[2].length; closed = true; }
    }
    const beforeEscapes = end;
    while (value[end] === '\\') end++;
    const quote = value[end];
    if (quote !== '"' && quote !== "'") {
      scalar.lastIndex = end;
      const suffix = closed ? scalar.exec(value) : null;
      if (suffix !== null && credentialLiteral(match[1], suffix[0])) return true;
      continue;
    }
    // A serialized field terminator carries no adjacent literal.
    terminator.lastIndex = end + 1;
    if (end === beforeEscapes && terminator.test(value)) {
      if (serialized === undefined) { try { JSON.parse(value); serialized = true; } catch { serialized = false; } }
      if (serialized) continue;
    }
    if (!boundaries.has(quote)) boundaries.set(quote, quoteEnds(value, quote));
    const closing = boundaries.get(quote)![end + 1];
    const literal = value.slice(end + 1, closing > 0 ? closing - 1 : value.length);
    if (credentialLiteral(match[1], literal)) return true;
    references.lastIndex = closing > 0 ? closing : value.length;
  }
  return false;
}
/** Stronger memory policy: shorter/legacy keys, generic literal assignments, auth headers, URL passwords and short JWT signatures. */
function supplementalCredential(value: string): boolean {
  const legacy = /\b(?:sk|pk|rk)-(?:proj-)?[a-z0-9_-]{16,}|\b(?:gh[pousr]_[a-z0-9]{16,19}|github_pat_[a-z0-9_]{16,19})\b|\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i;
  // Shared findings already returned above; this fallback retains mixed-case and long markers.
  const privateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(value);
  if (referenceSuffixCredential(value)) return true;
  for (const [, name, separator, assigned] of value.matchAll(new RegExp(String.raw`(${CREDENTIAL_KEY})\s*(=|:)\s*["']?(${REFERENCE_VALUE}(?=$|[\s"'\x60;,)}\]])|[^\s"'\x60<>]{8,})`, 'gi'))) {
    if (assigned === '[scrubbed]' || COMPLETE_REFERENCE.test(assigned)) continue;
    if (!(name.toLowerCase() === 'token' && separator === ':' && /^[a-z]{8,19}[.,;:]?$/.test(assigned)) && credentialLiteral(name, assigned)) return true;
  }
  // Bracket wrappers keep their full interior, including quotes. A quote is surrounding syntax, never a reason to stop before the closing bracket, and a quoted key uses the same wrapper.
  for (const [, name, , wrapped] of value.matchAll(new RegExp(String.raw`(${CREDENTIAL_KEY})["']?\s*(=|:)\s*["']?<([^<>]*)>["']?`, 'gi'))) {
    if (credentialLiteral(name, '<' + wrapped + '>')) return true;
  }
  return quotedAssignmentCredential(value) || legacy.test(value) || privateKey || credentialJwt(value) || credentialUrl(value);
}
/** Scan complete JWT segments linearly while retaining the stronger eight-character signature floor. */
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
