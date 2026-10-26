import { lstat, readdir, readFile, mkdir, writeFile, mkdtemp, rename, rm, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { certifyCompleteListResult, readSettings, resolveAuthorIdentity, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation } from '@unbrained/pm-cli/sdk';
import { digest, kind, MemoryError, privacy, slug } from './core.ts';
import { metadata, Store } from './store.ts';
import { POLICY_MANIFEST, importPolicy, policyRecord, policyBody, ownedMemories, closeSkips } from './portable.ts';
import type { PortableImportOptions, PortablePolicyManifest, PortableImportResult, PortableExportResult, PortableGuidance, PortableRelationship } from './portable.ts';
import type { Harness, Memory, MemoryKind, MemoryOptions } from './types.ts';
import { ownershipPatch, portableFields, previousOwnership, creationMetadata, PORTABLE_FIELDS } from './portable-ownership.ts';
import type { OwnedTarget } from './portable-ownership.ts';
import { applyImport, expectedTargets, importIdentity, validateImportPlan, recoverInput, previewImport } from './portable-plan.ts';

/** A parsed source document with its exact original bytes retained separately. */
interface Source {
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
/** Original bytes must reproduce all portable fields, including implicit legacy defaults. */
function sameContent(item: Memory, source: Source): boolean {
  const native = portableFields(item, item.body); const decoded = portableFields({ ...source, pinned: false, tags: [] }, source.body);
  return PORTABLE_FIELDS.every(field => native[field] === decoded[field]);
}
/** Legacy wiki references own additions; absent text cannot prove deletion ownership. */
function sourceRelationships(source: Source, memories: readonly Pick<Memory, 'id' | 'slug' | 'path'>[]): PortableRelationship[] {
  return source.links.flatMap(reference => {
    const aliases = memories.filter(item => stemOf(item.path) === reference);
    const target = memories.find(item => item.slug === reference) ?? (aliases.length === 1 ? aliases[0] : undefined);
    return target === undefined || target.slug === source.slug ? [] : [{ slug: target.slug, kind: 'related' as const }];
  });
}
/** Project only fields the legacy document actually carries through the shared split. */
function sourceOwnership(source: Source, before: Source, item: Memory, memories: readonly Pick<Memory, 'id' | 'slug' | 'path'>[]): PortableGuidance {
  const row = { ...item, ...source, pinned: item.pinned, tags: item.tags, relationships: sourceRelationships(source, memories), path: `memories/${item.slug}.md`, validity: null, renewals: [], snapshotHash: digest(source.original), baseline: { fields: portableFields({ ...item, ...before, pinned: item.pinned, tags: item.tags }, before.body), relationships: sourceRelationships(before, memories) } };
  for (const field of ['title', 'description', 'kind', 'why', 'how'] as const) if (!source.represented.includes(field)) Object.assign(row, { [field]: item[field] });
  return row;
}
/** Do not acquire authority over implicit defaults or native-only metadata. */
function sourceReceipt(target: OwnedTarget, source: Source): OwnedTarget {
  return { ...target, fields: Object.fromEntries(Object.entries(target.fields).filter(([key]) => key === 'body' || source.represented.some(field => field === key))), source: { original: source.original } };
}
/** Creation history identifies a legacy source even after native-only identity edits. */
function legacyOrigin(value: Awaited<ReturnType<typeof creationMetadata>>, source: Source, from: Harness): boolean {
  return value?.memory_source === `${from}:relative-file` && value.memory_path === source.path && value.memory_slug === source.slug;
}
/** Import regular harness files idempotently, resolving wiki references into native links. */
export async function importDir(path: string, options: PortableImportOptions): Promise<{ imported: number; updated: number; unchanged: number; unresolved_links: number } | PortableImportResult> {
  harness(options.from);
  const input = await sources(path);
  if (input.some(file => file.path === POLICY_MANIFEST)) return importPolicy(input, options);
  if (input.some(file => file.bytes.includes('pm-memory-policy:v1'))) throw new MemoryError('validity', 'Portable policy manifest is missing', 'Keep pm-memory-policy.json with every exported body file and import the complete directory');
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
    const inputHash = digest(JSON.stringify([options.from, input]));
    const recovered = await recoverInput(store, inputHash, options);
    if (recovered !== undefined) { const { skipped, ...counts } = recovered; return skipped.length === 0 ? counts : { ...counts, skipped }; }
    const corpus = certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
    const { foreign, memories: initial } = await ownedMemories(store, corpus);
    await options.onStep?.('read');
    const settings = await readSettings(store.workspace); const identity = await importIdentity(store, inputHash);
    const origins = new Map(await Promise.all([...initial, ...foreign].map(async item => [item.id, await creationMetadata(store, item.id)] as const)));
    const selected = new Map<string, Memory>(); const skipped = new Map<string, string>();
    for (const source of parsed) {
      const named = initial.find(item => item.slug === source.slug);
      const candidates = named === undefined ? initial.filter(item => legacyOrigin(origins.get(item.id), source, options.from)) : [named];
      if (candidates.length > 1) throw new MemoryError('conflict', 'Ambiguous native legacy origin', 'Export current guidance and choose one native identity before importing');
      if (candidates.length === 1) {
        const candidate = candidates[0]; const origin = origins.get(candidate.id);
        if (candidate.source === `${options.from}:relative-file` && (origin === undefined || typeof origin.memory_original !== 'string')) skipped.set(source.slug, 'Foreign legacy record has no immutable source provenance');
        else selected.set(source.slug, candidate);
      }
    }
    const ids = new Map(parsed.map(source => [source.slug, selected.get(source.slug)?.id ?? `${settings.id_prefix}${digest(`${identity.transactionId}:${source.slug}`).slice(0, 24)}`]));
    const references = [...initial.map(item => ({ id: item.id, slug: item.slug, path: item.path })), ...parsed.filter(source => !initial.some(item => item.slug === source.slug)).map(source => ({ id: ids.get(source.slug)!, slug: source.slug, path: source.path }))];
    const baselineIds = new Map([...initial.map(item => [item.slug, item.id] as const), ...ids]);
    for (const source of parsed) if (foreign.some(item => item.memory_slug === source.slug || legacyOrigin(origins.get(item.id), source, options.from))) skipped.set(source.slug, 'Foreign record has no package-owned source');
    closeSkips(parsed.map(source => ({ slug: source.slug, relationships: sourceRelationships(source, references) })), skipped);
    const result = { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: [...foreign.filter(item => !parsed.some(source => source.slug === item.memory_slug)).map(item => ({ slug: item.id, reason: 'Foreign record has no package-owned source' })), ...[...skipped].map(([slug, reason]) => ({ slug, reason }))] };
    const mutations: BulkItemMutation[] = []; const ownership: OwnedTarget[] = [];
    for (const source of parsed) {
      if (skipped.has(source.slug)) continue;
      const previous = selected.get(source.slug); const id = ids.get(source.slug)!;
      const origin = previous === undefined ? undefined : origins.get(previous.id);
      if (previous?.validity !== undefined) throw new MemoryError('validity', 'Import would remove the portable policy window', 'Keep pm-memory-policy.json with every exported body file and import the complete directory');
      if (previous !== undefined && !legacyOrigin(origin, source, options.from)) throw new MemoryError('conflict', 'Import would overwrite an independently edited memory', 'Export or rename the source before retrying');
      const relationships = sourceRelationships(source, references);
      for (const reference of source.links) if (!references.some(item => item.slug === reference) && references.filter(item => stemOf(item.path) === reference).length !== 1) result.unresolved_links++;
      if (previous === undefined) {
        const graph = relationships.map(({ slug, ...edge }) => ({ ...edge, id: baselineIds.get(slug)! }));
        const fields = { slug: source.slug, kind: source.kind, why: source.why, how: source.how, pinned: false, source: `${options.from}:relative-file`, recalls: 0, verdict: 'unknown', verified_at: '', original: source.original, path: source.path, edited: false, artifact: source.artifact, changed_at: new Date().toISOString() };
        mutations.push({ op: 'create', id, unique: { key: 'memory_slug', value: source.slug }, options: { title: source.title, body: source.body, description: source.description, type: 'Knowledge', allowDuplicate: true, allowUnresolvedDeps: true, ...itemDocumentToMutationOptions(JSON.stringify({ dependencies: graph }), 'create'), ...metadata(fields) } });
        ownership.push(sourceReceipt({ id, fields: portableFields({ ...source, pinned: false, tags: [] }, source.body), relationships: graph, graph }, source)); result.imported++;
      } else {
        const before = sourceDocument(source.path, Buffer.from(String(origin!.memory_original), 'base64'), options.from);
        const prior = await previousOwnership(store, previous, baselineIds);
        const row = sourceOwnership(source, before, previous, references);
        const patch = ownershipPatch(previous, row, source.body, baselineIds, baselineIds, prior, false);
        if (patch.conflicts.length > 0) {
          if (Object.keys(patch.options).length === 0) throw new MemoryError('conflict', 'Import would overwrite an independently edited memory', 'Export or rename the source before retrying');
          result.skipped.push({ slug: source.slug, reason: `Independently edited native fields retained: ${patch.conflicts.join(', ')}` });
        }
        if (Object.keys(patch.options).length === 0) { result.unchanged++; continue; }
        await store.history(previous.id); ownership.push(sourceReceipt(patch.ownership, source)); result.updated++;
        mutations.push({ op: 'update', id, match: { key: 'updated_at', value: corpus.find(item => item.id === id)!.updated_at }, options: patch.options });
      }
    }
    if (mutations.length === 0) { const { skipped: refusals, ...counts } = result; return refusals.length === 0 ? counts : result; }
    const readSet = new Map(parsed.filter(source => !skipped.has(source.slug)).map(source => [ids.get(source.slug)!, source.slug]));
    for (const target of ownership) for (const edge of target.relationships) if (!readSet.has(edge.id)) readSet.set(edge.id, initial.find(item => item.id === edge.id)!.slug);
    const expected = await expectedTargets(store, [...readSet].map(([id, slug]) => ({ id, slug })), corpus);
    const plan = { ...identity, input: inputHash, author: resolveAuthorIdentity(options.author, settings.author_default).author, mutations, ownership, expected, initial: expected, members: expected.map(row => row.id), result };
    await validateImportPlan(store, plan, options.onStep); await store.register(options.onStep);
    await previewImport(store, plan);
    await options.onStep?.('previewed');
    const { skipped: refusals, ...counts } = await applyImport(store, plan, options); return refusals.length === 0 ? counts : { ...counts, skipped: refusals };
  });
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
async function publish(root: string, outputs: Map<string, Buffer>, onStep?: (step: string) => void | Promise<void>): Promise<void> {
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
    await onStep?.('staged');
    for (const [name, bytes] of outputs) {
      const target = resolve(staging, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
      await onStep?.(`file:${name}`);
    }
    await chmod(staging, 0o777 & ~process.umask());
    await onStep?.('permissions');
    try { await rename(staging, root); }
    catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      for (const [name, bytes] of outputs) {
        const target = await destination(root, name);
        if (!(await lstat(target)).isFile() || !(await readFile(target)).equals(bytes)) throw new MemoryError('conflict', 'A peer published different export files', 'Choose a new empty export directory');
      }
    }
    await onStep?.('published');
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
/** Canonical raw bodies and explicit ownership avoid changing native state through projection. */
async function policyOutputs(store: Store, active: readonly Memory[], to: Exclude<Harness, 'cursor'>): Promise<Map<string, Buffer>> {
  const guidance = await Promise.all(active.map(item => policyRecord(store, item, active)));
  const manifest: PortablePolicyManifest = { version: 1, format: 'pm-memory-policy', harness: to, guidance };
  const outputs = new Map<string, Buffer>([[POLICY_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]]);
  for (const [index, row] of guidance.entries()) outputs.set(row.path, policyBody(row, active[index].body));
  const index = guidance.map(row => `- [${row.slug}](${row.path})${row.validity === null ? '' : ` [${row.validity.from}, ${row.validity.until}); retain policy manifest and renewal evidence`}`).join('\n');
  outputs.set(to === 'claude-code' ? 'MEMORY.md' : 'AGENTS.md', Buffer.from(`<!-- pm-memory-policy:v1; keep ${POLICY_MANIFEST} -->\n${index}\n`));
  return outputs;
}
/** Export exact imported bytes when semantically unchanged, with conflict-safe native generation otherwise. */
export async function exportDir(path: string, options: MemoryOptions & { to: Exclude<Harness, 'cursor'>; onStep?: (step: string) => void | Promise<void> }): Promise<PortableExportResult> {
  harness(options.to, true);
  const store = new Store(options);
  return store.write(async () => {
    const corpus = certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
    const owned = await ownedMemories(store, corpus); const { foreign } = owned;
    const ids = new Map(owned.memories.map(item => [item.slug, item.id]));
    const nativeGraphEdits = new Set<string>(); const unreceipted = new Set<string>();
    const memories = await Promise.all(owned.memories.map(async item => {
      const previous = item.source.endsWith(':relative-file') ? await previousOwnership(store, item, ids) : undefined;
      if (previous === undefined) unreceipted.add(item.id);
      if ((previous?.nativeRelationships?.length ?? 0) > 0) nativeGraphEdits.add(item.id);
      const source = previous?.source;
      return source === undefined ? item : { ...item, original: source.original };
    }));
    const foreignReceipt = foreign.length === 0 ? {} : { skipped: foreign.map(item => ({ slug: item.id, reason: 'Foreign record has no package-owned source' })) };
    if (memories.some(item => item.consent !== undefined && item.status !== 'canceled' && !item.artifact)) throw new MemoryError('consent', 'Portable harness formats cannot preserve source consent', 'Use memory view with an explicit purpose and fields; retain its manifest for withdrawal checks');
    const active = memories.filter(item => item.status !== 'canceled' && !item.artifact).sort((a, b) => a.slug.localeCompare(b.slug));
    const omitted_links: NonNullable<PortableExportResult['omitted_links']> = active.flatMap(item => item.relationships.flatMap(edge => {
        if (active.some(target => target.id === edge.id)) return [];
        const target = memories.find(target => target.id === edge.id);
        return [{ slug: item.slug, target: edge.id, kind: edge.kind, reason: target === undefined ? 'missing' as const : target.status === 'canceled' ? 'canceled' as const : 'artifact' as const }];
    }));
    /** Publication and receipts have one lease-fenced path for both wire encodings. */
    const commit = async (outputs: Map<string, Buffer>, byte_preserved: number): Promise<PortableExportResult> => {
      await store.fence(() => publish(resolve(path), outputs, options.onStep));
      return { exported: outputs.size, byte_preserved, ...foreignReceipt, ...(omitted_links.length === 0 ? {} : { omitted_links }) };
    };
    if (memories.length === 0 || memories.some(item => item.validity !== undefined || item.source === 'native:item' || item.source === 'portable:policy-v1')) {
      return commit(await policyOutputs(store, active, options.to), 0);
    }
    const indexName = options.to === 'claude-code' ? 'MEMORY.md' : 'AGENTS.md';
    const names = new Set([indexName.toLowerCase()]);
    const outputs = new Map<string, Buffer>(); const emitted: { item: Memory; name: string }[] = []; const preserved = new Set<string>();
    for (const item of memories) {
      if (item.status === 'canceled') continue;
      await store.history(item.id);
      let name: string; let bytes: Buffer;
      const source = item.path !== '' && !item.edited && !nativeGraphEdits.has(item.id) && item.source === `${options.to}:relative-file` ? sourceDocument(item.path, Buffer.from(item.original, 'base64'), options.to) : undefined;
      const unprovenGraph = source !== undefined && unreceipted.has(item.id) && (item.relationships.length > 0 || source.links.length > 0);
      if (source !== undefined && !unprovenGraph && sameContent(item, source)) {
        name = safePath(item.path); bytes = Buffer.from(item.original, 'base64'); preserved.add(name);
      } else if (!item.artifact) return commit(await policyOutputs(store, active, options.to), 0);
      else continue;
      const folded = name.toLowerCase();
      const originalIndex = name === indexName && item.path === name && !item.edited;
      if (outputs.has(name) || (names.has(folded) && !originalIndex)) throw new MemoryError('conflict', 'Export names collide', 'Rename the conflicting memory slug or source path, including reserved index names');
      names.add(folded);
      outputs.set(name, bytes);
      if (!item.artifact) emitted.push({ item, name });
    }
    const original = outputs.get(indexName);
    const losslessIndex = original !== undefined && (options.to === 'claude-code'
      ? currentIndex(original, emitted.map(row => row.name))
      : emitted.every(row => row.name === indexName || original.includes(outputs.get(row.name)!)));
    if (!losslessIndex) return commit(await policyOutputs(store, active, options.to), 0);
    const targets = new Map(emitted.map(({ item, name }) => [item.id, sourceDocument(name, outputs.get(name)!, options.to)]));
    if (new Set([...targets.values()].map(source => source.slug)).size !== targets.size) throw new MemoryError('conflict', 'Exported names normalize to duplicate slugs', 'Rename the conflicting memory slug or source path before exporting');
    for (const bytes of outputs.values()) if (!exportedReferences(bytes, memories, targets).equals(bytes)) return commit(await policyOutputs(store, active, options.to), 0);
    return commit(outputs, preserved.size);
  });
}
