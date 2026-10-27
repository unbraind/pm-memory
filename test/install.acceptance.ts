import { gitEnvironment, npmEnvironment } from '../scripts/environment.ts';
/** Packed npm/npx and Bun/bunx consumers exercise the real pm host. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/** Run a consumer process with private settings isolated from the current machine. */
function execute(cwd: string, args: string[], executable: string, env: NodeJS.ProcessEnv, expected = 0): string {
  const child = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, expected, child.stderr + child.stdout);
  return expected === 0 ? child.stdout : child.stderr + child.stdout;
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
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PmClient, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import { importDir } from 'pm-memory';
const workspace = process.env.PM_PATH;
const client = new PmClient({ cwd: process.cwd(), pmRoot: workspace, author: 'memory-consumer', noExtensions: true });
if (process.argv[2] === 'setup') {
  await client.init('lossless', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const source = join(process.cwd(), 'lossless-source'); await mkdir(source);
  await writeFile(join(source, 'MEMORY.md'), '- [Alpha](alpha.md)\\n- [Beta](beta.md)\\n');
  await writeFile(join(source, 'beta.md'), '# Beta\\nReference');
  await writeFile(join(source, 'alpha.md'), '# Alpha\\nOriginal guidance [[beta]]\\n');
  await importDir(source, { workspace, author: 'memory-consumer', from: 'claude-code' });
  await writeFile(join(source, 'alpha.md'), '# Alpha\\nOriginal guidance\\n');
  await importDir(source, { workspace, author: 'memory-consumer', from: 'claude-code' });
  const item = (await client.listAllComplete()).items.find(row => row.memory_slug === 'alpha');
  await client.run('update', { id: item.id, options: { memorySlug: 'renamed', description: 'Native hook', memoryKind: 'feedback', memoryWhy: 'Native reason', memoryHow: 'Native application', memoryPinned: true, tags: 'native,packed' } });
} else if (process.argv[2] === 'identity-edit') {
  const item = (await client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === 'renamed');
  await client.run('update', { id: item.id, options: { memorySlug: 'origin-renamed' } });
  await client.run('create', { options: { type: 'Knowledge', title: item.title, description: item.description, body: item.body, tags: item.tags.join(','), memorySlug: 'renamed', memorySource: 'native:item', memoryKind: item.memory_kind, memoryWhy: item.memory_why, memoryHow: item.memory_how, memoryPinned: item.memory_pinned, allowDuplicate: true, ...itemDocumentToMutationOptions(JSON.stringify({ dependencies: item.dependencies }), 'create') } });
  const replacementId = (await client.listAllComplete()).items.find(row => row.memory_slug === 'renamed').id;
  const replacement = (await client.get(replacementId, { full: true })).item;
  await writeFile(process.argv[3] + '.identity.json', JSON.stringify({ item, replacement }));
  const manifest = JSON.parse(await readFile(join(process.argv[3], 'pm-memory-policy.json'), 'utf8'));
  const row = manifest.guidance.find(row => row.slug === 'renamed'); const file = join(process.argv[3], row.path);
  const body = await readFile(file, 'utf8'); await writeFile(file, body.slice(0, body.indexOf('\\n') + 1) + 'Packed harness revision');
} else if (process.argv[2] === 'identity-check') {
  const saved = JSON.parse(await readFile(process.argv[3] + '.identity.json', 'utf8'));
  const item = (await client.get(saved.item.id, { full: true })).item;
  assert.equal(item.memory_slug, 'origin-renamed'); assert.equal(item.body, 'Packed harness revision');
  assert.deepEqual((await client.get(saved.replacement.id, { full: true })).item, saved.replacement);
  await client.run('delete', { id: saved.replacement.id, options: { force: true } });
  await client.run('update', { id: saved.item.id, options: { memorySlug: 'renamed', body: saved.item.body } });
} else if (process.argv[2] === 'origin-delete') {
  const item = (await client.listAllComplete()).items.find(row => row.memory_slug === 'renamed');
  await client.run('delete', { id: item.id, options: { force: true } });
  await client.run('create', { options: { title: 'Same alias replacement', body: 'Retain replacement', type: 'Knowledge', memorySlug: 'renamed', memoryKind: 'reference', memorySource: 'native:item', allowDuplicate: true } });
  await writeFile(process.argv[3] + '.missing.json', JSON.stringify((await client.listAllComplete({ includeBody: true })).items));
} else if (process.argv[2] === 'origin-deleted-check') {
  assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, JSON.parse(await readFile(process.argv[3] + '.missing.json', 'utf8')));
} else if (process.argv[2] === 'origin-alias-clear') {
  const item = (await client.listAllComplete()).items.find(row => row.memory_slug === 'renamed');
  await client.run('delete', { id: item.id, options: { force: true } });
} else if (process.argv[2] === 'origin-created-check') {
  const prior = JSON.parse(await readFile(process.argv[3] + '.identity.json', 'utf8'));
  const items = (await client.listAllComplete({ includeBody: true })).items;
  const item = items.find(row => row.memory_slug === 'renamed');
  const manifest = JSON.parse(await readFile(join(process.argv[3], 'pm-memory-policy.json'), 'utf8'));
  const wire = manifest.guidance.find(row => row.slug === 'renamed');
  assert.notEqual(item.id, prior.item.id); assert.equal(JSON.parse(item.memory_origin).id, prior.item.id);
  assert.equal(item.body, 'Packed harness revision'); assert.equal(item.dependencies[0].id, items.find(row => row.memory_slug === 'beta').id);
  for (const [key, field] of [['title','title'],['description','description'],['kind','memory_kind'],['why','memory_why'],['how','memory_how'],['pinned','memory_pinned'],['tags','tags']]) assert.deepEqual(item[field], wire[key]);
} else {
  const destination = join(process.cwd(), 'lossless-destination', process.argv[2]);
  const fresh = new PmClient({ cwd: process.cwd(), pmRoot: destination, author: 'memory-consumer', noExtensions: true });
  await fresh.init('fresh', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  await importDir(join(process.cwd(), process.argv[2]), { workspace: destination, author: 'memory-consumer', from: 'claude-code' });
  const item = (await fresh.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === 'renamed');
  const beta = (await fresh.listAllComplete()).items.find(row => row.memory_slug === 'beta');
  assert.equal(item.dependencies[0].id, beta.id);
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
      const runtime = manager === 'npm' ? process.execPath : 'bun';
      assert.match(execute(consumer, ['lossless.ts', 'identity-edit', output], runtime, losslessEnv), /lossless accepted/);
      const imported = execute(consumer, [...prefix, 'memory', 'import', output, '--from', 'claude-code', ...(format === 'json' ? ['--json'] : [])], executable, losslessEnv);
      if (format === 'json') assert.equal(JSON.parse(imported).updated, 1); else assert.match(imported, /updated: 1/);
      assert.match(execute(consumer, ['lossless.ts', 'identity-check', output], runtime, losslessEnv), /lossless accepted/);
    }
    const losslessRuntime = manager === 'npm' ? process.execPath : 'bun';
    assert.match(execute(consumer, ['lossless.ts', 'origin-delete', 'lossless-toon'], losslessRuntime, losslessEnv), /lossless accepted/);
    for (const format of ['json', 'toon']) {
      const refusal = execute(consumer, [...prefix, 'memory', 'import', 'lossless-toon', '--from', 'claude-code', ...(format === 'json' ? ['--json'] : [])], executable, losslessEnv, 2);
      if (format === 'json') { const value = JSON.parse(refusal); assert.equal(value.code, 'origin_missing'); assert.match(value.required, /--create/); }
      else { assert.match(refusal, /origin_missing/); assert.match(refusal, /--create/); }
    }
    assert.match(execute(consumer, ['lossless.ts', 'origin-deleted-check', 'lossless-toon'], losslessRuntime, losslessEnv), /lossless accepted/);
    assert.match(execute(consumer, ['lossless.ts', 'origin-alias-clear'], losslessRuntime, losslessEnv), /lossless accepted/);
    assert.equal(JSON.parse(execute(consumer, [...prefix, 'memory', 'import', 'lossless-toon', '--from', 'claude-code', '--create', '--json'], executable, losslessEnv)).imported, 1);
    assert.match(execute(consumer, ['lossless.ts', 'origin-created-check', 'lossless-toon'], losslessRuntime, losslessEnv), /lossless accepted/);
    assert.equal(JSON.parse(execute(consumer, [...prefix, 'memory', 'import', 'lossless-toon', '--from', 'claude-code', '--json'], executable, losslessEnv)).unchanged, 2);
    writeFileSync(join(consumer, 'ownership.ts'), `import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { importDir } from 'pm-memory';
for (const from of ['agents-md', 'claude-code']) {
  const root = join(process.cwd(), 'ownership-' + from); await mkdir(root);
  const workspace = join(root, 'tracker'); const options = { workspace, author: 'memory-consumer', from };
  const client = new PmClient({ pmRoot: workspace, author: options.author, noExtensions: true });
  await client.init('ownership', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const input = join(root, 'alpha.md'); await writeFile(input, 'Alpha A'); await importDir(input, options);
  await rm(join(workspace, 'memory-origin.json')); await writeFile(input, 'Alpha B');
  assert.equal((await importDir(input, options)).updated, 1);
  assert.equal((await client.listAllComplete({ includeBody: true })).items[0].body, 'Alpha B');
  assert.equal((await importDir(input, options)).unchanged, 1);
  for (const shape of ['priority', 'custom', 'dependencies']) {
    const destination = join(root, shape); const native = new PmClient({ pmRoot: destination, author: options.author, noExtensions: true });
    await native.init('foreign', { defaults: true, agentGuidance: 'skip', mergeFence: false });
    if (shape === 'custom') await native.schemaAddField('foreign_note', { type: 'string', required: false, requiredOnCreate: false, allowUnset: true, commands: ['create', 'update'], cliFlag: 'foreign-note', description: 'Foreign creation evidence' });
    const task = shape === 'dependencies' ? (await native.create({ title: 'Peer task' })).item.id : undefined;
    let before;
    const result = await importDir(input, { ...options, workspace: destination, onStep: async step => {
      if (step !== 'intent') return;
      const record = JSON.parse(await readFile(join(destination, 'runtime', 'memory-policy-import.json'), 'utf8'));
      const node = JSON.parse(record.payload).nodes[0];
      const extra = shape === 'priority' ? { priority: 1 } : shape === 'custom' ? { foreignNote: 'Peer value' } : { dep: ['id=' + task + ',kind=related'] };
      await native.create({ ...node.options, id: node.id, ...extra });
      before = (await native.listAllComplete({ includeBody: true })).items;
    } });
    assert.match(result.skipped[0].reason, /Foreign/);
    assert.deepEqual((await native.listAllComplete({ includeBody: true })).items, before);
    await importDir(input, { ...options, workspace: destination });
    assert.deepEqual((await native.listAllComplete({ includeBody: true })).items, before);
    await writeFile(input, 'Later harness revision ' + shape);
    const edited = await importDir(input, { ...options, workspace: destination });
    assert.match(edited.skipped[0].reason, /Foreign/);
    assert.deepEqual((await native.listAllComplete({ includeBody: true })).items, before);
  }
}
console.log('birth and namespace ownership accepted');
`);
    assert.match(execute(consumer, ['ownership.ts'], losslessRuntime, hostEnv), /birth and namespace ownership accepted/);
    writeFileSync(join(consumer, 'documents.ts'), String.raw`import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { importDir } from 'pm-memory';
const from = process.argv[2]; const mode = process.argv[3]; const location = process.argv[4]; const value = process.argv[5];
const client = new PmClient({ pmRoot: process.env.PM_PATH, author: 'memory-consumer', noExtensions: true });
const name = from === 'agents-md' ? 'AGENTS.md' : 'alpha.md'; const input = 'documents-source-' + from;
const bytes = text => '---\r\nname: alpha\r\ncustom: ' + text + '\r\nnested: {keep: [null, false, 3]}\r\n---\r\n\r\n# Body\r\n\r\n## Unknown section\r\nKeep whitespace.  \r\n';
if (mode === 'setup') {
  await client.init('documents', { defaults: true, agentGuidance: 'skip', mergeFence: false }); await mkdir(input);
  await writeFile(join(input, name), bytes('old-value'));
  if (from === 'claude-code') await writeFile(join(input, 'MEMORY.md'), '- [Alpha](alpha.md)\n');
  await importDir(input, { workspace: process.env.PM_PATH, author: 'memory-consumer', from });
  const id = (await client.listAllComplete()).items.find(item => item.memory_slug === 'alpha').id;
  await writeFile(input + '.native.json', JSON.stringify((await client.get(id, { full: true })).item));
} else if (mode === 'edit') await writeFile(join(location, name), bytes(value));
else {
  const before = JSON.parse(await readFile(input + '.native.json', 'utf8'));
  const actual = (await client.get(before.id, { full: true })).item;
  assert.deepEqual(actual, { ...before, memory_document: actual.memory_document, updated_at: actual.updated_at });
  assert.equal(JSON.parse(actual.memory_document).original, Buffer.from(bytes(value)).toString('base64'));
  assert.equal(await readFile(join(location, name), 'utf8'), bytes(value));
  assert.equal((await importDir(location, { workspace: process.env.PM_PATH, author: 'memory-consumer', from })).updated, 0);
}
console.log('complete document accepted');
`);
    for (const from of ['agents-md', 'claude-code']) {
      const documentsEnv = { ...hostEnv, PM_PATH: join(consumer, 'documents-tracker-' + from) };
      assert.match(execute(consumer, ['documents.ts', from, 'setup'], losslessRuntime, documentsEnv), /complete document accepted/);
      execute(consumer, [...prefix, 'package', 'install', join(scratch, packed[0].filename)], executable, documentsEnv);
      for (const format of ['json', 'toon']) {
        const flags = format === 'json' ? ['--json'] : []; const input = 'documents-source-' + from;
        const output = 'documents-' + from + '-' + format;
        assert.match(execute(consumer, ['documents.ts', from, 'edit', input, format + '-raw'], losslessRuntime, documentsEnv), /complete document accepted/);
        const raw = execute(consumer, [...prefix, 'memory', 'import', input, '--from', from, ...flags], executable, documentsEnv);
        if (format === 'json') assert.equal(JSON.parse(raw).updated, 1); else assert.match(raw, /updated: 1/);
        execute(consumer, [...prefix, 'memory', 'export', output, '--to', from, ...flags], executable, documentsEnv);
        assert.match(execute(consumer, ['documents.ts', from, 'edit', output, format + '-companion'], losslessRuntime, documentsEnv), /complete document accepted/);
        const companion = execute(consumer, [...prefix, 'memory', 'import', output, '--from', from, ...flags], executable, documentsEnv);
        if (format === 'json') assert.equal(JSON.parse(companion).updated, 1); else assert.match(companion, /updated: 1/);
        execute(consumer, [...prefix, 'memory', 'export', output + '-final', '--to', from, ...flags], executable, documentsEnv);
        assert.match(execute(consumer, ['documents.ts', from, 'check', output + '-final', format + '-companion'], losslessRuntime, documentsEnv), /complete document accepted/);
      }
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
