import { spawnSync } from 'node:child_process';
import { realpath, stat, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, join, basename, extname, posix } from 'node:path';
import { homedir } from 'node:os';
import { GLOBAL_FLAG_CONTRACTS, PM_CORE_COMMAND_NAMES, resolveSubcommandFlagContractsForCommand } from '@unbrained/pm-cli/sdk';
import { MemoryError, slug } from './core.ts';
import { active } from './memory.ts';
import { Store } from './store.ts';
import type { Claim, ClaimResult, MemoryOptions, Verdict } from './types.ts';

/** Dependency and generated trees never contribute evidence. */
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'coverage']);
/** Directory vocabulary separates source references from arbitrary slash notation. */
const SOURCE_DIRS = new Set('src scripts test tests docs .github .agents lib bin config fixtures runtime packages apps website site compat'.split(' '));
/** Recognizable extensions avoid mistaking member access for filenames. */
const EXTENSION = /\.(?:[cm]?[jt]sx?|jsonl?|mdx?|ya?ml|toml|sh|bash|py|css|scss|html|txt|xml|sql|csv|lock|toon|vue|svelte|go|rs|c|h|cpp|rb|php|wasm|svg|png|jpe?g|webp|zip|gz|tgz|log|env)$/i;
/** Standard runtime calls provide no project-staleness evidence. */
const GLOBALS = new Set('randomUUID parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval queueMicrotask fetch require encodeURI decodeURI encodeURIComponent decodeURIComponent eval atob btoa structuredClone BigInt Boolean Number String Object Array Date Error Map Set Promise Symbol RegExp'.split(' '));
/** Convert home paths to portable names before returning or persisting evidence. */
function portablePath(value: string): string {
  return (value === homedir() || value.startsWith(homedir() + '/')) ? relative(homedir(), value) : value.replace(/^~\//, '');
}
/** Identify temporary names even when their spelling otherwise resembles source evidence. */
function temporary(value: string): boolean {
  return /^(?:\/tmp|\/var\/tmp)(?:\/|$)|(?:^|\/)(?:mktemp[^/]*|scratch[^/]*|copy[A-Z0-9][^/]*|(?:foo|bar|baz|dummy|fake)(?:\.[^/]+)?|[a-z]\.[a-z]+|pm-[xyz]|tmp|temp|\.cache)(?:\/|$)/.test(value);
}
/** Context that explicitly describes absence, examples or planned work cannot establish current use. */
function uncertainSentence(content: string, index: number): boolean {
  if ((content.slice(0, index).match(/^(?:```|~~~)/gm)?.length ?? 0) % 2 === 1) return true;
  if (/^\s*(?:```|~~~)/.test(content.slice(content.indexOf('\n', index) + 1))) return true;
  const line = content.slice(content.lastIndexOf('\n', index) + 1, content.indexOf('\n', index) < 0 ? content.length : content.indexOf('\n', index));
  if (line.includes('node_modules/') || /gitignore.*(?:block|pattern)|(?:block|pattern).*gitignore/i.test(line)) return true;
  return /(?<![\w/.-])(?:deleted|removed|gone|missing|absent|nonexistent|obsolete|historical|hypothetical|example|e\.g\.|fixture|temporary|scratch(?:pad)?|retired|rename|renamed|propos(?:e|ed|al)|planned|would|could|does not exist|no longer|do not use|never use|don't use|not in|tmp)(?![\w/-]|\.\w)/i.test(line.replace(/`[^`]*`|[\w$]+\(\)/g, ''));
}
/** Classify a complete path-like token before considering any of its substrings. */
function pathType(value: string, prefix: string): Claim['type'] | undefined {
  if (/^@[^/]+\/[^/]+|^[\w.-]+@\d/.test(value) || /(?:package|npm|subpath|@[\w-]+\/[\w.-]+\/?)\s*[:=]?\s*`?$/i.test(prefix)) return 'package';
  const parts = value.replace(/\/$/, '').split('/');
  const explicit = /^(?:\/|~\/|\.\.?\/)/.test(value);
  if (/^(?:process|console|JSON|Math|Object|Array|Date|Promise|crypto|Buffer)\./.test(value)) return undefined;
  if (!explicit && parts.some(part => part.includes('.') && !EXTENSION.test(part) && !part.startsWith('.'))) return undefined;
  if (explicit || EXTENSION.test(value) || parts.length >= 2 && parts.some(part => SOURCE_DIRS.has(part))) return 'file';
  if (parts.length === 2 && parts.every(part => /^[\w.-]+$/.test(part))) return 'repo';
  return undefined;
}
/** Extract nonoverlapping typed claims; uncertain file mentions never establish confident absence. */
export function extractClaims(content: string): Claim[] {
  const claims: Claim[] = [];
  const expression = /https?:\/\/[^\s<>"'`\])]+|(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?|@[\w-]+\/[\w.-]+(?:\/[\w.*{},<>?-]+)*\/?|[\w.-]+(?:\/[\w.*{},<>?-]+)+\/?|(?:~?\/|\.\.?\/)[\w.*{},<>?-]+(?:\/[\w.*{},<>?-]+)*\/?|--[a-z][a-z0-9-]*(?:\/--[a-z][a-z0-9-]*)*|[A-Za-z_$][\w$]*\(\)|[\w.*?{}<>-]+\.[a-z][a-z0-9]*/gi;
  for (const match of content.matchAll(expression)) {
    const value = match[0].replace(/(?<!\/)\.$/, '');
    if (value === 'Node.js') continue;
    const prefix = content.slice(Math.max(0, match.index - 100), match.index);
    let type: Claim['type'] | undefined;
    if (/^https?:/.test(value)) type = 'url';
    else if (/^[\w$]+\(\)$/.test(value)) {
      if (GLOBALS.has(value.slice(0, -2)) || /[\w$]\.$/.test(prefix)) continue;
      type = 'symbol';
    } else if (/^--/.test(value)) { if (!value.includes('/')) type = 'flag'; }
    else type = pathType(value, prefix);
    if (type === undefined) continue;
    const claim: Claim = { type, value: type === 'file' ? portablePath(value) : value };
    if (type === 'file' && (value.startsWith(homedir() + '/') || value.startsWith('~/'))) claim.home = true;
    const ambiguousPath = /[*{}<>?]|\.\.\./.test(value) || /(?:^|\/)\.(?:[cm]?[jt]sx?|jsonl?|md|ya?ml)$/.test(value) || /\bfiles\s*\(\s*$/i.test(prefix) || /\b(?:pgrep|pkill)\b[^`\n]*-[a-z]*f[a-z]*\s+["']?$/i.test(prefix) || /^[{<]/.test(content.slice(match.index + match[0].length)) || value.split('/').slice(0, -1).some(part => EXTENSION.test(part));
    const undelimited = !/[`"']$/.test(prefix) && (!value.includes('/') || !EXTENSION.test(value.replace(/\/$/, '')) && !/^(?:\/|~\/|\.\.?\/)/.test(value));
    if (type === 'file' && (temporary(value) || ambiguousPath || undelimited || /\$$/.test(prefix) || uncertainSentence(content, match.index))) claim.uncertainty = 'Temporary, historical or hypothetical path mention';
    if (!claims.some(previous => previous.type === type && previous.value === claim.value && previous.uncertainty === claim.uncertainty)) claims.push(claim);
  }
  for (const claim of claims.filter(claim => claim.type === 'symbol')) {
    const line = content.split(/\r?\n/).find(line => line.includes(claim.value))!;
    claim.context = claims.find(candidate => candidate.type === 'file' && EXTENSION.test(candidate.value) && candidate.uncertainty === undefined && line.includes(candidate.value))?.value;
  }
  return claims;
}
/** A bounded source inventory, reusable across all claims in one verification run. */
interface Evidence {
  /** Normalized roots, including explicitly supplied nested repositories. */
  roots: string[];
  /** Every indexed suffix maps to a portable root-relative match. */
  suffixes: Map<string, string>;
  /** Root-relative source names, with ignored trees pruned at every depth. */
  files: string[][];
  /** Directory and symlink names include entries omitted by ripgrep file enumeration. */
  directories: string[][];
  /** Batched textual presence; undefined means a bounded search could not finish. */
  matches?: Map<string, boolean | undefined>;
}
/** Enumerate directories and symlink names with a hard limit and no symlink traversal. */
export async function directoryEvidence(root: string, limit = 100000): Promise<string[]> {
  const pending = ['']; const result: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) if ((entry.isDirectory() || entry.isSymbolicLink()) && !EXCLUDED.has(entry.name)) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      result.push(path); if (entry.isDirectory()) pending.push(path);
      if (result.length > limit) throw new MemoryError('verify', 'Directory evidence exceeds the bounded search limit', 'Supply narrower --root trees');
    }
  }
  return result;
}
/** Build a bounded suffix index once, including root prefixes for truncated home paths. */
export function suffixIndex(roots: string[], inventories: string[][], limit = 1000000): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < roots.length; index++) for (const path of ['', ...inventories[index]]) {
    const full = `${portablePath(roots[index])}/${path}`;
    const parts = full.split('/').filter(Boolean);
    for (let start = 0; start < parts.length; start++) {
      const suffix = parts.slice(start).join('/');
      if (!result.has(suffix)) result.set(suffix, path || '.');
      if (result.size > limit) throw new MemoryError('verify', 'Path evidence exceeds the bounded search limit', 'Supply narrower --root trees');
    }
  }
  return result;
}
/** Enumerate hidden and nested repositories without consulting gitignore or following symlinks. */
async function evidence(input: string | readonly string[]): Promise<Evidence> {
  const requested = [...new Set((typeof input === 'string' ? [input] : input).map(root => resolve(root)))];
  const roots = requested.filter(root => !requested.some(parent => parent !== root && root.startsWith(parent + sep)));
  if (roots.length === 0) throw new MemoryError('verify', 'No verification roots supplied', 'Supply at least one --root');
  const files: string[][] = []; const directories: string[][] = [];
  for (const root of roots) {
    if (!(await stat(root)).isDirectory()) throw new MemoryError('verify', 'Verification root is not a directory', 'Supply an existing source --root');
    const listed = spawnSync('rg', ['--files', '--hidden', '--no-ignore', ...[...EXCLUDED].flatMap(name => ['--glob', `!**/${name}/**`]), '.'], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (listed.error !== undefined || listed.status === null || listed.status > 1) throw new MemoryError('verify', 'Workspace grep could not complete', 'Install ripgrep and check the supplied --root');
    files.push(listed.stdout.split('\n').filter(Boolean).map(path => path.replace(/^\.\//, '')));
    directories.push(await directoryEvidence(root));
  }
  const suffixes = suffixIndex(roots, files.map((paths, index) => [...paths, ...directories[index]]));
  return { roots, files: files.map(paths => paths.filter(path => !path.split('/').includes('.agents'))), directories, suffixes };
}
/** Resolve portable paths by full suffix, retaining basename-only matches as ambiguity. */
async function fileClaim(input: Claim, source: Evidence): Promise<ClaimResult> {
  const value = portablePath(input.value);
  const claim: Claim = { ...input, value };
  if (input.uncertainty !== undefined || temporary(input.value)) return { ...claim, verdict: 'unknown', reason: 'Temporary, historical or hypothetical path mention' };
  if (isAbsolute(value) || value.split('/').some(part => part === '..' || EXCLUDED.has(part))) return { ...claim, verdict: 'unknown', reason: 'Absolute, excluded or escaping path lacks portable context' };
  const portable = posix.normalize(value).replace(/^\.\//, '').replace(/\/$/, '');
  const indexed = source.suffixes.get(portable);
  for (const root of source.roots) {
    try {
      const actualRoot = await realpath(root); const path = await realpath(resolve(actualRoot, indexed ?? value));
      const rel = relative(actualRoot, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { ...claim, verdict: 'unknown', reason: 'Symlink escapes the declared root' };
      await stat(path); return { ...claim, verdict: 'verified' };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw new MemoryError('verify', 'File evidence could not be read', 'Check workspace permissions before verification');
    }
  }
  if (indexed !== undefined) return { ...claim, verdict: 'unknown', reason: 'Indexed path changed during verification' };
  const name = basename(portable);
  if (extname(name) !== '' && source.suffixes.has(name)) return { ...claim, verdict: 'unknown', reason: `basename found elsewhere: ${source.suffixes.get(name)!}` };
  const home = input.home === true || input.value.startsWith(homedir() + '/') || input.value.startsWith('~/');
  if (home && !source.roots.some(root => { const anchor = portablePath(root); return anchor === '' || portable === anchor || portable.startsWith(anchor + '/'); })) return { ...claim, verdict: 'unknown', reason: 'Home path is outside the declared roots' };
  return { ...claim, verdict: 'stale', reason: `missing path ${value} under roots` };
}
/** Search all lexical claims together, bounding output and avoiding a source-tree scan per claim. */
function searchClaims(claims: Claim[], source: Evidence): void {
  const needles = [...new Set(claims.filter(claim => claim.type === 'symbol' || claim.type === 'flag').map(claim => claim.type === 'symbol' ? claim.value.slice(0, -2) : claim.value))].sort((a, b) => b.length - a.length);
  source.matches = new Map(needles.map(needle => [needle, false]));
  if (needles.length === 0) return;
  for (let index = 0; index < source.roots.length; index++) for (let start = 0; start < source.files[index].length; start += 1000) {
    const result = spawnSync('rg', ['--only-matching', '--no-line-number', '--no-heading', '--no-filename', '--fixed-strings', ...needles.flatMap(needle => ['--regexp', needle]), '--', ...source.files[index].slice(start, start + 1000)], { cwd: source.roots[index], encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error !== undefined || result.status === null || result.status > 1) {
      for (const needle of needles) if (source.matches.get(needle) !== true) source.matches.set(needle, undefined);
      return;
    }
    const matched = new Set(result.stdout.split('\n'));
    for (const needle of needles) if ([...matched].some(value => value.includes(needle))) source.matches.set(needle, true);
  }
}
/** Check source text against bounded enumerated files; unknown-context flags never imply staleness. */
function grepClaim(claim: Claim, source: Evidence): ClaimResult {
  const needle = claim.type === 'symbol' ? claim.value.slice(0, -2) : claim.value;
  if (claim.type === 'flag') {
    const contracts = [...GLOBAL_FLAG_CONTRACTS, ...PM_CORE_COMMAND_NAMES.flatMap(command => resolveSubcommandFlagContractsForCommand(command))];
    if (contracts.some(contract => contract.flag === needle || contract.aliases?.includes(needle))) return { ...claim, verdict: 'verified' };
  }
  if (source.matches?.get(needle) === true) return { ...claim, verdict: 'verified' };
  const count = source.files.reduce((sum, files) => sum + files.length, 0);
  if (source.matches === undefined) for (let index = 0; index < source.roots.length; index++) {
    const files = source.files[index];
    for (let start = 0; start < files.length; start += 1000) {
      const result = spawnSync('rg', ['--quiet', '--fixed-strings', '--', needle, ...files.slice(start, start + 1000)], { cwd: source.roots[index], timeout: 30000 });
      if (result.error !== undefined || result.status === null || result.status > 1) return { ...claim, verdict: 'unknown', reason: 'Source search did not complete' };
      if (result.status === 0) return { ...claim, verdict: 'verified' };
    }
  }
  return claim.type === 'symbol' && claim.context !== undefined && (source.matches === undefined || source.matches.get(needle) === false) ? { ...claim, verdict: 'stale', reason: `symbol absent in ${count} files searched` } : { ...claim, verdict: 'unknown', reason: 'No command or source context establishes absence' };
}
/** Check one claim with optional shared local evidence and explicitly enabled network evidence. */
export async function checkClaim(claim: Claim, root: string | readonly string[], network: boolean, source?: Evidence): Promise<ClaimResult> {
  if (claim.type === 'file') return fileClaim(claim, source ?? await evidence(root));
  if (claim.type === 'symbol' || claim.type === 'flag') {
    const local = source ?? await evidence(root);
    const contextual = claim.context === undefined || (await fileClaim({ type: 'file', value: claim.context }, local)).verdict === 'verified';
    return grepClaim(contextual ? claim : { ...claim, context: undefined }, local);
  }
  let verdict: Verdict = 'unknown';
  if (network && claim.type === 'repo') {
    const result = spawnSync('gh', ['repo', 'view', claim.value, '--json', 'nameWithOwner'], { encoding: 'utf8', timeout: 10000 });
    if (result.status === 0) verdict = 'verified';
  } else if (network && claim.type === 'package' && /@\d+\.\d+\.\d+/.test(claim.value)) {
    const result = spawnSync('npm', ['view', claim.value, 'version', '--json', '--fetch-retries=0', '--fetch-timeout=5000'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, npm_config_ignore_scripts: 'true' } });
    if (result.status === 0 && result.stdout.includes(claim.value.slice(claim.value.lastIndexOf('@') + 1))) verdict = 'verified';
    if (result.status !== 0 && /E404|ETARGET/.test(result.stderr)) verdict = 'stale';
  } else if (network && claim.type === 'url') {
    try { const response = await fetch(claim.value, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' }); verdict = response.ok ? 'verified' : response.status === 404 || response.status === 410 ? 'stale' : 'unknown'; }
    catch { verdict = 'unknown'; }
  }
  return { ...claim, verdict, ...(verdict === 'stale' ? { reason: claim.type === 'package' ? 'Exact package version absent in registry' : 'HTTP endpoint returned 404 or 410' } : {}) };
}
/** Persist conservative verdicts and confident reasons, caching repeated claims for this run only. */
export async function verify(options: MemoryOptions & { root?: string | readonly string[]; slug?: string; network?: boolean }): Promise<{ checked: number; stale: number; results: { slug: string; verdict: Verdict; claims: ClaimResult[] }[] }> {
  if (options.slug !== undefined) slug(options.slug);
  const roots = options.root ?? process.cwd(); const source = await evidence(roots);
  const store = new Store(options);
  return store.write(async () => {
    const memories = active(await store.read()).filter(item => options.slug === undefined || item.slug === options.slug);
    if (options.slug !== undefined && memories.length === 0) throw new MemoryError('missing', 'Memory slug does not exist', 'Use memory index to select an active slug');
    searchClaims(memories.flatMap(item => extractClaims([item.title, item.body, item.why, item.how].join('\n'))), source);
    const results: { slug: string; verdict: Verdict; claims: ClaimResult[] }[] = [];
    if (memories.length > 0) await store.register();
    const checked = new Map<string, ClaimResult>();
    for (const item of memories) {
      const claims: ClaimResult[] = [];
      for (const claim of extractClaims([item.title, item.body, item.why, item.how].join('\n'))) {
        const key = JSON.stringify(claim);
        if (!checked.has(key)) checked.set(key, await checkClaim(claim, roots, options.network === true, source));
        claims.push(checked.get(key)!);
      }
      const verdict = claims.some(claim => claim.verdict === 'stale') ? 'stale' : claims.length > 0 && claims.every(claim => claim.verdict === 'verified') ? 'verified' : 'unknown';
      await store.fields(item.id, { verdict, reason: claims.filter(claim => claim.verdict === 'stale').map(claim => claim.reason!).join('; '), verified_at: new Date().toISOString() });
      results.push({ slug: item.slug, verdict, claims });
    }
    return { checked: results.length, stale: results.filter(result => result.verdict === 'stale').length, results };
  });
}
