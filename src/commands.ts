import { createPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { defineCommand } from '@unbrained/pm-cli/sdk/authoring';
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from '@unbrained/pm-cli/sdk/authoring';
import { kind, MemoryError, text } from './core.ts';
import { remember, recall, index, get } from './memory.ts';
import { exportDir, harness, importDir } from './transfer.ts';
import { verify } from './verify.ts';
import { consolidate } from './consolidate.ts';
import { semanticMode } from './embeddings.ts';
import { observe, utility } from './utility.ts';
import type { ObserveOptions } from './utility-types.ts';
import { guidancePolicy, renew } from './guidance.ts';
import { createView, grantConsent, withdrawConsent, inspectView, viewFields } from './consent.ts';
import { MEMORY_FIELDS } from './store.ts';

/** Dispatch native command operands to the documented in-process API. */
export async function runCommand(command: string, ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const base = { workspace: ctx.pm_root, ...(ctx.global.author === undefined ? {} : { author: ctx.global.author }), client: ctx.sdk?.client };
    const options = ctx.options;
    if (command === 'remember') return await remember(text(ctx.args[0]), { ...base, kind: kind(options.kind), slug: options.slug === undefined ? undefined : text(options.slug), update: options.update === undefined ? undefined : text(options.update), why: options.why === undefined ? undefined : text(options.why), how: options.how === undefined ? undefined : text(options.how), pin: options.pin === true ? true : undefined, forceNew: options.forceNew === true, allowEmail: options.allowEmail === true, links: options.link === undefined ? [] : (Array.isArray(options.link) ? options.link : [options.link]).map(text) });
    if (command === 'grant') return await grantConsent(text(ctx.args[0]), { ...base, purpose: text(options.purpose), fields: viewFields(text(options.fields).split(',')) });
    if (command === 'withdraw') return await withdrawConsent(text(ctx.args[0]), { ...base, purpose: text(options.purpose) });
    if (command === 'manifest') return await inspectView(text(ctx.args[0]), base);
    if (command === 'view') return await createView(text(ctx.args[0]), { ...base, purpose: text(options.purpose), fields: viewFields(text(options.fields).split(',')), budget: options.budget === undefined ? undefined : Number(options.budget) });
    if (command === 'renew') return await renew(text(ctx.args[0]), { ...base, from: text(options.validFrom), until: text(options.validUntil), evidence: text(options.evidence) });
    if (command === 'recall') return await recall(text(ctx.args[0]), { ...base, validity: guidancePolicy(options.validity), budget: options.budget === undefined ? undefined : Number(options.budget), semantic: semanticMode(options.semantic), kind: options.kind === undefined ? undefined : kind(options.kind) });
    if (command === 'observe') return await observe(text(ctx.args[0]), { ...base, recall: text(options.recall), task: text(options.task), feedback: text(options.feedback) as ObserveOptions['feedback'], outcome: text(options.outcome) as ObserveOptions['outcome'], attribution: text(options.attribution) as ObserveOptions['attribution'], evidence: text(options.evidence) });
    if (command === 'utility') return await utility(text(ctx.args[0]), base);
    if (command === 'get') return await get(text(ctx.args[0]), base);
    if (command === 'index') return await index({ ...base, validity: guidancePolicy(options.validity), budget: options.budget === undefined ? undefined : Number(options.budget) });
    if (command === 'import') return await importDir(text(ctx.args[0]), { ...base, from: harness(options.from), allowEmail: options.allowEmail === true, createMissingOrigins: options.create === true });
    if (command === 'export') return await exportDir(text(ctx.args[0]), { ...base, to: harness(options.to, true) as 'claude-code' | 'agents-md' });
    if (command === 'verify') return await verify({ ...base, root: options.root === undefined ? undefined : (Array.isArray(options.root) ? options.root : [options.root]).map(text), slug: options.slug === undefined ? undefined : text(options.slug), network: options.network === true });
    if (command === 'consolidate') return await consolidate({ ...base, apply: options.apply === true, semantic: semanticMode(options.semantic), minAgeDays: options.minAgeDays === undefined ? undefined : Number(options.minAgeDays) });
    throw new MemoryError('invalid', 'Unknown memory command', 'Run pm memory --help');
  } catch (error) {
    const refusal = error instanceof MemoryError ? error : new MemoryError('sdk', 'Memory operation could not complete', 'Check source permissions, tracker integrity and pm health before retrying');
    throw createPmCliExpectedError(`memory ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: refusal.code === 'privacy' ? 4 : refusal.code === 'duplicate' || refusal.code === 'conflict' ? 3 : 2 });
  }
}
/** Native flag descriptions include concrete examples in every option's help entry. */
const OPTIONS: Record<string, string> = {
  purpose: 'Explicit recall purpose identifier (example: --purpose release-review)',
  fields: 'Comma-separated authorized content fields (example: --fields title,body)',
  recall: 'Link the receipt returned by recall (example: --recall <receipt>)',
  task: 'Link an existing native task outcome (example: --task task-id)',
  feedback: 'Explicit helpfulness: helpful or unhelpful (example: --feedback helpful)',
  outcome: 'Observed improved, unchanged, worsened or unknown performance (example: --outcome improved)',
  attribution: 'Declare isolated, confounded or unknown attribution (example: --attribution confounded)',
  evidence: 'Explain why guidance is valid or the outcome baseline and confounders in 1-1000 characters (example: --evidence "Same gate, fewer failures")',
  'valid-from': 'Inclusive UTC start (example: --valid-from 2026-10-21T00:00:00.000Z)',
  'valid-until': 'Exclusive UTC end (example: --valid-until 2026-11-21T00:00:00.000Z)',
  validity: 'Exclude noncurrent guidance by default or label it for audit (example: --validity label)',
  semantic: 'Use auto, on or off local embeddings; default off (example: --semantic auto)',
  kind: 'Classify as user, feedback, project or reference (example: --kind project)',
  slug: 'Select a stable memory key (example: --slug release-policy)',
  update: 'Revise an existing memory (example: --update release-policy)',
  why: 'Explain the rationale (example: --why "Prevent broken releases")',
  how: 'Describe how to apply it (example: --how "Run both release gates")',
  link: 'Relate an item or memory; repeat to add more (example: --link build-policy)',
  pin: 'Prioritize standing guidance (example: remember "Run gates" --kind project --pin)',
  'force-new': 'Permit a distinct similar memory (example: --force-new --slug release-policy-v2)',
  'allow-email': 'Explicitly permit email addresses, never credentials (example: --allow-email)',
  create: 'Explicitly recreate a missing origin without adopting an unrelated alias (example: --create)',
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
  grant: ['Authorize selected fields of a source for a recall purpose', 'Memory source slug', 'pm memory grant release-policy --purpose release-review --fields title,body'],
  withdraw: ['Withdraw source consent and identify affected output packets', 'Memory source slug', 'pm memory withdraw release-policy --purpose release-review'],
  view: ['Build a minimized purpose-limited recall packet with a text-free manifest', 'Words describing the context needed', 'pm memory view release --purpose release-review --fields title --budget 800'],
  manifest: ['Identify affected sources of a prior packet without recalling source text', 'Packet identifier', 'pm memory manifest <packet>'],
  remember: ['Create or revise durable agent knowledge with privacy and duplicate checks', 'A durable fact or guidance to retain', 'pm memory remember "Run both release gates" --kind project --slug release-policy --pin'],
  renew: ['Renew pinned guidance with explicit validity bounds and evidence', 'Pinned memory slug', 'pm memory renew release-policy --valid-from 2026-10-21T00:00:00.000Z --valid-until 2026-11-21T00:00:00.000Z --evidence "Release checklist reviewed"'],
  recall: ['Rank memories and return compact rows then excerpts within a token budget', 'Words describing the context needed', 'pm memory recall "release workflow" --budget 800'],
  observe: ['Record explicit memory feedback and a later native task outcome idempotently', 'Recalled memory slug', 'pm memory observe build --recall <receipt> --task task-id --feedback helpful --outcome improved --attribution isolated --evidence "Same gate, fewer failures"'],
  utility: ['Report memory outcome evidence with complete source denominators', 'Memory slug, including archived guidance', 'pm memory utility build'],
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
    ['grant', ['purpose', 'fields'], [], 'slug'],
    ['withdraw', ['purpose'], [], 'slug'],
    ['view', ['purpose', 'fields', 'budget'], [], 'query'],
    ['manifest', [], [], 'packet'],
    ['remember', ['kind', 'slug', 'update', 'why', 'how', 'link'], ['pin', 'force-new', 'allow-email'], 'fact'],
    ['renew', ['valid-from', 'valid-until', 'evidence'], [], 'slug'],
    ['recall', ['budget', 'kind', 'semantic', 'validity'], [], 'query'],
    ['observe', ['recall', 'task', 'feedback', 'outcome', 'attribution', 'evidence'], [], 'slug'],
    ['utility', [], [], 'slug'],
    ['get', [], [], 'slug'],
    ['index', ['budget', 'validity'], [], ''],
    ['import', ['from'], ['allow-email', 'create'], 'source'],
    ['export', ['to'], [], 'directory'],
    ['verify', ['slug', 'root'], ['network'], ''],
    ['consolidate', ['min-age-days', 'semantic'], ['apply'], ''],
  ] as const) api.registerCommand(defineCommand({ name: `memory ${name}`, description: HELP[name][0], intent: 'Project management = context management; agents manage their own memory', arguments: argument === '' ? [] : [{ name: argument, required: true, description: HELP[name][1] + ` (example: ${HELP[name][2]})` }], flags: flags([...strings], [...booleans]), examples: [HELP[name][2]], run: ctx => runCommand(name, ctx) }));

}
