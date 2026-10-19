import { spawnSync } from 'node:child_process';
import { realpath, stat, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { GLOBAL_FLAG_CONTRACTS, PM_CORE_COMMAND_NAMES, resolveSubcommandFlagContractsForCommand } from '@unbrained/pm-cli/sdk';
import { MemoryError, slug } from './core.ts';
import { active } from './memory.ts';
import { Store } from './store.ts';
import type { Claim, ClaimResult, MemoryOptions, Verdict } from './types.ts';

/** Trees excluded consistently from source and directory evidence. */
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'coverage', '.agents']);
/** Standard runtime calls provide no project-staleness evidence. */
const GLOBALS = new Set('randomUUID parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval queueMicrotask fetch require encodeURI decodeURI encodeURIComponent decodeURIComponent eval atob btoa structuredClone BigInt Boolean Number String Object Array Date Error Map Set Promise Symbol RegExp'.split(' '));
/** Extract delimited claims while retaining whole absolute paths and ignoring URL/package substrings. */
export function extractClaims(content: string): Claim[] {
  const claims: Claim[] = [];
  for (const [type, expression] of [
    ['url', /https?:\/\/[^\s<>"'`\])]+/g],
    ['package', /(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?/gi],
    ['symbol', /\b[A-Za-z_$][\w$]*\(\)/g],
    ['flag', /(?<![\w-])--[a-z][a-z0-9-]*/gi],
    ['file', /(?<=`)[A-Za-z0-9_.-]+\/(?=`)|(?<=`)(?:~?\/|\.\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?(?=`)|(?<![\w:/@.-])(?:~?\/|\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|sh|py)\b|(?<=`)[A-Za-z0-9_.-]+\.(?:ts|js|json|md|yml|yaml|toml)(?=`)/gi],
  ] as const) for (const match of content.matchAll(expression)) {
    const value = match[0];
    if (type === 'symbol' && (GLOBALS.has(value.slice(0, -2)) || /\b(?:JSON|Math|Object|Array|Date|Promise|console|process|crypto|Buffer|Reflect|Number|String|Symbol|Atomics|Intl)\.$/.test(content.slice(0, match.index)))) continue;
    if (!claims.some(claim => claim.type === type && claim.value === value)) claims.push({ type, value });
  }
  // Calls need a source context to justify a confident absence claim.
  for (const claim of claims.filter(claim => claim.type === 'symbol')) {
    const line = content.split(/\r?\n/).find(line => line.includes(claim.value))!;
    claim.context = claims.find(candidate => candidate.type === 'file' && line.includes(candidate.value))?.value;
  }
  return claims;
}
/** A bounded source inventory, reusable across all claims in one verification run. */
interface Evidence {
  /** Normalized roots, including explicitly supplied nested repositories. */
  roots: string[];
  /** Root-relative source names, with ignored trees pruned at every depth. */
  files: string[][];
  /** Directory names include empty directories omitted by ripgrep file enumeration. */
  directories: string[][];
  /** Batched textual presence; undefined means a bounded search could not finish. */
  matches?: Map<string, boolean | undefined>;
}
/** Enumerate real directories with a hard count limit and no dependency or symlink traversal. */
export async function directoryEvidence(root: string, limit = 100000): Promise<string[]> {
  const pending = ['']; const result: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) if (entry.isDirectory() && !EXCLUDED.has(entry.name)) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      result.push(path); pending.push(path);
      if (result.length > limit) throw new MemoryError('verify', 'Directory evidence exceeds the bounded search limit', 'Supply narrower --root trees');
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
  return { roots, files, directories };
}
/** Resolve path evidence without escaping a root; basenames also search bounded nested repositories. */
async function fileClaim(value: string, source: Evidence): Promise<ClaimResult> {
  const claim: Claim = { type: 'file', value };
  if (isAbsolute(value) || value.startsWith('~') || value.split('/').some(part => part === '..' || EXCLUDED.has(part))) return { ...claim, verdict: 'unknown', reason: 'Absolute, home, excluded or escaping path lacks portable context' };
  for (let index = 0; index < source.roots.length; index++) {
    const root = source.roots[index];
    try {
      const actualRoot = await realpath(root); const path = await realpath(resolve(actualRoot, value));
      const rel = relative(actualRoot, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { ...claim, verdict: 'unknown', reason: 'Symlink escapes the declared root' };
      await stat(path); return { ...claim, verdict: 'verified' };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw new MemoryError('verify', 'File evidence could not be read', 'Check workspace permissions before verification');
    }
    const portable = value.replace(/^\.\//, '');
    if ([...source.files[index], ...source.directories[index]].some(path => path === portable.replace(/\/$/, '') || path.endsWith(`/${portable.replace(/\/$/, '')}`))) return { ...claim, verdict: 'verified' };
  }
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
  if (claim.type === 'file') return fileClaim(claim.value, source ?? await evidence(root));
  if (claim.type === 'symbol' || claim.type === 'flag') {
    const local = source ?? await evidence(root);
    const contextual = claim.context === undefined || (await fileClaim(claim.context, local)).verdict === 'verified';
    return grepClaim(contextual ? claim : { ...claim, context: undefined }, local);
  }
  let verdict: Verdict = 'unknown';
  if (network && claim.type === 'package') {
    const result = spawnSync('npm', ['view', claim.value, 'version', '--json', '--fetch-retries=0', '--fetch-timeout=5000'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, npm_config_ignore_scripts: 'true' } });
    if (result.status === 0 && result.stdout.includes(claim.value.slice(claim.value.lastIndexOf('@') + 1))) verdict = 'verified';
    if (result.status !== 0 && /E404|ETARGET/.test(result.stderr)) verdict = 'stale';
  } else if (network) {
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
