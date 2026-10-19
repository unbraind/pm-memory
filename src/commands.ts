import { createPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from '@unbrained/pm-cli/sdk/authoring';
import { kind, MemoryError, text } from './core.ts';
import { remember, recall, index } from './memory.ts';
import { exportDir, harness, importDir } from './transfer.ts';
import { verify } from './verify.ts';
import { consolidate } from './consolidate.ts';
import { MEMORY_FIELDS } from './store.ts';

/** Dispatch native command operands to the documented in-process API. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const base = { workspace: ctx.pm_root, author: ctx.global.author };
    const options = ctx.options;
    if (command === 'remember') return await remember(text(ctx.args[0]), { ...base, kind: kind(options.kind), slug: options.slug === undefined ? undefined : text(options.slug), update: options.update === undefined ? undefined : text(options.update), why: options.why === undefined ? undefined : text(options.why), how: options.how === undefined ? undefined : text(options.how), pin: options.pin === true ? true : undefined, forceNew: options.forceNew === true, allowEmail: options.allowEmail === true, links: options.link === undefined ? [] : (Array.isArray(options.link) ? options.link : [options.link]).map(text) });
    if (command === 'recall') return await recall(text(ctx.args[0]), { ...base, budget: options.budget === undefined ? undefined : Number(options.budget), kind: options.kind === undefined ? undefined : kind(options.kind) });
    if (command === 'index') return await index({ ...base, budget: options.budget === undefined ? undefined : Number(options.budget) });
    if (command === 'import') return await importDir(text(ctx.args[0]), { ...base, from: harness(options.from), allowEmail: options.allowEmail === true });
    if (command === 'export') return await exportDir(text(ctx.args[0]), { ...base, to: harness(options.to, true) as 'claude-code' | 'agents-md' });
    if (command === 'verify') return await verify({ ...base, root: options.root === undefined ? undefined : text(options.root), slug: options.slug === undefined ? undefined : text(options.slug), network: options.network === true });
    if (command === 'consolidate') return await consolidate({ ...base, apply: options.apply === true });
    throw new MemoryError('invalid', 'Unknown memory command', 'Run pm memory --help');
  } catch (error) {
    const refusal = error instanceof MemoryError ? error : new MemoryError('sdk', 'Memory operation could not complete', 'Check source permissions, tracker integrity and pm health before retrying');
    throw createPmCliExpectedError(`memory ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: refusal.code === 'privacy' ? 4 : refusal.code === 'duplicate' || refusal.code === 'conflict' ? 3 : 2 });
  }
}
/** Build uniform typed flags with native repeatable link handling. */
function flags(strings: string[], booleans: string[]): FlagDefinition[] {
  return [...strings.map(name => ({ long: `--${name}`, description: name, value_name: 'value', value_type: 'string' as const, repeatable: name === 'link' })), ...booleans.map(name => ({ long: `--${name}`, description: name, value_type: 'boolean' as const }))];
}
/** Register native host commands, renderer behavior, custom Knowledge type and extension metadata. */
export function register(api: ExtensionApi): void {
  api.registerItemFields(MEMORY_FIELDS);
  api.registerItemTypes([{ name: 'Knowledge', folder: 'knowledge', description: 'Durable agent knowledge', default_status: 'open' }]);
  for (const [name, strings, booleans, argument] of [
    ['remember', ['kind', 'slug', 'update', 'why', 'how', 'link'], ['pin', 'force-new', 'allow-email'], 'fact'],
    ['recall', ['budget', 'kind'], [], 'query'],
    ['index', ['budget'], [], ''],
    ['import', ['from'], ['allow-email'], 'source'],
    ['export', ['to'], [], 'directory'],
    ['verify', ['slug', 'root'], ['network'], ''],
    ['consolidate', [], ['apply'], ''],
  ] as const) api.registerCommand(defineCommand({ name: `memory ${name}`, description: `${name} shared long-term agent memory`, intent: 'Project management = context management; agents manage their own memory', arguments: argument === '' ? [] : [{ name: argument, required: true }], flags: flags([...strings], [...booleans]), examples: [`pm memory ${name} --help`], run: ctx => runCommand(name, ctx) }));
}
