import { lstat, readdir, readFile, mkdir, writeFile, mkdtemp, rename, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { digest, kind, MemoryError, privacy, slug } from './core.ts';
import { metadata, Store } from './store.ts';
import type { Harness, Memory, MemoryKind, MemoryOptions } from './types.ts';

/** A parsed source document with its exact original bytes retained separately. */
interface Source {
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
/** Refuse unsupported import/export harness names before filesystem access. */
export function harness(value: unknown, exporting = false): Harness {
  if (!['claude-code', 'agents-md', ...(exporting ? [] : ['cursor'])].includes(String(value))) throw new MemoryError('format', 'Unsupported memory format', 'Use claude-code or agents-md; cursor is import-only');
  return value as Harness;
}
/** Permit only confined relative export paths. */
export function safePath(value: string): string {
  if (isAbsolute(value) || value.includes('\\') || value.split('/').some(part => part === '..' || part === '' || part === '.') || value.includes('\0')) throw new MemoryError('path', 'Unsafe source path refused', 'Use regular files under the supplied directory');
  return value;
}
/** Read regular source files recursively; symlinks and special files fail closed. */
async function sources(path: string, prefix = ''): Promise<{ path: string; bytes: Buffer }[]> {
  const stat = await lstat(path);
  if (stat.isFile()) return [{ path: safePath(prefix || basename(path)), bytes: await readFile(path) }];
  if (!stat.isDirectory()) throw new MemoryError('path', 'Non-regular import source refused', 'Copy regular memory files to a dedicated import directory');
  const result: { path: string; bytes: Buffer }[] = [];
  for (const entry of (await readdir(path)).sort()) result.push(...await sources(join(path, entry), prefix ? `${prefix}/${entry}` : entry));
  return result;
}
/** Parse frontmatter with the YAML parser while preserving its original byte representation. */
function sourceDocument(path: string, bytes: Buffer, from: Harness): Source {
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
  const stem = path.replace(/\.[^./]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const key = stem.length > 0 && stem.length <= 120 ? stem : `import-${digest(path).slice(0, 16)}`;
  const title = typeof metadata.name === 'string' && metadata.name.trim() !== '' ? metadata.name : body.split(/\r?\n/).find(line => line.trim() !== '')?.replace(/^#+\s*/, '') ?? key;
  return { path, slug: slug(typeof metadata.name === 'string' && /^[a-z0-9][a-z0-9_-]{0,119}$/.test(metadata.name) ? metadata.name : key), description: typeof metadata.description === 'string' ? metadata.description : '', title: title.slice(0, 160).toWellFormed(), body, kind: classification === undefined ? 'reference' : kind(classification), artifact: from === 'claude-code' && basename(path).toUpperCase() === 'MEMORY.MD', original, why: /\*\*Why:\*\*\s*([^\r\n]*)/i.exec(body)?.[1] ?? '', how: /\*\*How to apply:\*\*\s*([^\r\n]*)/i.exec(body)?.[1] ?? '', links: [...body.matchAll(/\[\[([a-z0-9_-]+)\]\]/g)].map(match => match[1]) };
}
/** Compare semantic content so native pm edits cannot silently export obsolete original bytes. */
function sameContent(item: Memory, source: Source): boolean {
  /** Normalize SDK whitespace boundaries without altering retained source bytes. */
  const normalized = (values: string[]): string => JSON.stringify(values.map(value => value.replace(/\r\n/g, '\n').trim()));
  return normalized([item.title, item.description, item.body, item.kind, item.why, item.how]) === normalized([source.title, source.description, source.body, source.kind, source.why, source.how]);
}
/** Import regular harness files idempotently, resolving wiki references into native links. */
export async function importDir(path: string, options: MemoryOptions & { from: Harness; allowEmail?: boolean }): Promise<{ imported: number; updated: number; unchanged: number; unresolved_links: number }> {
  harness(options.from);
  const input = await sources(path);
  const offenses: string[] = [];
  for (const source of input) for (const [index, line] of source.bytes.toString('utf8').split(/\r?\n/).entries()) {
    try { privacy(line, options.allowEmail); }
    catch (error) { offenses.push(`${source.path}:line ${index + 1} (${(error as MemoryError).message})`); }
  }
  if (offenses.length > 0) throw new MemoryError('privacy', `Import refused: ${offenses.join('; ')}`, 'Edit each listed file to remove credentials or addresses; --allow-email permits email addresses only');
  const parsed = input.map(source => sourceDocument(source.path, source.bytes, options.from));
  if (new Set(parsed.map(source => source.slug)).size !== parsed.length) throw new MemoryError('duplicate', 'Import names normalize to duplicate slugs', 'Rename the colliding source files');
  const store = new Store(options);
  return store.write(async () => {
    const initial = await store.read();
    for (const source of parsed) {
      const previous = initial.find(item => item.slug === source.slug);
      if (previous !== undefined && (previous.source !== `${options.from}:relative-file` || previous.path !== source.path || previous.edited || !sameContent(previous, sourceDocument(previous.path, Buffer.from(previous.original, 'base64'), options.from)))) throw new MemoryError('conflict', 'Import would overwrite an independently edited memory', 'Export or rename the source before retrying');
    }
    let imported = 0; let updated = 0; let unchanged = 0; let unresolved_links = 0;
    if (parsed.some(source => initial.find(item => item.slug === source.slug)?.original !== source.original)) await store.register();
    for (const source of parsed) {
      const previous = initial.find(item => item.slug === source.slug);
      if (previous?.original === source.original) { unchanged++; continue; }
      const fields = { slug: source.slug, kind: source.kind, why: source.why, how: source.how, pinned: false, source: `${options.from}:relative-file`, recalls: previous?.recalls ?? 0, verdict: 'unknown', verified_at: '', original: source.original, path: source.path, edited: false, artifact: source.artifact, changed_at: new Date().toISOString() };
      if (previous !== undefined && sameContent(previous, source)) fields.changed_at = previous.updated;
      if (previous === undefined) {
        await store.client.run('create', { options: { title: source.title, body: source.body, description: source.description, type: 'Knowledge', allowDuplicate: true, ...metadata(fields) } }); imported++;
      } else {
        await store.history(previous.id);
        await store.client.update(previous.id, { title: source.title, description: source.description, body: source.body, message: 'Revise imported memory source' });
        await store.fields(previous.id, fields); updated++;
      }
    }
    const memories = await store.read();
    for (const source of parsed) for (const reference of source.links) {
      const exact = memories.find(item => item.slug === reference);
      const aliases = memories.filter(item => item.path.replace(/\.[^./]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') === reference);
      const target = exact ?? (aliases.length === 1 ? aliases[0] : undefined);
      if (target === undefined) { unresolved_links++; continue; }
      const item = memories.find(item => item.slug === source.slug)!;
      if (item.id !== target.id && !item.links.includes(target.id)) { await store.link(item.id, target.id); item.links.push(target.id); }
    }
    return { imported, updated, unchanged, unresolved_links };
  });
}
/** Produce a portable source for a native or deliberately revised fact. */
function generated(item: Memory, to: Harness, memories: readonly Memory[]): Buffer {
  const links = item.links.map(id => memories.find(memory => memory.id === id)).filter(memory => memory !== undefined).map(memory => `[[${memory.slug}]]`).join(' ');
  const content = to === 'claude-code' ? `---\nname: ${JSON.stringify(item.slug)}\ndescription: ${JSON.stringify(item.description || item.why)}\nmetadata:\n  type: ${item.kind}\n---\n\n${item.body}\n\n**Why:** ${item.why}\n**How to apply:** ${item.how}\n${links}\n` : `## ${item.title}\n\n${item.body}\n\n**Why:** ${item.why}\n**How to apply:** ${item.how}\n${links}\n`;
  return Buffer.from(content);
}
/** Inspect destination parents without creating directories or following symlinks. */
async function destination(root: string, name: string): Promise<string> {
  const target = resolve(root, safePath(name));
  let current = root;
  for (const part of name.split('/').slice(0, -1)) {
    current = join(current, part);
    try {
      if (!(await lstat(current)).isDirectory()) throw new MemoryError('path', 'Export parent is not a regular directory', 'Choose an empty export directory');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
/** Publish a fully planned directory with one rename; failed staging leaves the destination intact. */
async function publish(root: string, outputs: Map<string, Buffer>): Promise<void> {
  await destination(dirname(root), `${basename(root)}/placeholder`);
  let existing = false;
  try {
    await lstat(root);
    existing = true;
    await access(root, constants.W_OK);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let identical = existing;
  for (const [name, bytes] of outputs) {
    const target = await destination(root, name);
    try {
      if (!(await lstat(target)).isFile() || !(await readFile(target)).equals(bytes)) throw new MemoryError('conflict', 'Export would overwrite an existing file', 'Choose an empty export directory');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; identical = false; }
  }
  if (identical) return;
  if (existing && (await readdir(root)).length > 0) throw new MemoryError('conflict', 'Export would overwrite a nonempty directory', 'Choose an empty export directory');
  const staging = await mkdtemp(join(dirname(root), '.pm-memory-export-'));
  try {
    for (const [name, bytes] of outputs) {
      const target = resolve(staging, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
    }
    await rename(staging, root);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
/** Preserve a current original index only when it names exactly the emitted fact paths. */
function currentIndex(original: Buffer, paths: readonly string[]): boolean {
  const links = [...original.toString('utf8').matchAll(/^[ \t]*[-*][ \t]+\[[^\]\r\n]*\]\(([^)\r\n]+)\)/gm)].map(match => match[1].replace(/^\.\//, ''));
  return links.length === paths.length && new Set(links).size === paths.length && paths.every(path => links.includes(path));
}
/** Export exact imported bytes when semantically unchanged, with conflict-safe native generation otherwise. */
export async function exportDir(path: string, options: MemoryOptions & { to: Exclude<Harness, 'cursor'> }): Promise<{ exported: number; byte_preserved: number }> {
  harness(options.to, true);
  const store = new Store(options);
  return store.write(async () => {
    const memories = await store.read();
    const outputs = new Map<string, Buffer>(); const emitted: { item: Memory; name: string }[] = []; let byte_preserved = 0;
    for (const item of memories) {
      if (item.status === 'canceled') continue;
      await store.history(item.id);
      let name: string; let bytes: Buffer;
      if (item.path !== '' && !item.edited && item.source === `${options.to}:relative-file` && sameContent(item, sourceDocument(item.path, Buffer.from(item.original, 'base64'), options.to))) {
        name = safePath(item.path); bytes = Buffer.from(item.original, 'base64'); byte_preserved++;
      } else if (!item.artifact) {
        name = options.to === 'claude-code' ? `${item.slug}.md` : `memories/${item.slug}.md`;
        bytes = generated(item, options.to, memories);
      } else continue;
      if (outputs.has(name)) throw new MemoryError('conflict', 'Export names collide', 'Rename the conflicting memory slug');
      outputs.set(name, bytes);
      if (!item.artifact) emitted.push({ item, name });
    }
    if (options.to === 'claude-code') {
      const original = outputs.get('MEMORY.md');
      if (original === undefined || !currentIndex(original, emitted.map(row => row.name))) {
        outputs.set('MEMORY.md', Buffer.from(emitted.map(({ item, name }) => `- [${item.title}](${name})`).join('\n') + '\n'));
        if (original !== undefined) byte_preserved--;
      }
    } else {
      const original = outputs.get('AGENTS.md');
      const additions = [...outputs.entries()].filter(([name]) => name !== 'AGENTS.md').map(([, bytes]) => bytes);
      if (original === undefined || additions.length > 0) {
        outputs.set('AGENTS.md', Buffer.concat([...(original === undefined ? [] : [original, Buffer.from('\n')]), ...additions]));
        if (original !== undefined) byte_preserved--;
      }
    }
    await publish(resolve(path), outputs);
    return { exported: outputs.size, byte_preserved };
  });
}
