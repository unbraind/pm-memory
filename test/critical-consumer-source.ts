/** Exercise the installed SDK and a second native runtime process, without repository source imports. */
export function criticalConsumerSource(): string {
  return String.raw`import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { importDir, exportDir, remember, POLICY_MANIFEST, MemoryError } from 'pm-memory';
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
    "const [workspace,id,prefix,target] = process.argv.slice(2);",
    "const client = new PmClient({pmRoot:workspace,noExtensions:true,author:'memory-consumer'});",
    "await client.update(id,{...(target?{dep:['id='+target+',kind=depends_on']}:{body:'Peer native C',priority:1}),message:'bulk-item-transaction '+prefix+' copied-prefix apply'});"
  ].join('\n'));
  let injected = false; let peer; let peerBefore;
  await importDir(output, { ...options, from: 'agents-md', onTransition: async event => {
    if (!injected && event.transition === 'step_recorded' && event.transactionId.endsWith('-snapshot')) {
      injected = true;
      peerBefore = (await client.get(item.id, {full:true})).item;
      const child = spawnSync(process.execPath, [worker, workspace, item.id, event.transactionId], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: root, GIT_CEILING_DIRECTORIES: root } });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); peer = (await client.get(item.id, { full: true })).item;
    }
  } });
  assert.equal(injected, true);
  async function checkPeer() {
    const actual = (await client.get(item.id, {full:true})).item;
    const changedKeys = Object.keys(peer).filter(name => name !== 'updated_at' && !isDeepStrictEqual(peer[name], peerBefore[name]));
    for (const name of changedKeys) assert.deepEqual(actual[name], peer[name], 'peer field ' + name);
  }
  await checkPeer(); await importDir(output, { ...options, from: 'agents-md' }); await checkPeer();
  const gamma = join(root, 'gamma.md'); await writeFile(gamma, 'Gamma remains a native identity');
  const task = (await client.create({title:'Native dependent task'})).item.id;
  let referenced = false; let gammaId; let runPrefix;
  await assert.rejects(importDir(gamma, {...options, from:'agents-md', onStep:async step => {
    if(step !== 'publication' || referenced) return;
    gammaId = (await client.listAllComplete()).items.find(row => row.memory_slug === 'gamma').id;
    const child = spawnSync(process.execPath,[worker,workspace,task,runPrefix,gammaId],{encoding:'utf8',timeout:60000,env:{...process.env,PATH:root,GIT_CEILING_DIRECTORIES:root}});
    assert.equal(child.error,undefined); assert.equal(child.status,0,child.stderr); referenced = true; throw new Error('Interrupt gamma after its successful forward write');
  }, onTransition:event => {
    runPrefix = event.transactionId;

  }}), error => error instanceof MemoryError);
  assert.ok(referenced); const retained = (await client.listAllComplete()).items;
  assert.equal(retained.find(row => row.id === gammaId).status,'open');
  assert.ok(retained.find(row => row.id === task).dependencies.some(edge => edge.id === gammaId));
  assert.equal((await importDir(gamma,{...options,from:'agents-md'})).unchanged,1);
  for(const row of retained) for(const edge of row.dependencies ?? []) assert.ok(retained.some(target => target.id === edge.id),'dangling consumer edge');
  const retainedSource = join(root, 'retained.md');
  const retainedText = '---\nname: retained\ndescription: Hook\n---\nBody A';
  await writeFile(retainedSource, retainedText); await importDir(retainedSource, { ...options, from: 'cursor' });
  const preservedId = (await client.listAllComplete()).items.find(row => row.memory_slug === 'retained').id;
  await client.update(preservedId, { description: 'Native hook C' });
  await writeFile(retainedSource, retainedText.replace('Body A', 'Body B'));
  assert.equal((await importDir(retainedSource, { ...options, from: 'cursor' })).updated, 1);
  const retainedNative = (await client.get(preservedId, { full: true })).item;
  assert.equal(retainedNative.description, 'Native hook C');
  assert.equal((await importDir(retainedSource, { ...options, from: 'cursor' })).unchanged, 1);
  assert.deepEqual((await client.get(preservedId, { full: true })).item, retainedNative);
  await client.update(preservedId, { description: 'Peer hook D' });
  const newest = (await client.get(preservedId, { full: true })).item;
  const conflict = await importDir(retainedSource, { ...options, from: 'cursor' });
  assert.ok(conflict.skipped.some(row => row.conflict?.code === 'import_conflict' && row.conflict.fields.includes('description')));
  assert.deepEqual((await client.get(preservedId, { full: true })).item, newest);
  const pinSource = join(root, 'pin-source'); const pinTarget = join(root, 'pin-target');
  const pinSourceOptions = { workspace: pinSource, author: options.author }; const pinTargetOptions = { workspace: pinTarget, author: options.author };
  const sourceClient = new PmClient({ pmRoot: pinSource, author: options.author, noExtensions: true });
  const targetClient = new PmClient({ pmRoot: pinTarget, author: options.author, noExtensions: true });
  await sourceClient.init('pin-source', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  await targetClient.init('pin-target', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const pin = await remember('Pin chronology reference', { ...pinSourceOptions, slug: 'pin-age', kind: 'reference' });
  const old = '2020-01-01T00:00:00.000Z'; await sourceClient.run('update', { id: pin.id, options: { memoryChangedAt: old } });
  await remember('Pin chronology reference', { ...pinSourceOptions, update: pin.slug, kind: 'reference', pin: true });
  assert.equal((await sourceClient.get(pin.id, { full: true })).item.memory_changed_at, old);
  const pinSeed = join(root, 'pin-seed'); await exportDir(pinSeed, { ...pinSourceOptions, to: 'agents-md' });
  await importDir(pinSeed, { ...pinTargetOptions, from: 'agents-md' });
  const copiedPin = (await targetClient.listAllComplete()).items.find(row => row.memory_slug === pin.slug);
  for (const [to, pinned] of [['agents-md', false], ['claude-code', true]]) {
    await remember('Pin chronology reference', { ...pinSourceOptions, update: pin.slug, kind: 'reference', pin: pinned });
    await targetClient.run('update', { id: copiedPin.id, options: { memoryChangedAt: old, memoryVerdict: 'stale', memoryVerifiedAt: old, memoryReason: 'Prior pin evidence' } });
    const directory = join(root, 'pin-' + to); await exportDir(directory, { ...pinSourceOptions, to });
    assert.equal((await importDir(directory, { ...pinTargetOptions, from: to })).updated, 1);
    const current = (await targetClient.get(copiedPin.id, { full: true })).item;
    assert.deepEqual([current.memory_pinned, current.memory_changed_at, current.memory_verdict, current.memory_verified_at, current.memory_reason], [pinned, old, 'unknown', undefined, undefined]);
  }
  for (const from of ['agents-md', 'claude-code', 'cursor']) {
    const scalarWorkspace = join(root, 'scalar-' + from); const scalarOptions = { workspace: scalarWorkspace, author: options.author };
    const scalarClient = new PmClient({ pmRoot: scalarWorkspace, noExtensions: true, author: options.author });
    await scalarClient.init('scalar-consumer', { defaults: true, agentGuidance: 'skip', mergeFence: false });
    const scalarFile = join(root, 'scalar-' + from + '.md');
    await writeFile(scalarFile, '---\nname: Scalar: value\ndescription: Hook: retained\n---\nScalar body');
    assert.equal((await importDir(scalarFile, { ...scalarOptions, from })).imported, 1);
    const scalarId = (await scalarClient.listAllComplete({ includeBody: true })).items[0].id;
    const scalar = (await scalarClient.get(scalarId, { full: true })).item;
    assert.equal(scalar.title, 'Scalar: value'); assert.equal(scalar.description, 'Hook: retained'); assert.equal(scalar.body, 'Scalar body');
    for (const to of ['agents-md', 'claude-code']) {
      const directory = join(root, 'scalar-output-' + from + '-' + to);
      await exportDir(directory, { ...scalarOptions, to });
      assert.equal((await importDir(directory, { ...scalarOptions, from: to })).updated, 0);
      assert.deepEqual((await scalarClient.get(scalar.id, { full: true })).item, scalar);
    }
  }
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
