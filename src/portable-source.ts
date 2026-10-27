import { basename } from 'node:path';
import { parse } from 'yaml';
import { digest, kind, MemoryError, slug } from './core.ts';
import type { Harness, MemoryKind } from './types.ts';

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
export function stemOf(path: string): string { return path.replace(/\.[^./]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''); }
/** Parse frontmatter with the YAML parser while preserving its original byte representation. */
export function sourceDocument(path: string, bytes: Buffer, from: Harness): Source {
  const original = bytes.toString('base64');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content).equals(bytes)) throw new MemoryError('format', 'Non-UTF-8 memory refused', 'Convert the source to UTF-8 before importing');
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  let metadata: Record<string, unknown> = {};
  if (front !== null) {
    let parsed: unknown;
    try {
      const yaml = front[1].replace(/^(name|description): ([^"'|>\n].*: .+)$/gm, (_line, key: string, value: string) => `${key}: ${JSON.stringify(value)}`);
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
