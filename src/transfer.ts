import { lstat, readdir, readFile, mkdir, writeFile, mkdtemp, rename, rm, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
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
/** Normalize relative source paths identically for generated slugs and wiki aliases. */
function stemOf(path: string): string { return path.replace(/\.[^./]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''); }
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
  const stem = stemOf(path);
  const key = /^[a-z0-9][a-z0-9_-]{0,119}$/.test(stem) ? stem : `import-${digest(path).slice(0, 16)}`;
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
  for (const source of input) {
    const content = source.bytes.toString('utf8');
    try { privacy(content, options.allowEmail); }
    catch (error) {
      const before = offenses.length;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        try { privacy(line, options.allowEmail); }
        catch (error) { offenses.push(`${source.path}:line ${index + 1} (${(error as MemoryError).message})`); }
      }
      if (offenses.length === before) offenses.push(`${source.path}:multiline (${(error as MemoryError).message})`);
    }
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
        await store.client.update(previous.id, { title: source.title, description: source.description, body: source.body, ...(previous.status === 'canceled' ? { status: 'open' } : {}), message: 'Revise imported memory source' });
        await store.fields(previous.id, fields); updated++;
      }
    }
    const memories = await store.read();
    for (const source of parsed) for (const reference of source.links) {
      const exact = memories.find(item => item.slug === reference);
      const aliases = memories.filter(item => stemOf(item.path) === reference);
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
  const links = item.links.map(id => memories.find(memory => memory.id === id)).filter((memory): memory is Memory => memory !== undefined && memory.status !== 'canceled' && !memory.artifact).map(memory => `[[${memory.slug}]]`).join(' ');
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
/** Permit directory ancestors and POSIX root-owned system links, never destination links. */
export function exportAncestor(stat: Stats, platform = process.platform): boolean {
  return stat.isDirectory() || (stat.isSymbolicLink() && platform !== 'win32' && stat.uid === 0);
}
/** Publish a fully planned directory with one rename; failed staging leaves the destination intact. */
async function publish(root: string, outputs: Map<string, Buffer>): Promise<void> {
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    try {
      if (!exportAncestor(await lstat(parent))) throw new MemoryError('path', 'Export ancestor is not a regular directory', 'Choose a destination with regular directory ancestors');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (parent === dirname(parent)) break;
  }
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
  await mkdir(dirname(root), { recursive: true });
  const staging = await mkdtemp(join(dirname(root), '.pm-memory-export-'));
  try {
    for (const [name, bytes] of outputs) {
      const target = resolve(staging, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
    }
    await chmod(staging, 0o777 & ~process.umask());
    await rename(staging, root);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
/** Preserve a current original index only when it names exactly the emitted fact paths. */
function currentIndex(original: Buffer, paths: readonly string[]): boolean {
  try {
    const links = [...original.toString('utf8').matchAll(/^[ \t]*[-*][ \t]+\[[^\]\r\n]*\]\((?:<([^<>\r\n]+)>|([^)\r\n]+))\)/gm)].map(match => decodeURIComponent(match[1] ?? match[2]).replace(/^\.\//, ''));
    return links.length === paths.length && new Set(links).size === paths.length && paths.every(path => links.includes(path));
  } catch { return false; }
}
/** Resolve wiki links against emitted facts, retaining unavailable references as plain text. */
function exportedReferences(bytes: Buffer, memories: readonly Memory[], targets: ReadonlyMap<string, Source>): Buffer {
  const content = bytes.toString('utf8');
  const offset = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[0].length ?? 0;
  return Buffer.from(content.slice(0, offset) + content.slice(offset).replace(/\[\[([a-z0-9_-]+)\]\]/g, (_link, reference: string) => {
    const exact = memories.find(item => item.slug === reference);
    const aliases = memories.filter(item => stemOf(item.path) === reference);
    const item = exact ?? (aliases.length === 1 ? aliases[0] : undefined);
    const target = item === undefined ? undefined : targets.get(item.id);
    if (target === undefined) return reference;
    const exported = [...targets.values()];
    const canonical = exported.find(source => source.slug === reference);
    const aliasesOut = exported.filter(source => stemOf(source.path) === reference);
    const resolved = canonical ?? (aliasesOut.length === 1 ? aliasesOut[0] : undefined);
    return `[[${resolved === target ? reference : target.slug}]]`;
  }));
}
/** Export exact imported bytes when semantically unchanged, with conflict-safe native generation otherwise. */
export async function exportDir(path: string, options: MemoryOptions & { to: Exclude<Harness, 'cursor'> }): Promise<{ exported: number; byte_preserved: number }> {
  harness(options.to, true);
  const store = new Store(options);
  return store.write(async () => {
    const memories = await store.read();
    if (memories.some(item => item.validity !== undefined && item.status !== 'canceled' && !item.artifact)) throw new MemoryError('validity', 'Portable harness formats cannot preserve guidance validity', 'Use memory recall or memory get to retain window labels and evidence');
    if (memories.some(item => item.consent !== undefined && item.status !== 'canceled' && !item.artifact)) throw new MemoryError('consent', 'Portable harness formats cannot preserve source consent', 'Use memory view with an explicit purpose and fields; retain its manifest for withdrawal checks');
    const indexName = options.to === 'claude-code' ? 'MEMORY.md' : 'AGENTS.md';
    const names = new Set([indexName.toLowerCase()]);
    const outputs = new Map<string, Buffer>(); const emitted: { item: Memory; name: string }[] = []; const preserved = new Set<string>();
    for (const item of memories) {
      if (item.status === 'canceled') continue;
      await store.history(item.id);
      let name: string; let bytes: Buffer;
      if (item.path !== '' && !item.edited && item.source === `${options.to}:relative-file` && sameContent(item, sourceDocument(item.path, Buffer.from(item.original, 'base64'), options.to))) {
        name = safePath(item.path); bytes = Buffer.from(item.original, 'base64'); preserved.add(name);
      } else if (!item.artifact) {
        name = options.to === 'claude-code' ? `${item.slug}.md` : `memories/${item.slug}.md`;
        bytes = generated(item, options.to, memories);
      } else continue;
      const folded = name.toLowerCase();
      const originalIndex = name === indexName && item.path === name && !item.edited;
      if (outputs.has(name) || (names.has(folded) && !originalIndex)) throw new MemoryError('conflict', 'Export names collide', 'Rename the conflicting memory slug or source path, including reserved index names');
      names.add(folded);
      outputs.set(name, bytes);
      if (!item.artifact) emitted.push({ item, name });
    }
    if (options.to === 'claude-code') {
      const original = outputs.get('MEMORY.md');
      if (original === undefined || !currentIndex(original, emitted.map(row => row.name))) {
        outputs.set('MEMORY.md', Buffer.from(emitted.map(({ item, name }) => {
          const encoded = name.split('/').map(part => encodeURIComponent(part)).join('/').replace(/[()]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
          return `- [${item.title.replace(/[[\]\r\n]/g, ' ')}](${encoded === name ? name : `<${encoded}>`})`;
        }).join('\n') + '\n'));
        preserved.delete(indexName);
      }
    } else {
      const original = outputs.get('AGENTS.md');
      let base = original;
      for (const item of memories) {
        if (base === undefined || item.source !== 'agents-md:relative-file' || item.path === 'AGENTS.md') continue;
        const component = Buffer.from(item.original, 'base64');
        if (component.length === 0 || outputs.get(item.path)?.equals(component) === true) continue;
        let at = base.indexOf(component);
        while (at >= 0) {
          base = Buffer.concat([base.subarray(0, at), base.subarray(at + component.length)]);
          at = base.indexOf(component);
        }
      }
      const additions = [...outputs.entries()].filter(([name, bytes]) => name !== 'AGENTS.md' && (base === undefined || !base.includes(bytes))).map(([, bytes]) => bytes);
      if (base === undefined || additions.length > 0 || base !== original) {
        outputs.set('AGENTS.md', Buffer.concat([...(base === undefined ? [] : [base, Buffer.from('\n')]), ...additions]));
        preserved.delete(indexName);
      }
    }
    const targets = new Map(emitted.map(({ item, name }) => [item.id, sourceDocument(name, outputs.get(name)!, options.to)]));
    if (new Set([...targets.values()].map(source => source.slug)).size !== targets.size) throw new MemoryError('conflict', 'Exported names normalize to duplicate slugs', 'Rename the conflicting memory slug or source path before exporting');
    for (const [name, bytes] of outputs) {
      const resolved = exportedReferences(bytes, memories, targets);
      if (!resolved.equals(bytes)) { outputs.set(name, resolved); preserved.delete(name); }
    }
    await store.fence(() => publish(resolve(path), outputs));
    return { exported: outputs.size, byte_preserved: preserved.size };
  });
}
