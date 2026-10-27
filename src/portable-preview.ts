import { constants } from 'node:fs';
import { lstat, readdir, open, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PmClient, certifyCompleteListResult, readSettings, writeSettings, runWithConfigurationOnlySettings, resolveTransactionSchema, resolveItemTypeRegistry, locateItem, getItemPath, getHistoryPath, previewItemMutations } from '@unbrained/pm-cli/sdk';
import type { BulkItemMutation } from '@unbrained/pm-cli/sdk';
import type { ImportPlan } from './portable-plan.ts';
import type { PortableImportOptions } from './portable.ts';
import type { Store } from './store.ts';
import { MemoryError } from './core.ts';

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

/** Keep SDK schema/lifecycle validation while excluding installed code from its snapshot. */
export async function previewOwnedItems(store: Store, plan: ImportPlan, mutations: BulkItemMutation[], onStep?: PortableImportOptions['onStep']): Promise<void> {
  if (!await hasPreviewPackages(store.workspace)) { await previewItemMutations({ ...plan, mutations, pmRoot: store.workspace }); return; }
  const scratch = await mkdtemp(join(tmpdir(), 'pm-memory-preview-'));
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
    await onStep?.('preview-settings');
    const items = certifyCompleteListResult(await store.client.listAllComplete({ includeBody: true })).items;
    await onStep?.('preview-listed');
    for (const item of items) {
      const located = await locateItem(store.workspace, item.id, settings.id_prefix, settings.item_format, registry.type_to_folder);
      await onStep?.(`preview-located:${item.id}`);
      if (located === null || !await copyPreviewFile(located.itemPath, getItemPath(workspace, located.type, item.id, located.item_format, registry.type_to_folder))) throw new MemoryError('conflict', 'Preview target revision moved', 'Retry the import; native edits and foreign files were retained');
      await onStep?.(`preview-item:${item.id}`);
    }
    // Only admitted targets need their native revision streams; foreign histories stay unknown.
    for (const target of plan.expected) {
      await copyPreviewFile(getHistoryPath(store.workspace, target.id), getHistoryPath(workspace, target.id));
      await onStep?.(`preview-history:${target.id}`);
    }
    await previewItemMutations({ ...plan, mutations, pmRoot: workspace });
    await onStep?.('preview-validated');
  } finally { await rm(scratch, { recursive: true, force: true }); }
  await onStep?.('preview-cleaned');
}
