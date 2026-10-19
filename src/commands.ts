import { createPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from '@unbrained/pm-cli/sdk/authoring';
import { kind, MemoryError, text } from './core.ts';
import { remember, recall, index, get } from './memory.ts';
import { exportDir, harness, importDir } from './transfer.ts';
import { verify } from './verify.ts';
import { consolidate } from './consolidate.ts';
import { MEMORY_FIELDS } from './store.ts';

/** Dispatch native command operands to the documented in-process API. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const base = { workspace: ctx.pm_root, ...(ctx.global.author === undefined ? {} : { author: ctx.global.author }), client: ctx.sdk?.client };
    const options = ctx.options;
    if (command === 'remember') return await remember(text(ctx.args[0]), { ...base, kind: kind(options.kind), slug: options.slug === undefined ? undefined : text(options.slug), update: options.update === undefined ? undefined : text(options.update), why: options.why === undefined ? undefined : text(options.why), how: options.how === undefined ? undefined : text(options.how), pin: options.pin === true ? true : undefined, forceNew: options.forceNew === true, allowEmail: options.allowEmail === true, links: options.link === undefined ? [] : (Array.isArray(options.link) ? options.link : [options.link]).map(text) });
    if (command === 'recall') return await recall(text(ctx.args[0]), { ...base, budget: options.budget === undefined ? undefined : Number(options.budget), kind: options.kind === undefined ? undefined : kind(options.kind) });
    if (command === 'get') return await get(text(ctx.args[0]), base);
    if (command === 'index') return await index({ ...base, budget: options.budget === undefined ? undefined : Number(options.budget) });
    if (command === 'import') return await importDir(text(ctx.args[0]), { ...base, from: harness(options.from), allowEmail: options.allowEmail === true });
    if (command === 'export') return await exportDir(text(ctx.args[0]), { ...base, to: harness(options.to, true) as 'claude-code' | 'agents-md' });
    if (command === 'verify') return await verify({ ...base, root: options.root === undefined ? undefined : (Array.isArray(options.root) ? options.root : [options.root]).map(text), slug: options.slug === undefined ? undefined : text(options.slug), network: options.network === true });
    if (command === 'consolidate') return await consolidate({ ...base, apply: options.apply === true, minAgeDays: options.minAgeDays === undefined ? undefined : Number(options.minAgeDays) });
    throw new MemoryError('invalid', 'Unknown memory command', 'Run pm memory --help');
  } catch (error) {
    const refusal = error instanceof MemoryError ? error : new MemoryError('sdk', 'Memory operation could not complete', 'Check source permissions, tracker integrity and pm health before retrying');
    throw createPmCliExpectedError(`memory ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: refusal.code === 'privacy' ? 4 : refusal.code === 'duplicate' || refusal.code === 'conflict' ? 3 : 2 });
  }
}
/** Native flag descriptions include concrete examples in every option's help entry. */
const OPTIONS: Record<string, string> = {
  kind: 'Classify as user, feedback, project or reference (example: --kind project)',
  slug: 'Select a stable memory key (example: --slug release-policy)',
  update: 'Revise an existing memory (example: --update release-policy)',
  why: 'Explain the rationale (example: --why "Prevent broken releases")',
  how: 'Describe how to apply it (example: --how "Run both release gates")',
  link: 'Relate an item or memory; repeat to add more (example: --link build-policy)',
  pin: 'Prioritize standing guidance (example: remember "Run gates" --kind project --pin)',
  'force-new': 'Permit a distinct similar memory (example: --force-new --slug release-policy-v2)',
  'allow-email': 'Explicitly permit email addresses, never credentials (example: --allow-email)',
  budget: 'Bound the entire rendered packet in estimated tokens (example: --budget 800)',
  from: 'Read claude-code, agents-md or cursor files (example: --from claude-code)',
  to: 'Write claude-code or agents-md files (example: --to claude-code)',
  root: 'Search a source tree including nested repositories; repeat for more roots (example: --root . --root ../shared)',
  network: 'Check exact package versions and HTTP URLs online (example: verify --network)',
  apply: 'Apply reviewed consolidation proposals (example: consolidate --apply)',
  'min-age-days': 'Minimum content-change age for archive proposals, default 30 (example: --min-age-days 60)',
};
/** Build uniform typed flags with native repeatable link and root handling. */
function flags(strings: string[], booleans: string[]): FlagDefinition[] {
  return [...strings.map(name => ({ long: `--${name}`, description: OPTIONS[name], value_name: name === 'from' || name === 'to' ? 'format' : name, value_type: 'string' as const, repeatable: name === 'link' || name === 'root' })), ...booleans.map(name => ({ long: `--${name}`, description: OPTIONS[name], value_type: 'boolean' as const }))];
}
/** Descriptive commands and realistic invocations are carried through the native host help. */
const HELP: Record<string, [string, string, string]> = {
  remember: ['Create or revise durable agent knowledge with privacy and duplicate checks', 'A durable fact or guidance to retain', 'pm memory remember "Run both release gates" --kind project --slug release-policy --pin'],
  recall: ['Rank memories and return compact rows then excerpts within a token budget', 'Words describing the context needed', 'pm memory recall "release workflow" --budget 800'],
  get: ['Read the full memory selected by its stable slug', 'Memory slug from recall or index', 'pm memory get release-policy'],
  index: ['Render a bounded memory index, with pinned guidance first', '', 'pm memory index --budget 1500'],
  import: ['Import portable harness memories idempotently and resolve wiki links', 'A directory or regular memory file', 'pm memory import ./memories --from claude-code'],
  export: ['Export portable harness files, preserving unchanged imported bytes', 'Destination directory for exported memory files', 'pm memory export ./exported-memory --to claude-code'],
  verify: ['Check portable claims with verified, stale or unknown evidence and reasons', '', 'pm memory verify --root . --root ../shared'],
  consolidate: ['Propose merges, supersessions and confident unused stale archives; review before --apply', '', 'pm memory consolidate --min-age-days 30'],
};
/** Register native commands, useful help, renderer behavior and Knowledge metadata. */
export function register(api: ExtensionApi): void {
  api.registerItemFields(MEMORY_FIELDS);
  api.registerItemTypes([{ name: 'Knowledge', folder: 'knowledge', description: 'Durable agent knowledge', default_status: 'open' }]);
  for (const [name, strings, booleans, argument] of [
    ['remember', ['kind', 'slug', 'update', 'why', 'how', 'link'], ['pin', 'force-new', 'allow-email'], 'fact'],
    ['recall', ['budget', 'kind'], [], 'query'],
    ['get', [], [], 'slug'],
    ['index', ['budget'], [], ''],
    ['import', ['from'], ['allow-email'], 'source'],
    ['export', ['to'], [], 'directory'],
    ['verify', ['slug', 'root'], ['network'], ''],
    ['consolidate', ['min-age-days'], ['apply'], ''],
  ] as const) api.registerCommand(defineCommand({ name: `memory ${name}`, description: HELP[name][0], intent: 'Project management = context management; agents manage their own memory', arguments: argument === '' ? [] : [{ name: argument, required: true, description: HELP[name][1] + ` (example: ${HELP[name][2]})` }], flags: flags([...strings], [...booleans]), examples: [HELP[name][2]], run: ctx => runCommand(name, ctx) }));

}
