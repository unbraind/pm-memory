import { constants } from 'node:fs';
import { lstat, readdir, open, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PmClient, certifyCompleteListResult, readSettings, writeSettings, runWithConfigurationOnlySettings, resolveTransactionSchema, resolveItemTypeRegistry, locateItem, getItemPath, getHistoryPath, previewItemMutations, commitItemMutations, getItemAt, canonicalDocument, serializeItemDocument, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation } from '@unbrained/pm-cli/sdk';
import { validateImportPlan } from './portable-plan.ts';
import { Store } from './store.ts';
import type { ImportPlan } from './portable-plan.ts';
import type { PortableImportOptions } from './portable.ts';
import { digest, MemoryError } from './core.ts';

/** Installed packages are foreign to item preview, including their dependency links. */
export async function hasPreviewPackages(workspace: string): Promise<boolean> {
  const path = join(workspace, 'extensions');
  try { return !(await lstat(path)).isDirectory() || (await readdir(path)).length > 0; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

/** Copy exact SDK-located bytes into our private projection, never following links. */
export async function copyPreviewFile(source: string, destination: string): Promise<boolean> {
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new MemoryError('history', 'Preview source is not a readable regular file', 'Restore the verified tracker item or history file and retry'); }
  try {
    if (!(await file.stat()).isFile()) throw new MemoryError('history', 'Preview source is not a regular file', 'Restore the verified tracker item or history file and retry');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await file.readFile(), { flag: 'wx' });
    return true;
  } finally { await file.close(); }
}

/** Use one configuration-only SDK projection for validation and independent birth evidence. */
async function withProjection<T>(store: Store, plan: ImportPlan, excluded: ReadonlySet<string>, run: (workspace: string) => Promise<T>, onStep?: PortableImportOptions['onStep']): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), 'pm-memory-preview-'));
  let result: T;
  try {
    await onStep?.('preview-created');
    const { settings, context } = await runWithConfigurationOnlySettings(store.workspace, async () => {
      const settings = await readSettings(store.workspace);
      return { settings, context: await resolveTransactionSchema(store.workspace, settings) };
    });
    const definitions = [...new Map([...settings.item_types.definitions, ...context.typeDefinitionsFromFile].map(type => [type.name, type])).values()];
    const selected = { ...settings, item_types: { definitions }, schema: { ...context.schema, files: {} } };
    const registry = resolveItemTypeRegistry(selected);
    const workspace = join(scratch, '.agents', 'pm');
    const client = new PmClient({ pmRoot: workspace, noExtensions: true, author: plan.author });
    await client.init('memory-preview', { defaults: true, agentGuidance: 'skip', mergeFence: false });
    await writeSettings(workspace, selected);
    await copyPreviewFile(join(store.workspace, 'memory-origin.json'), join(workspace, 'memory-origin.json'));
    await onStep?.('preview-settings');
    const items = certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
    await onStep?.('preview-listed');
    for (const item of items.filter(item => !excluded.has(item.id))) {
      const located = await locateItem(store.workspace, item.id, settings.id_prefix, settings.item_format, registry.type_to_folder);
      await onStep?.(`preview-located:${item.id}`);
      if (located === null || !await copyPreviewFile(located.itemPath, getItemPath(workspace, located.type, item.id, located.item_format, registry.type_to_folder))) throw new MemoryError('conflict', 'Preview target revision moved', 'Retry the import; native edits and foreign files were retained');
      await onStep?.(`preview-item:${item.id}`);
    }
    // Only admitted targets need their native revision streams; foreign histories stay unknown.
    for (const target of plan.expected.filter(target => !excluded.has(target.id))) {
      await copyPreviewFile(getHistoryPath(store.workspace, target.id), getHistoryPath(workspace, target.id));
      await onStep?.(`preview-history:${target.id}`);
    }
    result = await run(workspace);
    await onStep?.('preview-validated');
  } finally { await rm(scratch, { recursive: true, force: true }); }
  await onStep?.('preview-cleaned');
  return result;
}

/** Full SDK birth document with only SDK-generated wall-clock values made comparable. */
export function birthDocument(document: Parameters<typeof canonicalDocument>[0]): string {
  return serializeItemDocument(canonicalDocument({ ...document, metadata: { ...document.metadata, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' } }));
}
/** Actual edge-free creation requests, shared by preview and publication. */
export function prepareImportNodes(plan: ImportPlan): BulkItemMutation[] {
  plan.mutations = plan.mutations.map(row => row.op === 'create' ? { ...row, options: { ...row.options, memoryBirth: 'portable-v1' } } : row);
  return plan.mutations.filter(row => row.op === 'create').map(row => {
    const { dep: _dep, allowUnresolvedDeps: _unresolved, ...options } = row.options;
    return { ...row, options: { ...options, message: `bulk-item-transaction ${plan.transactionId}-nodes ${row.id} create` } };
  });
}
/** Carry the independent full-birth fingerprint in immutable SDK history, including tracker clones. */
export function sealBirths(plan: ImportPlan): void {
  const messages = new Map(plan.nodes!.map(row => [row.id, `${row.options!.message} memory-birth-v1:${digest(plan.births!.find(birth => birth.id === row.id)!.document)}`]));
  plan.nodes = plan.nodes!.map(row => ({ ...row, options: { ...row.options, message: messages.get(row.id)! } }));
  plan.births = plan.births!.map(row => ({ ...row, message: messages.get(row.id)! }));
}
/** Derive expected births exclusively from intended writes through the SDK in a private tracker. */
export async function captureBirths(store: Store, plan: ImportPlan): Promise<void> {
  if (plan.births !== undefined && plan.births.every(row => typeof row.message === 'string')) return;
  const prior = plan.births;
  const nodes = plan.nodes ?? plan.mutations.filter(row => row.op === 'create');
  if (nodes.length === 0) { plan.births = []; return; }
  const births = await withProjection(store, plan, new Set(nodes.map(row => row.id)), async workspace => {
    await commitItemMutations({ pmRoot: workspace, author: plan.author, transactionId: plan.nodes === undefined ? plan.transactionId : `${plan.transactionId}-nodes`, mutations: nodes, createCompensation: 'delete' });
    return Promise.all(nodes.map(async row => ({ id: row.id, document: birthDocument((await getItemAt(row.id, '1', { pmRoot: workspace })).document), message: (await readHistoryEntries(getHistoryPath(workspace, row.id), row.id))[0].message })));
  });
  Object.assign(plan, { births: births.map(row => ({ ...row, document: prior?.find(old => old.id === row.id)?.document ?? row.document })) });
}
/** Keep SDK schema/lifecycle validation while excluding installed code from its snapshot. */
export async function previewOwnedItems(store: Store, plan: ImportPlan, mutations: BulkItemMutation[], onStep?: PortableImportOptions['onStep']): Promise<void> {
  const creates = mutations.some(row => row.op === 'create');
  if (!creates && !await hasPreviewPackages(store.workspace)) {
    await validateImportPlan(store, plan);
    await previewItemMutations({ ...plan, mutations, pmRoot: store.workspace }); return;
  }
  await withProjection(store, plan, new Set(), async workspace => {
    const target = new Store({ workspace, author: plan.author });
    await validateImportPlan(target, plan);
    await previewItemMutations({ ...plan, mutations, pmRoot: workspace });
  }, onStep);
  if (creates) {
    plan.nodes = prepareImportNodes(plan);
    await captureBirths(store, plan);
    sealBirths(plan);
  }
}
