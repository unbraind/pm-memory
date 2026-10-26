import { gitEnvironment, npmEnvironment } from '../scripts/environment.ts';
/** Packed npm/npx and Bun/bunx consumers exercise the real pm host. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/** Run a consumer process with private settings isolated from the current machine. */
function execute(cwd: string, args: string[], executable: string, env: NodeJS.ProcessEnv): string {
  const child = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr + child.stdout);
  return child.stdout;
}
/** Install the actual packed distribution in independent package-manager consumers. */
for (const manager of ['npm', 'bun']) test(`packed ${manager} consumer installs, discovers and executes the memory command`, t => {
  const repository = resolve(import.meta.dirname, '..');
  const scratch = mkdtempSync(join(tmpdir(), 'memory-consumer-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string; devDependencies: Record<string, string> };
  const env = { ...npmEnvironment(gitEnvironment(process.env)), HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: scratch, PM_AUTHOR: 'memory-consumer' };
  const packed = JSON.parse(execute(repository, ['pack', '--json', '--pack-destination', scratch, '--ignore-scripts'], 'npm', env)) as { filename: string; files: { path: string }[] }[];
  const allowed = /^(dist\/|manifest\.json$|package\.json$|README\.md$|ARCHITECTURE\.md$|LICENSE$|CHANGELOG\.md$)/;
  assert.ok(packed[0].files.every(file => allowed.test(file.path)), 'Packed file allowlist');
  assert.ok(packed[0].files.some(file => file.path === 'dist/index.js'));
    const consumer = join(scratch, manager); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'memory-consumer-fixture', private: true, type: 'module', dependencies: { 'pm-memory': `file:${join(scratch, packed[0].filename)}`, '@unbrained/pm-cli': manifest.devDependencies['@unbrained/pm-cli'] } }));
    execute(consumer, manager === 'npm' ? ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts'], manager, env);
    const hostEnv = { ...env, PM_PATH: join(consumer, '.agents', 'pm') };
    const executable = manager === 'npm' ? 'npx' : 'bunx';
    const prefix = manager === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
    execute(consumer, [...prefix, 'init', '--prefix', 'memory-consumer', '--defaults', '--agent-guidance', 'skip'], executable, hostEnv);
    execute(consumer, [...prefix, 'package', 'install', join(scratch, packed[0].filename)], executable, hostEnv);
    const help = execute(consumer, [...prefix, 'memory', '--help'], executable, hostEnv);
    for (const command of ['remember', 'recall', 'get', 'index', 'import', 'export', 'verify', 'consolidate', 'observe', 'utility']) assert.ok(help.includes(command));
    const description = execute(consumer, [...prefix, 'package', 'describe', 'pm-memory', '--json'], executable, hostEnv);
    assert.ok(description.includes('pm-memory'));
    writeFileSync(join(consumer, 'embed.ts'), `import { remember, recall, index, importDir, exportDir, verify, consolidate, observe, utility } from 'pm-memory';
const options = { workspace: process.env.PM_PATH, author: 'memory-consumer' };
await remember('Packed SDK durable guidance', { ...options, kind: 'project', slug: 'embedded' });
const packet = await recall('durable', options);
if (packet.memories[0].slug !== 'embedded') throw Error('Embedded recall failed');
for (const api of [index, importDir, exportDir, verify, consolidate, observe, utility]) if (typeof api !== 'function') throw Error('Missing SDK export');
console.log('embedded accepted');
`);
    assert.match(execute(consumer, ['embed.ts'], manager === 'npm' ? process.execPath : 'bun', hostEnv), /embedded accepted/);
    writeFileSync(join(consumer, 'lossless.ts'), `import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { importDir } from 'pm-memory';
const workspace = process.env.PM_PATH;
const client = new PmClient({ cwd: process.cwd(), pmRoot: workspace, author: 'memory-consumer', noExtensions: true });
if (process.argv[2] === 'setup') {
  await client.init('lossless', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const source = join(process.cwd(), 'lossless-source'); await mkdir(source);
  await writeFile(join(source, 'MEMORY.md'), '- [Alpha](alpha.md)\\n');
  await writeFile(join(source, 'alpha.md'), '# Alpha\\nOriginal guidance\\n');
  await importDir(source, { workspace, author: 'memory-consumer', from: 'claude-code' });
  const item = (await client.listAllComplete()).items.find(row => row.memory_slug === 'alpha');
  await client.run('update', { id: item.id, options: { description: 'Native hook', memoryKind: 'feedback', memoryWhy: 'Native reason', memoryHow: 'Native application', memoryPinned: true, tags: 'native,packed' } });
} else {
  const destination = join(process.cwd(), 'lossless-destination', process.argv[2]);
  const fresh = new PmClient({ cwd: process.cwd(), pmRoot: destination, author: 'memory-consumer', noExtensions: true });
  await fresh.init('fresh', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  await importDir(join(process.cwd(), process.argv[2]), { workspace: destination, author: 'memory-consumer', from: 'claude-code' });
  const item = (await fresh.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === 'alpha');
  assert.equal(item.description, 'Native hook'); assert.equal(item.memory_kind, 'feedback');
  assert.equal(item.memory_why, 'Native reason'); assert.equal(item.memory_how, 'Native application');
  assert.equal(item.memory_pinned, true); assert.deepEqual(item.tags, ['native', 'packed']);
  assert.equal(item.body, '# Alpha\\nOriginal guidance');
}
console.log('lossless accepted');
`);
    const losslessEnv = { ...hostEnv, PM_PATH: join(consumer, 'lossless-tracker') };
    assert.match(execute(consumer, ['lossless.ts', 'setup'], manager === 'npm' ? process.execPath : 'bun', losslessEnv), /lossless accepted/);
    execute(consumer, [...prefix, 'package', 'install', join(scratch, packed[0].filename)], executable, losslessEnv);
    for (const format of ['json', 'toon']) {
      const output = `lossless-${format}`;
      const receipt = execute(consumer, [...prefix, 'memory', 'export', output, '--to', 'claude-code', ...(format === 'json' ? ['--json'] : [])], executable, losslessEnv);
      if (format === 'json') assert.equal(JSON.parse(receipt).byte_preserved, 0);
      else assert.match(receipt, /byte_preserved: 0/);
      assert.match(execute(consumer, ['lossless.ts', output], manager === 'npm' ? process.execPath : 'bun', losslessEnv), /lossless accepted/);
    }
    const remembered = JSON.parse(execute(consumer, [...prefix, 'memory', 'remember', 'Packed host remembers context', '--kind', 'user', '--slug', 'packed', '--pin', '--json'], executable, hostEnv)) as { slug: string; updated: boolean };
    assert.equal(remembered.slug, 'packed'); assert.equal(remembered.updated, false);
    const packet = JSON.parse(execute(consumer, [...prefix, 'memory', 'recall', 'host context', '--budget', '200', '--json'], executable, hostEnv)) as { recall: string; estimated_tokens: number; memories: { slug: string }[] };
    assert.ok(packet.estimated_tokens <= 200); assert.ok(packet.memories.length > 0);
    const task = JSON.parse(execute(consumer, [...prefix, 'create', 'Packed native outcome task', '--json'], executable, hostEnv)) as { id: string };
    const assessed = packet.memories[0].slug;
    const observed = JSON.parse(execute(consumer, [...prefix, 'memory', 'observe', assessed, '--recall', packet.recall, '--task', task.id, '--feedback', 'helpful', '--outcome', 'improved', '--attribution', 'confounded', '--evidence', 'Packed acceptance fixture; native task still open', '--json'], executable, hostEnv)) as { recorded: boolean };
    assert.equal(observed.recorded, true);
    const utility = JSON.parse(execute(consumer, [...prefix, 'memory', 'utility', assessed, '--json'], executable, hostEnv)) as { lifetime: { observations: number; scored: number } };
    assert.equal(utility.lifetime.observations, 1); assert.equal(utility.lifetime.scored, 0);
    const detailedHelp = execute(consumer, [...prefix, 'memory', 'import', '--help'], executable, hostEnv);
    assert.match(detailedHelp, /Read claude-code, agents-md or cursor files/); assert.ok(!detailedHelp.includes('Extension argument'));
    mkdirSync(join(consumer, 'source')); writeFileSync(join(consumer, 'source', 'evidence.ts'), 'export function packedSource() {}');
    execute(consumer, [...prefix, 'memory', 'remember', 'Read `evidence.ts` packedSource()', '--kind', 'project', '--slug', 'source-evidence'], executable, hostEnv);
    const verified = JSON.parse(execute(consumer, [...prefix, 'memory', 'verify', '--root', '.', '--root', 'source', '--slug', 'source-evidence', '--json'], executable, hostEnv)) as { stale: number; results: { verdict: string }[] };
    assert.equal(verified.stale, 0); assert.equal(verified.results[0].verdict, 'verified');
    mkdirSync(join(consumer, 'source/fleet/nested/src'), { recursive: true });
    mkdirSync(join(consumer, 'source/fleet/nested/.agents/pm/runtime'), { recursive: true });
    writeFileSync(join(consumer, 'source/fleet/nested/src/entry.ts'), 'export const entry = true;');
    writeFileSync(join(consumer, 'source/fleet/nested/.agents/pm/runtime/usage.jsonl'), '{}');
    execute(consumer, [...prefix, 'memory', 'remember', 'Use `src/entry.ts`, `runtime/usage.jsonl`, `src/evidence.ts`, `unbraind/fixture`, @scope/pkg/sdk/contracts, `--provider/--model` and `clients.filter/find`.', '--kind', 'project', '--slug', 'typed-evidence'], executable, hostEnv);
    const typed = JSON.parse(execute(consumer, [...prefix, 'memory', 'verify', '--root', '.', '--slug', 'typed-evidence', '--json'], executable, hostEnv)) as { stale: number; results: { claims: { type: string; value: string; verdict: string; reason?: string }[] }[] };
    assert.equal(typed.stale, 0);
    const typedClaims = typed.results[0].claims;
    assert.equal(typedClaims.find(claim => claim.value === 'runtime/usage.jsonl')?.verdict, 'verified');
    assert.equal(typedClaims.find(claim => claim.value === 'src/entry.ts')?.verdict, 'verified');
    assert.match(typedClaims.find(claim => claim.value === 'src/evidence.ts')!.reason!, /^basename found elsewhere: /);
    assert.ok(typedClaims.some(claim => claim.type === 'repo' && claim.verdict === 'unknown'));
    assert.ok(typedClaims.some(claim => claim.type === 'package' && claim.verdict === 'unknown'));
    const full = JSON.parse(execute(consumer, [...prefix, 'memory', 'get', 'source-evidence', '--json'], executable, hostEnv)) as { body: string };
    assert.equal(full.body, 'Read `evidence.ts` packedSource()');
    const indexed = execute(consumer, [...prefix, 'memory', 'index', '--budget', '200'], executable, hostEnv);
    assert.match(indexed, /omitted/);
});
