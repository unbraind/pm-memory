import { lstat, readdir, readFile, mkdir, writeFile, mkdtemp, rename, rm, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { certifyCompleteListResult, readSettings, resolveAuthorIdentity, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation } from '@unbrained/pm-cli/sdk';
import { digest, MemoryError, privacy } from './core.ts';
import { metadata, Store } from './store.ts';
import { POLICY_MANIFEST, importPolicy, policyRecord, policyBody, policyPayload, policyParts, ownedMemories, closeSkips, parsePolicy, guidanceOrigin } from './portable.ts';
import type { PortableImportOptions, PortablePolicyManifest, PortableImportResult, PortableExportResult, PortableGuidance, PortableRelationship, LegacyPortableSource } from './portable.ts';
import type { Harness, Memory, MemoryOptions } from './types.ts';
import { ownershipPatch, portableFields, previousOwnership, creationMetadata, PORTABLE_FIELDS, validFields, projectSourceFields } from './portable-ownership.ts';
import type { OwnedTarget, PortableFields } from './portable-ownership.ts';
import { applyImport, expectedTargets, importIdentity, validateImportPlan, recoverInput, previewImport } from './portable-plan.ts';
import { originCatalog, selectOrigin, sameOrigin, ensureTrackerOrigin } from './portable-origin.ts';
import type { PortableOrigin } from './portable-origin.ts';
import { sourceDocument, stemOf, documentPatch, encodeDocument, safePath, readDocument } from './portable-source.ts';
export { safePath } from './portable-source.ts';
import type { Source } from './portable-source.ts';

/** Keep this immutable companion with byte-preserved legacy files through harness edits. */
export const LEGACY_ORIGINS = 'pm-memory-origins.json';
/** Typed wire envelope; the checksummed snapshot payload is machine-owned. */
export interface LegacyOriginManifest {
  /** Exact companion format version. */
  version: 1;
  /** Stable companion discriminator. */
  format: 'pm-memory-origins';
  /** Harness interpreting the raw body files. */
  harness: Exclude<Harness, 'cursor'>;
  /** Immutable JSON snapshot records; edit the adjacent guidance files instead. */
  payload: string;
  /** Integrity digest of the immutable payload. */
  checksum: string;
}
/** Native semantics and immutable identity accompanying one original legacy file. */
export interface LegacyOriginRecord {
  /** Confined raw file name. */
  file: string;
  /** SDK-native portable snapshot, including retained relationships and origin. */
  guidance: PortableGuidance;
  /** SDK-normalized decoding baseline for supported harness field edits. */
  decoded: PortableFields;
  /** Original raw wiki references; absent text never grants deletion authority. */
  links: string[];
  /** Native index disposition. */
  artifact: boolean;
}

/** Refuse unsupported import/export harness names before filesystem access. */
export function harness(value: unknown, exporting = false): Harness {
  if (!['claude-code', 'agents-md', ...(exporting ? [] : ['cursor'])].includes(String(value))) throw new MemoryError('format', 'Unsupported memory format', 'Use claude-code or agents-md; cursor is import-only');
  return value as Harness;
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
/** Original bytes must reproduce all portable fields, including implicit legacy defaults. */
function sameContent(item: Memory, source: Source): boolean {
  const native = portableFields(item, item.body); const decoded = portableFields({ ...source, pinned: false, tags: [] }, source.body);
  return item.slug === source.slug && PORTABLE_FIELDS.every(field => native[field] === decoded[field]);
}
/** Resolve only unique wire aliases over an already origin-bound inventory. */
function referenceTarget(reference: string, memories: readonly Pick<Memory, 'id' | 'slug' | 'path'>[]) {
  const exact = memories.filter(item => item.slug === reference);
  const choices = exact.length > 0 ? exact : memories.filter(item => stemOf(item.path) === reference);
  return choices.length === 1 ? choices[0] : undefined;
}
/** Legacy wiki references own additions; absent text cannot prove deletion ownership. */
function sourceRelationships(source: Source, memories: readonly Pick<Memory, 'id' | 'slug' | 'path'>[]): PortableRelationship[] {
  return source.links.flatMap(reference => {
    const target = referenceTarget(reference, memories);
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
  return value?.memory_source === `${from}:relative-file` && value.memory_path === source.path;
}
/** Validate all represented raw bytes, including unknown frontmatter, before target writes. */
function sourcePrivacy(input: readonly { path: string; bytes: Buffer }[], allowEmail?: boolean): void {
  const offenses: string[] = [];
  for (const source of input) {
    const content = source.bytes.toString('utf8');
    try { privacy(content, allowEmail); }
    catch (error) {
      const before = offenses.length;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        try { privacy(line, allowEmail); }
        catch (error) { offenses.push(`${source.path}:line ${index + 1} (${(error as MemoryError).message})`); }
      }
      if (offenses.length === before) offenses.push(`${source.path}:multiline (${(error as MemoryError).message})`);
    }
  }
  if (offenses.length > 0) throw new MemoryError('privacy', `Import refused: ${offenses.join('; ')}`, 'Edit each listed file to remove credentials or addresses; --allow-email permits email addresses only');
}
/** Validate an immutable legacy snapshot before reading any target state. */
export function parseLegacyOrigins(value: unknown, from: Harness): LegacyOriginRecord[] {
  const refuse = (): never => { throw new MemoryError('format', 'Invalid legacy origin companion', 'Restore pm-memory-origins.json and edit only its adjacent guidance files'); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const envelope = value as LegacyOriginManifest;
  if (Object.keys(envelope).sort().join(',') !== 'checksum,format,harness,payload,version' || envelope.version !== 1 || envelope.format !== 'pm-memory-origins' || envelope.harness !== from || typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.checksum) return refuse();
  let values: unknown; try { values = JSON.parse(envelope.payload); } catch { return refuse(); }
  if (!Array.isArray(values) || values.some((row: unknown) => row === null || typeof row !== 'object' || Array.isArray(row))) return refuse();
  const objects = values as Record<string, unknown>[];
  const guidance = parsePolicy({ version: 1, format: 'pm-memory-policy', harness: from, guidance: objects.map(row => row.guidance) }).guidance;
  const records = objects.map((value, index): LegacyOriginRecord => {
    const row = value;
    if (Object.keys(row).sort().join(',') !== 'artifact,decoded,file,guidance,links' || typeof row.file !== 'string' || !validFields(row.decoded) || !Array.isArray(row.links) || !row.links.every((link: unknown) => typeof link === 'string') || typeof row.artifact !== 'boolean' || guidanceOrigin(guidance[index]) === undefined || guidance[index].validity !== null) return refuse();
    return { file: safePath(row.file), guidance: guidance[index], decoded: row.decoded, links: row.links, artifact: row.artifact };
  });
  if (new Set(records.map(row => row.file)).size !== records.length) return refuse();
  return records;
}
/** Project supported raw harness edits onto the native snapshot, then reuse policy validation/CAS. */
async function importBoundLegacy(input: readonly { path: string; bytes: Buffer }[], options: PortableImportOptions): Promise<PortableImportResult> {
  let value: unknown; try { value = JSON.parse(input.find(file => file.path === LEGACY_ORIGINS)!.bytes.toString('utf8')); } catch { throw new MemoryError('format', 'Unreadable legacy origin companion', 'Restore pm-memory-origins.json before importing'); }
  const records = parseLegacyOrigins(value, options.from);
  sourcePrivacy(input.filter(file => records.some(record => record.file === file.path)), options.allowEmail);
  const files: { path: string; bytes: Buffer }[] = []; const provenance = new Map<string, LegacyPortableSource>();
  let unresolved = 0;
  const references = records.map(record => ({ id: record.guidance.slug, slug: record.guidance.slug, path: record.file }));
  for (const record of records) {
    const file = input.find(file => file.path === record.file);
    if (file === undefined) throw new MemoryError('origin_missing', 'An origin-bound legacy file is missing', 'Restore the complete exported inventory; absence does not delete a native origin');
    const source = sourceDocument(file.path, file.bytes, options.from); const row = structuredClone(record.guidance);
    projectSourceFields(row, source, record.decoded);
    const added = source.links.filter(link => !record.links.includes(link));
    const additions = sourceRelationships({ ...source, slug: row.slug, links: added }, references);
    for (const edge of additions) if (!row.relationships.some(prior => prior.slug === edge.slug && prior.kind === edge.kind)) row.relationships.push(edge);
    for (const link of added) if (referenceTarget(link, references) === undefined) unresolved++;
    files.push({ path: row.path, bytes: policyBody(row, source.body) });
    provenance.set(row.slug, { original: source.original, path: file.path, artifact: record.artifact, harness: options.from });
    record.guidance = row;
  }
  files.push({ path: POLICY_MANIFEST, bytes: Buffer.from(JSON.stringify({ version: 1, format: 'pm-memory-policy', harness: options.from, guidance: records.map(record => record.guidance) })) });
  const result = await importPolicy(files, options, provenance); result.unresolved_links += unresolved;
  for (const file of input) if (file.path !== LEGACY_ORIGINS && !records.some(record => record.file === file.path)) result.skipped.push({ slug: file.path, reason: 'Foreign file absent from the immutable origin inventory' });
  return result;
}
/** Import regular harness files idempotently, resolving wiki references into native links. */
export async function importDir(path: string, options: PortableImportOptions): Promise<{ imported: number; updated: number; unchanged: number; unresolved_links: number } | PortableImportResult> {
  harness(options.from);
  const input = await sources(path);
  if (input.some(file => file.path === POLICY_MANIFEST)) return importPolicy(input, options);
  if (input.some(file => file.path === LEGACY_ORIGINS)) return importBoundLegacy(input, options);
  if (input.some(file => file.bytes.includes('pm-memory-policy:v1'))) throw new MemoryError('validity', 'Portable policy manifest is missing', 'Keep pm-memory-policy.json with every exported body file and import the complete directory');
  sourcePrivacy(input, options.allowEmail);
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
    const catalog = await originCatalog(store, new Set(corpus.map(item => item.id)));
    const selected = new Map<string, Memory>(); const skipped = new Map<string, string>();
    const intakeOrigins = new Map<string, PortableOrigin>(); const births = new Map<string, Source>();
    for (const source of parsed) {
      const creators = catalog.creators.filter(row => !row.compensated && legacyOrigin(row.metadata, source, options.from));
      const unproven = initial.some(item => {
        if (!((item.source === `${options.from}:relative-file` && item.slug === source.slug) || creators.some(row => row.id === item.id))) return false;
        const original = origins.get(item.id)?.memory_original; if (typeof original !== 'string') return true;
        try { births.set(item.id, sourceDocument(source.path, Buffer.from(original, 'base64'), options.from)); return false; } catch { return true; }
      });
      if (unproven) { skipped.set(source.slug, 'Foreign legacy record has no immutable source provenance'); continue; }
      const distinct = creators.filter((row, index) => creators.findIndex(other => sameOrigin(other.origin, row.origin)) === index);
      if (distinct.length > 1) throw new MemoryError('conflict', 'Ambiguous immutable legacy intake origin', 'Import the complete exported companion manifest to select an origin');
      if (distinct.length === 1) {
        const origin = distinct[0].origin; intakeOrigins.set(source.slug, origin);
        if (creators.some(row => corpus.some(item => item.id === row.id) && !initial.some(item => item.id === row.id))) { skipped.set(source.slug, 'Foreign record owns the immutable intake origin'); continue; }
        const target = selectOrigin(origin, initial, catalog, options.createMissingOrigins === true);
        if (target !== undefined) selected.set(source.slug, target);
      }
      if (!selected.has(source.slug) && initial.some(item => item.slug === source.slug)) throw new MemoryError('conflict', 'Legacy alias belongs to a different immutable origin', 'Import the complete exported metadata or rename the unrelated native alias');
    }
    const ids = new Map(parsed.map(source => [source.slug, selected.get(source.slug)?.id ?? `${settings.id_prefix}${digest(`${identity.transactionId}:${source.slug}`).slice(0, 24)}`]));
    // Explicit inventory aliases shadow external history hints, including skipped inventory rows.
    const aliases = new Set(parsed.flatMap(source => [source.slug, stemOf(source.path)]));
    // Only creation-time intake aliases bind targets outside this raw input. Current native names grant no authority.
    const external = catalog.creators.flatMap(row => initial.some(item => item.id === row.id) && row.metadata.memory_source === `${options.from}:relative-file` && typeof row.metadata.memory_original === 'string' && typeof row.metadata.memory_path === 'string' && !aliases.has(String(row.metadata.memory_slug)) && !aliases.has(stemOf(row.metadata.memory_path)) ? [{ id: row.id, slug: String(row.metadata.memory_slug), path: row.metadata.memory_path }] : []);
    const references = [...new Map([...external, ...parsed.map(source => ({ id: ids.get(source.slug)!, slug: source.slug, path: source.path }))].map(row => [row.id, row])).values()];
    const baselineIds = new Map([...references.map(item => [item.slug, item.id] as const), ...ids]);
    for (const source of parsed) if (!selected.has(source.slug) && foreign.some(item => item.memory_slug === source.slug || legacyOrigin(origins.get(item.id), source, options.from))) skipped.set(source.slug, 'Foreign record has no package-owned source');
    closeSkips(parsed.map(source => ({ slug: source.slug, relationships: sourceRelationships(source, references) })), skipped);
    const result = { imported: 0, updated: 0, unchanged: 0, unresolved_links: 0, skipped: [...foreign.filter(item => !parsed.some(source => source.slug === item.memory_slug && skipped.has(source.slug))).map(item => ({ slug: item.id, reason: 'Foreign record has no package-owned source' })), ...[...skipped].map(([slug, reason]) => ({ slug, reason }))] };
    const mutations: BulkItemMutation[] = []; const ownership: OwnedTarget[] = [];
    for (const source of parsed) {
      if (skipped.has(source.slug)) continue;
      const previous = selected.get(source.slug); const id = ids.get(source.slug)!;
      const origin = previous === undefined ? undefined : origins.get(previous.id);
      if (previous?.validity !== undefined) throw new MemoryError('validity', 'Import would remove the portable policy window', 'Keep pm-memory-policy.json with every exported body file and import the complete directory');
      if (previous !== undefined && !legacyOrigin(origin, source, options.from)) throw new MemoryError('conflict', 'Import would overwrite an independently edited memory', 'Export or rename the source before retrying');
      const relationships = sourceRelationships(source, references);
      for (const reference of source.links) if (referenceTarget(reference, references) === undefined) result.unresolved_links++;
      if (previous === undefined) {
        const graph = relationships.map(({ slug, ...edge }) => ({ ...edge, id: baselineIds.get(slug)! }));
        const fields = { slug: source.slug, kind: source.kind, why: source.why, how: source.how, pinned: false, source: `${options.from}:relative-file`, recalls: 0, verdict: 'unknown', verified_at: '', original: source.original, document: encodeDocument({ version: 1, format: 'legacy', harness: options.from, path: source.path, original: source.original }), path: source.path, edited: false, artifact: source.artifact, changed_at: new Date().toISOString(), ...(intakeOrigins.has(source.slug) ? { origin: JSON.stringify(intakeOrigins.get(source.slug)) } : {}) };
        mutations.push({ op: 'create', id, unique: { key: 'memory_slug', value: source.slug }, options: { title: source.title, body: source.body, description: source.description, type: 'Knowledge', allowDuplicate: true, allowUnresolvedDeps: true, ...itemDocumentToMutationOptions(JSON.stringify({ dependencies: graph }), 'create'), ...metadata(fields) } });
        ownership.push(sourceReceipt({ id, fields: portableFields({ ...source, pinned: false, tags: [] }, source.body), relationships: graph, graph, documentHash: digest(String(mutations.at(-1)!.options!.memoryDocument)) }, source)); result.imported++;
      } else {
        const before = births.get(previous.id)!;
        const prior = await previousOwnership(store, previous, baselineIds);
        const row = sourceOwnership(source, before, previous, references);
        const patch = ownershipPatch(previous, row, source.body, baselineIds, baselineIds, prior, false);
        const next = { version: 1 as const, format: 'legacy' as const, harness: options.from, path: source.path, original: source.original };
        const current = previous.document ?? { ...next, original: prior?.source?.original ?? before.original };
        const unchangedDocument = Buffer.from(policyPayload({ ...previous, document: current })).toString('base64') === source.original;
        const document = unchangedDocument ? { options: {}, conflict: false } : documentPatch(previous, next, prior?.source?.original ?? before.original, prior?.sourceEdited, prior?.documentHash);
        Object.assign(patch.options, document.options); if (document.conflict) patch.conflicts.push('document');
        let policyBodyHash = previous.policyBody !== undefined && prior?.policyBodyHash === digest(encodeDocument(previous.policyBody)) ? prior.policyBodyHash : undefined;
        if (previous.policyBody !== undefined && !patch.conflicts.includes('body') && policyParts(previous).body !== source.body) {
          const body = { version: 1 as const, format: 'policy' as const, harness: options.from, path: source.path, original: Buffer.from(source.body).toString('base64') };
          const updated = documentPatch({ document: previous.policyBody }, body, undefined, prior?.bodyEdited || prior?.policyBodyHash === undefined, prior?.policyBodyHash);
          if (updated.conflict) { delete patch.options.body; patch.conflicts.push('body'); }
          if (updated.options.memoryDocument !== undefined) { patch.options.memoryPolicyBody = updated.options.memoryDocument; policyBodyHash = digest(encodeDocument(body)); }
        }
        if (patch.conflicts.length > 0) {
          if (Object.keys(patch.options).length === 0) throw new MemoryError('conflict', 'Import would overwrite an independently edited memory', 'Export or rename the source before retrying');
          result.skipped.push({ slug: source.slug, reason: `Independently edited native fields retained: ${patch.conflicts.join(', ')}` });
        }
        if (Object.keys(patch.options).length === 0) { result.unchanged++; continue; }
        await store.history(previous.id);
        const documentHash = document.options.memoryDocument !== undefined ? digest(String(document.options.memoryDocument)) : previous.document !== undefined && prior?.documentHash === digest(encodeDocument(previous.document)) ? prior.documentHash : undefined;
        ownership.push(sourceReceipt({ ...patch.ownership, ...(documentHash === undefined ? {} : { documentHash }), ...(policyBodyHash === undefined ? {} : { policyBodyHash }) }, source)); result.updated++;
        mutations.push({ op: 'update', id, match: { key: 'updated_at', value: corpus.find(item => item.id === id)!.updated_at }, options: patch.options });
      }
    }
    if (mutations.length === 0) { const { skipped: refusals, ...counts } = result; return refusals.length === 0 ? counts : result; }
    const readSet = new Map(parsed.filter(source => !skipped.has(source.slug)).map(source => [ids.get(source.slug)!, selected.get(source.slug)?.slug ?? source.slug]));
    for (const target of ownership) for (const edge of target.relationships) if (!readSet.has(edge.id)) readSet.set(edge.id, initial.find(item => item.id === edge.id)!.slug);
    const expected = await expectedTargets(store, [...readSet].map(([id, slug]) => ({ id, slug, origin: catalog.creators.find(row => row.id === id)?.origin })), corpus);
    const plan = { identityVersion: 1 as const, ...identity, input: inputHash, author: resolveAuthorIdentity(options.author, settings.author_default).author, mutations, ownership, expected, initial: expected, members: expected.map(row => row.id), result };
    await validateImportPlan(store, plan, options.onStep); await store.register(options.onStep);
    await previewImport(store, plan, options.onStep);
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
    return item !== undefined && targets.has(item.id) ? `[[${reference}]]` : reference;
  }));
}
/** Canonical raw bodies and explicit ownership avoid changing native state through projection. */
async function policyOutputs(store: Store, active: readonly Memory[], to: Exclude<Harness, 'cursor'>, catalog: Awaited<ReturnType<typeof originCatalog>>): Promise<Map<string, Buffer>> {
  const guidance = await Promise.all(active.map(item => policyRecord(store, item, active, catalog)));
  const manifest: PortablePolicyManifest = parsePolicy({ version: 1, format: 'pm-memory-policy', harness: to, guidance });
  const outputs = new Map<string, Buffer>([[POLICY_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]]);
  for (const [index, row] of guidance.entries()) outputs.set(row.path, policyBody(row, policyPayload(active[index])));
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
      const previous = await previousOwnership(store, item, ids);
      if (previous === undefined || previous.creation) unreceipted.add(item.id);
      if ((previous?.nativeRelationships?.length ?? 0) > 0) nativeGraphEdits.add(item.id);
      const source = previous?.source;
      const born = item.document === undefined && source !== undefined ? await creationMetadata(store, item.id) : undefined;
      const document = item.document ?? readDocument({ version: 1, format: 'legacy', harness: String(born?.memory_source).split(':')[0], path: born?.memory_path, original: source?.original });
      const original = document?.format === 'legacy' && document.harness === options.to && document.path === item.path ? document.original : source?.original;
      return { ...item, document, ...(original === undefined ? {} : { original }) };
    }));
    await ensureTrackerOrigin(store); const catalog = await originCatalog(store);
    const foreignReceipt = foreign.length === 0 ? {} : { skipped: foreign.map(item => ({ slug: item.id, reason: 'Foreign record has no package-owned source' })) };
    if (memories.some(item => item.consent !== undefined && item.status !== 'canceled' && !item.artifact)) throw new MemoryError('consent', 'Portable harness formats cannot preserve source consent', 'Use memory view with an explicit purpose and fields; retain its manifest for withdrawal checks');
    const active = memories.filter(item => item.status !== 'canceled' && !item.artifact).sort((a, b) => a.slug.localeCompare(b.slug));
    const omitted_links: NonNullable<PortableExportResult['omitted_links']> = active.flatMap(item => item.relationships.flatMap(edge => {
        if (active.some(target => target.id === edge.id)) return [];
        const target = memories.find(target => target.id === edge.id);
        return [{ slug: item.slug, target: edge.id, kind: edge.kind, reason: target === undefined ? 'missing' as const : target.status === 'canceled' ? 'canceled' as const : 'artifact' as const }];
    }));
    const lossy: NonNullable<PortableExportResult['lossy']> = active.flatMap(item => {
      const fields: NonNullable<PortableExportResult['lossy']>[number]['fields'] = [];
      if (omitted_links.some(edge => edge.slug === item.slug)) fields.push('relationships');
      if (item.relationships.some(edge => edge.author_source !== undefined && edge.author_source !== 'asserted')) fields.push('relationships.author_source');
      return fields.length === 0 ? [] : [{ slug: item.slug, fields, reason: 'External targets are unknown in this inventory; SDK-authored relationship provenance is reasserted on fresh creation' }];
    });
    /** Publication and receipts have one lease-fenced path for both wire encodings. */
    const commit = async (outputs: Map<string, Buffer>, byte_preserved: number): Promise<PortableExportResult> => {
      await store.fence(() => publish(resolve(path), outputs, options.onStep));
      const artifacts: NonNullable<PortableExportResult['lossy']> = outputs.has(POLICY_MANIFEST) ? memories.filter(item => item.artifact && item.status !== 'canceled').map(item => ({ slug: item.slug, fields: ['slug', ...PORTABLE_FIELDS, 'relationships', 'artifact', ...(item.document === undefined ? [] : ['document' as const])], reason: 'Native index artifact is regenerated; its record is outside this policy inventory' })) : [];
      const losses = [...lossy, ...artifacts];
      return { exported: outputs.size, byte_preserved, ...foreignReceipt, ...(losses.length === 0 ? {} : { lossy: losses }), ...(omitted_links.length === 0 ? {} : { omitted_links }) };
    };
    if (memories.length === 0 || memories.some(item => item.validity !== undefined || item.source === 'native:item' || item.source === 'portable:policy-v1')) {
      return commit(await policyOutputs(store, active, options.to, catalog), 0);
    }
    const originals = new Map(memories.filter(item => item.status !== 'canceled').map(item => [item.id, item.path !== '' && !item.edited && !nativeGraphEdits.has(item.id) && item.source === `${options.to}:relative-file` ? sourceDocument(safePath(item.path), Buffer.from(item.original, 'base64'), options.to) : undefined]));
    const decodedKeys = [...originals.values()].flatMap(source => source === undefined ? [] : [source.slug]);
    if (new Set(decodedKeys).size !== decodedKeys.length) throw new MemoryError('conflict', 'Export names collide: normalized duplicate slugs', 'Rename the conflicting legacy source names before exporting');
    const indexName = options.to === 'claude-code' ? 'MEMORY.md' : 'AGENTS.md';
    const names = new Set([indexName.toLowerCase()]);
    const records: LegacyOriginRecord[] = [];
    const outputs = new Map<string, Buffer>(); const emitted: { item: Memory; name: string }[] = []; const preserved = new Set<string>();
    for (const item of memories) {
      if (item.status === 'canceled') continue;
      await store.history(item.id);
      let name: string; let bytes: Buffer;
      const source = originals.get(item.id);
      const unprovenGraph = source !== undefined && unreceipted.has(item.id) && (item.relationships.length > 0 || source.links.length > 0);
      if (source !== undefined && !unprovenGraph && sameContent(item, source)) {
        name = safePath(item.path); bytes = Buffer.from(item.original, 'base64'); preserved.add(name);
      } else if (!item.artifact) return commit(await policyOutputs(store, active, options.to, catalog), 0);
      else continue;
      if (name.toLowerCase() === LEGACY_ORIGINS) return commit(await policyOutputs(store, active, options.to, catalog), 0);
      const folded = name.toLowerCase();
      const originalIndex = name === indexName && item.path === name && !item.edited;
      if (outputs.has(name) || (names.has(folded) && !originalIndex)) throw new MemoryError('conflict', 'Export names collide', 'Rename the conflicting memory slug or source path, including reserved index names');
      names.add(folded);
      outputs.set(name, bytes);
      const decoded = sourceDocument(name, bytes, options.to);
      records.push({ file: name, guidance: await policyRecord(store, item, memories, catalog), decoded: portableFields({ ...decoded, pinned: false, tags: [] }, decoded.body), links: decoded.links, artifact: item.artifact });
      if (!item.artifact) emitted.push({ item, name });
    }
    const original = outputs.get(indexName);
    const losslessIndex = original !== undefined && (options.to === 'claude-code'
      ? currentIndex(original, emitted.map(row => row.name))
      : emitted.every(row => row.name === indexName || original.includes(outputs.get(row.name)!)));
    if (!losslessIndex) return commit(await policyOutputs(store, active, options.to, catalog), 0);
    const targets = new Map(emitted.map(({ item, name }) => [item.id, sourceDocument(name, outputs.get(name)!, options.to)]));
    for (const bytes of outputs.values()) if (!exportedReferences(bytes, memories, targets).equals(bytes)) return commit(await policyOutputs(store, active, options.to, catalog), 0);
    const payload = JSON.stringify(records);
    const companion: LegacyOriginManifest = { version: 1, format: 'pm-memory-origins', harness: options.to, payload, checksum: digest(payload) };
    outputs.set(LEGACY_ORIGINS, Buffer.from(JSON.stringify(companion, null, 2) + '\n'));
    return commit(outputs, preserved.size);
  });
}
