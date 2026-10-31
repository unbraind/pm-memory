import { basename, isAbsolute } from 'node:path';
import { parse } from 'yaml';
import { digest, kind, MemoryError, slug } from './core.ts';
import type { Harness, HarnessDocument, Memory, MemoryKind } from './types.ts';

/** Permit only confined relative source and export names through one path contract. */
export function safePath(value: string): string {
  if (isAbsolute(value) || value.includes('\\') || value.split('/').some(part => part === '..' || part === '' || part === '.') || value.includes('\0')) throw new MemoryError('path', 'Unsafe source path refused', 'Use regular files under the supplied directory');
  return value;
}

/** Read only our complete-byte envelope; foreign versions and malformed values stay unknown. */
export function readDocument(value: unknown): HarnessDocument | undefined {
  try {
    const row: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined;
    const document = row as HarnessDocument;
    if (Object.keys(row).sort().join(',') !== 'format,harness,original,path,version' || document.version !== 1 || !['agents-md', 'claude-code', 'cursor'].includes(document.harness) || !['legacy', 'policy'].includes(document.format) || typeof document.path !== 'string' || typeof document.original !== 'string') return undefined;
    safePath(document.path);
    const bytes = Buffer.from(document.original, 'base64');
    if (bytes.toString('base64') !== document.original || !Buffer.from(bytes.toString('utf8')).equals(bytes)) return undefined;
    if (document.format === 'legacy') sourceDocument(document.path, bytes, document.harness);
    return { version: 1, harness: document.harness, format: document.format, path: document.path, original: document.original };
  } catch { return undefined; }
}
/** Encode every envelope field with stable wrapper ordering; source byte order stays untouched. */
export function encodeDocument(document: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(document).sort(([a], [b]) => a.localeCompare(b))));
}
/** Compare complete input documents, never a whitelist of recognized YAML or Markdown fields. */
export function documentPatch(item: Pick<Memory, 'document'>, next: HarnessDocument, baseline: string | undefined, nativeEdit = false, expectedHash?: string): { options: Record<string, unknown>; conflict: boolean } {
  const current = item.document ?? { ...next, original: baseline };
  if (encodeDocument(current) === encodeDocument(next)) return { options: {}, conflict: false };
  const expected = expectedHash ?? (baseline === undefined ? undefined : digest(encodeDocument({ ...next, original: baseline })));
  if ((item.document !== undefined && expected !== undefined && digest(encodeDocument(item.document)) !== expected) || (nativeEdit && expected === undefined)) return { options: {}, conflict: true };
  return { options: { memoryDocument: encodeDocument(next) }, conflict: false };
}

/** A parsed source document with its exact original bytes retained separately. */
export interface Source {
  /** Semantic metadata explicitly present in this legacy file. Body is always represented. */
  represented: ('title' | 'description' | 'kind' | 'why' | 'how')[];
  /** Safe relative export name. */
  path: string;
  /** Native memory key. */
  slug: string;
  /** Human-facing title. */
  title: string;
  /** Compact frontmatter retrieval hook. */
  description: string;
  /** Semantic body without the YAML envelope. */
  body: string;
  /** Semantic class. */
  kind: MemoryKind;
  /** Indexes retain their bytes but do not pollute retrieval. */
  artifact: boolean;
  /** Exact source. */
  original: string;
  /** Optional rationale. */
  why: string;
  /** Optional application guidance. */
  how: string;
  /** Wiki-link targets, resolved after all imports exist. */
  links: string[];
}
/** Normalize relative source paths identically for generated slugs and wiki aliases. */
export function stemOf(path: string): string {
  const stem = path.replace(/\.[^./]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  let start = 0; let end = stem.length;
  while (start < end && stem[start] === '-') start++;
  while (end > start && stem[end - 1] === '-') end--;
  return stem.slice(start, end);
}
/** Detect document framing independently of YAML validity, including literal native body text. */
export function frontmatter(content: string): RegExpExecArray | null { return /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content); }
/** Parse frontmatter with the YAML parser while preserving its original byte representation. */
export function sourceDocument(path: string, bytes: Buffer, from: Harness): Source {
  const original = bytes.toString('base64');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content).equals(bytes)) throw new MemoryError('format', 'Non-UTF-8 memory refused', 'Convert the source to UTF-8 before importing');
  const front = frontmatter(content);
  let metadata: Record<string, unknown> = {};
  if (front !== null) {
    let parsed: unknown;
    try {
      const yaml = front[1].replace(/^(name|description): ([^"'|>\n][^\r\n\u2028\u2029]*)$/gm, (line, key: string, value: string) => {
        const delimiter = value.indexOf(': ', 1);
        return delimiter >= 0 && delimiter + 2 < value.length ? `${key}: ${JSON.stringify(value)}` : line;
      });
      parsed = parse(yaml);
    } catch { throw new MemoryError('format', 'Invalid memory frontmatter', 'Repair the YAML frontmatter before importing'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MemoryError('format', 'Invalid memory frontmatter mapping', 'Use a YAML mapping');
    metadata = parsed as Record<string, unknown>;
  }
  const nested = metadata.metadata;
  const classification = typeof nested === 'object' && nested !== null && 'type' in nested ? nested.type : metadata.type;
  const body = content.slice(front?.[0].length ?? 0);
  const stem = stemOf(path);
  const key = /^[a-z0-9][a-z0-9_-]{0,119}$/.test(stem) ? stem : `import-${digest(path).slice(0, 16)}`;
  const heading = body.split(/\r?\n/).find(line => line.trim() !== '');
  const named = typeof metadata.name === 'string' && metadata.name.trim() !== '';
  const title = named ? metadata.name as string : heading?.replace(/^#+\s*/, '') ?? key;
  const why = /\*\*Why:\*\*\s*([^\r\n]*)/i.exec(body); const how = /\*\*How to apply:\*\*\s*([^\r\n]*)/i.exec(body);
  const represented: Source['represented'] = [];
  if (named || heading !== undefined) represented.push('title');
  if (typeof metadata.description === 'string') represented.push('description');
  if (classification !== undefined) represented.push('kind');
  if (why !== null) represented.push('why'); if (how !== null) represented.push('how');
  return { represented, path, slug: slug(typeof metadata.name === 'string' && /^[a-z0-9][a-z0-9_-]{0,119}$/.test(metadata.name) ? metadata.name : key), description: typeof metadata.description === 'string' ? metadata.description : '', title: title.slice(0, 160).toWellFormed(), body, kind: classification === undefined ? 'reference' : kind(classification), artifact: from === 'claude-code' && basename(path).toUpperCase() === 'MEMORY.MD', original, why: why?.[1] ?? '', how: how?.[1] ?? '', links: [...body.matchAll(/\[\[([a-z0-9_-]+)\]\]/g)].map(match => match[1]) };
}
