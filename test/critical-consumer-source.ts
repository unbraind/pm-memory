/** Exercise the installed SDK and a second native runtime process, without repository source imports. */
export function criticalConsumerSource(): string {
  return String.raw`import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { importDir, exportDir, POLICY_MANIFEST, MemoryError } from 'pm-memory';
const label = process.argv[2] ?? 'host'; const phase = process.argv[3];
const root = join(process.cwd(), 'critical-' + label); const invalidWorkspace = join(root, 'invalid-tracker');
/** Snapshot only durable state in this independently initialized non-git tracker. */
async function snapshot(directory) {
  const result = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['runtime', 'locks', 'search', 'transactions', 'checkpoints'].includes(entry.name)) continue;
      const file = join(path, entry.name); if (entry.isDirectory()) await visit(file); else result[relative(directory, file)] = entry.isSymbolicLink() ? 'link:' + await readlink(file) : (await readFile(file)).toString('base64');
    }
  }
  await visit(directory); return result;
}
if (phase === 'mark') await writeFile(join(root, 'baseline.json'), JSON.stringify(await snapshot(invalidWorkspace)));
else if (phase === 'check') assert.deepEqual(await snapshot(invalidWorkspace), JSON.parse(await readFile(join(root, 'baseline.json'), 'utf8')));
else {
  await mkdir(root); const workspace = join(root, 'tracker'); const options = { workspace, author: 'memory-consumer' };
  const client = new PmClient({ pmRoot: workspace, noExtensions: true, author: options.author });
  await client.init('critical-consumer', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'alpha.md'), 'Alpha A'); await writeFile(join(source, 'beta.md'), 'Beta A');
  assert.equal((await importDir(source, { ...options, from: 'cursor' })).imported, 2);
  const output = join(root, 'output'); await exportDir(output, { ...options, to: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(output, POLICY_MANIFEST), 'utf8')); const alpha = manifest.guidance.find(row => row.slug === 'alpha');
  const file = join(output, alpha.path); const bytes = await readFile(file, 'utf8'); await writeFile(file, bytes.slice(0, bytes.indexOf('\n') + 1) + 'Alpha B');
  const item = (await client.listAllComplete()).items.find(row => row.memory_slug === 'alpha');
  const worker = join(process.cwd(), 'critical-peer.mjs');
  await writeFile(worker, [
    "import { PmClient } from '@unbrained/pm-cli/sdk';",
    "const [workspace,id,prefix] = process.argv.slice(2);",
    "const client = new PmClient({pmRoot:workspace,noExtensions:true,author:'memory-consumer'});",
    "await client.update(id,{body:'Peer native C',priority:1,message:'bulk-item-transaction '+prefix+' copied-prefix apply'});"
  ].join('\n'));
  let injected = false; let peer;
  await assert.rejects(importDir(output, { ...options, from: 'agents-md', onTransition: async event => {
    if (!injected && event.transition === 'step_recorded' && !/-nodes$|-snapshot$|-rollback$/.test(event.transactionId)) {
      injected = true;
      const child = spawnSync(process.execPath, [worker, workspace, item.id, event.transactionId], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: root, GIT_CEILING_DIRECTORIES: root } });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); peer = (await client.get(item.id, { full: true })).item;
    }
  } }), error => error instanceof MemoryError && error.code === 'conflict');
  assert.equal(injected, true); assert.deepEqual((await client.get(item.id, { full: true })).item, peer);
  await importDir(output, { ...options, from: 'agents-md' }); assert.deepEqual((await client.get(item.id, { full: true })).item, peer);
  const invalid = new PmClient({ pmRoot: invalidWorkspace, author: options.author, noExtensions: true });
  await invalid.init('critical-invalid', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const bad = join(root, 'bad'); await cp(output, bad, { recursive: true }); alpha.relationships = [{ slug: 'beta', kind: 'related', created_at: { invalid: true } }];
  await writeFile(join(bad, POLICY_MANIFEST), JSON.stringify(manifest)); const before = await snapshot(invalidWorkspace);
  await assert.rejects(importDir(bad, { workspace: invalidWorkspace, author: options.author, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'relationship');
  assert.deepEqual(await snapshot(invalidWorkspace), before);
  await writeFile(join(process.cwd(), 'critical-receipt-' + label + '.json'), JSON.stringify({ workspace: invalidWorkspace, input: bad }));
}
console.log('exact ownership accepted');`;
}
