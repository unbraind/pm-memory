import { spawnSync } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MemoryError, slug } from './core.ts';
import { active } from './memory.ts';
import { Store } from './store.ts';
import type { Claim, ClaimResult, MemoryOptions, Verdict } from './types.ts';

/** Extract conservatively delimited paths, calls, flags, exact package versions and HTTP URLs. */
export function extractClaims(content: string): Claim[] {
  const claims: Claim[] = [];
  for (const [type, expression] of [
    ['url', /https?:\/\/[^\s<>"'`\])]+/g],
    ['package', /(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?/gi],
    ['symbol', /\b[A-Za-z_$][\w$]*\(\)/g],
    ['flag', /(?<![\w-])--[a-z][a-z0-9-]*/gi],
    ['file', /(?<![\w:/@])(?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[a-z0-9]+\b|(?<=`)[A-Za-z0-9_.-]+\.(?:ts|js|json|md|yml|yaml|toml)(?=`)/gi],
  ] as const) for (const match of content.matchAll(expression)) {
    const value = match[0];
    if (!claims.some(claim => claim.type === type && claim.value === value)) claims.push({ type, value });
  }
  return claims;
}
/** Check file existence without resolving any symlink outside the declared workspace root. */
async function fileClaim(value: string, root: string): Promise<Verdict> {
  if (isAbsolute(value)) return 'stale';
  try {
    const actualRoot = await realpath(root); const path = await realpath(resolve(actualRoot, value));
    const rel = relative(actualRoot, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'stale';
    return (await stat(path)).isFile() ? 'verified' : 'stale';
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) return 'stale';
    throw new MemoryError('verify', 'File evidence could not be read', 'Check workspace permissions before verification');
  }
}
/** Check a single extracted claim with local grep or explicitly enabled network evidence. */
export async function checkClaim(claim: Claim, root: string, network: boolean): Promise<ClaimResult> {
  let verdict: Verdict;
  if (claim.type === 'file') verdict = await fileClaim(claim.value, root);
  else if (claim.type === 'symbol' || claim.type === 'flag') {
    const result = spawnSync('rg', ['--quiet', '--fixed-strings', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!.agents/**', '--', claim.type === 'symbol' ? claim.value.slice(0, -2) : claim.value, '.'], { cwd: root, timeout: 30000 });
    if (result.error !== undefined || result.status === null || result.status > 1) throw new MemoryError('verify', 'Workspace grep could not complete', 'Install ripgrep and check the supplied --root');
    verdict = result.status === 0 ? 'verified' : 'stale';
  } else if (!network) verdict = 'unknown';
  else if (claim.type === 'package') {
    const result = spawnSync('npm', ['view', claim.value, 'version', '--json', '--fetch-retries=0', '--fetch-timeout=5000'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, npm_config_ignore_scripts: 'true' } });
    verdict = result.status === 0 && result.stdout.includes(claim.value.slice(claim.value.lastIndexOf('@') + 1)) ? 'verified' : 'unknown';
    if (result.status !== 0 && /E404|ETARGET/.test(result.stderr)) verdict = 'stale';
  } else {
    try { const response = await fetch(claim.value, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' }); verdict = response.ok ? 'verified' : response.status === 404 || response.status === 410 ? 'stale' : 'unknown'; }
    catch { verdict = 'unknown'; }
  }
  return { ...claim, verdict };
}
/** Persist a conservative verdict and timestamp, with every failing claim in the bounded audit result. */
export async function verify(options: MemoryOptions & { root?: string; slug?: string; network?: boolean }): Promise<{ checked: number; stale: number; results: { slug: string; verdict: Verdict; claims: ClaimResult[] }[] }> {
  if (options.slug !== undefined) slug(options.slug);
  const root = resolve(options.root ?? process.cwd());
  if (!(await stat(root)).isDirectory()) throw new MemoryError('verify', 'Verification root is not a directory', 'Supply an existing source --root');
  const store = new Store(options);
  return store.write(async () => {
    const memories = active(await store.read()).filter(item => options.slug === undefined || item.slug === options.slug);
    if (options.slug !== undefined && memories.length === 0) throw new MemoryError('missing', 'Memory slug does not exist', 'Use memory index to select an active slug');
    const results: { slug: string; verdict: Verdict; claims: ClaimResult[] }[] = [];
    if (memories.length > 0) await store.register();
    const checked = new Map<string, ClaimResult>();
    for (const item of memories) {
      const claims: ClaimResult[] = [];
      for (const claim of extractClaims([item.title, item.body, item.why, item.how].join('\n'))) {
        const key = `${claim.type}:${claim.value}`;
        if (!checked.has(key)) checked.set(key, await checkClaim(claim, root, options.network === true));
        claims.push(checked.get(key)!);
      }
      const verdict = claims.some(claim => claim.verdict === 'stale') ? 'stale' : claims.length > 0 && claims.every(claim => claim.verdict === 'verified') ? 'verified' : 'unknown';
      await store.fields(item.id, { verdict, verified_at: new Date().toISOString() });
      results.push({ slug: item.slug, verdict, claims });
    }
    return { checked: results.length, stale: results.filter(result => result.verdict === 'stale').length, results };
  });
}
