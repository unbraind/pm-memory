import assert from 'node:assert/strict';
import fs, { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getItemPath, commitItemMutations } from '@unbrained/pm-cli/sdk';
import { exportDir, get, importDir, MemoryError, observe, recall, remember, verify } from '../index.ts';
import { digest } from '../src/core.ts';
import { memoryVectors, type EmbeddingProvider } from '../src/embeddings.ts';
import { previousOwnership, recordedCreation } from '../src/portable-ownership.ts';
import { ensureTrackerOrigin, readTrackerOrigin, TRACKER_ORIGIN_FILE } from '../src/portable-origin.ts';
import { importIdentity, pendingImport } from '../src/portable-plan.ts';
import { tracker, snapshot } from './helpers.ts';

/** Inject one filesystem boundary while retaining real SDK trackers and dispatch. */
function ioFault(t: TestContext, method: 'readFile' | 'mkdir' | 'realpath' | 'open' | 'link', path: string, error: MemoryError, argument = 0): () => void {
  const original = fs[method];
  const hook = t.mock.method(fs, method, (async (...args: unknown[]) => {
    if (String(args[argument]) === path) throw error;
    const result: unknown = Reflect.apply(original, fs, args);
    return result;
  }) as typeof original);
  syncBuiltinESMExports();
  return () => { hook.mock.restore(); syncBuiltinESMExports(); };
}

test('standalone registration reads command context once and retains every schema boundary', async t => {
  const target = await tracker(t); const steps: string[] = []; let reads = 0;
  const original = fs.readFile;
  const hook = t.mock.method(fs, 'readFile', (async (...args: Parameters<typeof original>) => {
    if (args[0] === join(target.workspace, 'context-intents.json')) reads++;
    return original(...args);
  }) as typeof original);
  syncBuiltinESMExports();
  try { await target.store.write(() => target.store.register(step => { steps.push(step); })); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(reads, 1, 'One logical registration must activate the standalone SDK context once');
  assert.equal(steps.filter(step => step.startsWith('schema-field:')).length, 25);
  assert.ok(steps.includes('schema-type')); assert.ok(steps.includes('origin-published'));
  assert.equal((await target.client.schemaListFields()).fields.filter(field => field.key.startsWith('memory_')).length, 25);
});

test('typed namespace and committed receipt failures keep their original identity', async t => {
  const target = await tracker(t);
  const identity = await importIdentity(target.store, 'typed-namespace', 'stable');
  const failure = new MemoryError('conflict', 'Synthetic boundary refusal', 'Retry safely');
  const restore = ioFault(t, 'readFile', join(target.workspace, 'transactions', 'sdk', identity.transactionId + '.json'), failure);
  try { await assert.rejects(importIdentity(target.store, 'typed-namespace', 'stable'), error => error === failure); }
  finally { restore(); }
  const input = join(target.root, 'input'); await mkdir(input); await writeFile(join(input, 'guide.md'), 'Public imported guidance');
  await importDir(input, { ...target.options, from: 'agents-md' });
  const memory = (await target.store.read())[0]; const original = fs.readFile;
  const hook = t.mock.method(fs, 'readFile', (async (...args: Parameters<typeof original>) => {
    if (String(args[0]).startsWith(join(target.workspace, 'transactions', 'sdk')) && String(args[0]).endsWith('-snapshot.json')) throw failure;
    return original(...args);
  }) as typeof original);
  syncBuiltinESMExports();
  try { await assert.rejects(previousOwnership(target.store, memory, new Map()), error => error === failure); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test('typed pending intent parsing failures retain the intent and original error', async t => {
  const target = await tracker(t); const payload = '{"typed-parser-control":true}';
  await mkdir(join(target.workspace, 'runtime'));
  await writeFile(join(target.workspace, 'runtime', 'memory-policy-import.json'), JSON.stringify({ owner: 'pm-memory-policy-plan:1', payload, checksum: digest(payload) }));
  const intent = join(target.workspace, 'runtime', 'memory-policy-import.json'); const intentBefore = await readFile(intent);
  const before = await snapshot(target.workspace);
  const failure = new MemoryError('conflict', 'Synthetic parser refusal', 'Retry safely');
  const original = JSON.parse;
  const hook = t.mock.method(JSON, 'parse', (...args: Parameters<typeof original>) => {
    if (args[0] === payload) throw failure;
    return original(...args);
  });
  try { await assert.rejects(pendingImport(target.store), error => error === failure); }
  finally { hook.mock.restore(); }
  assert.deepEqual(await snapshot(target.workspace), before);
  assert.deepEqual(await readFile(intent), intentBefore);
});

test('typed embedding cache and native task failures are never recoded', async t => {
  const target = await tracker(t);
  const saved = await remember('Public release guidance', { ...target.options, kind: 'reference', slug: 'release' });
  const memory = await get(saved.slug, target.options);
  const provider: EmbeddingProvider = { identity: async () => 'typed-cache-control', embed: async inputs => inputs.map(() => [1]) };
  const failure = new MemoryError('conflict', 'Synthetic IO refusal', 'Retry safely');
  let restore = ioFault(t, 'mkdir', join(target.workspace, 'runtime', 'memory-embeddings', digest('typed-cache-control')), failure);
  try { await assert.rejects(memoryVectors([memory], target.workspace, provider), error => error === failure); }
  finally { restore(); }
  const packet = await recall(saved.slug, target.options); assert.ok(packet.recall);
  const task = await target.client.create({ title: 'Public task' });
  restore = ioFault(t, 'readFile', getItemPath(target.workspace, 'Task', task.item.id), failure);
  try {
    await assert.rejects(observe(saved.slug, { ...target.options, recall: packet.recall, task: task.item.id, feedback: 'helpful', outcome: 'improved', attribution: 'isolated', evidence: 'Synthetic public comparison' }), error => error === failure);
  } finally { restore(); }
});

test('typed file evidence failures and peer export failures retain their identity', async t => {
  const target = await tracker(t); const source = join(target.root, 'source'); await mkdir(source);
  const file = join(source, 'public.ts'); await writeFile(file, 'export const value = 1;');
  await remember('Read `public.ts` before editing', { ...target.options, kind: 'reference' });
  const failure = new MemoryError('conflict', 'Synthetic evidence refusal', 'Retry safely');
  const restore = ioFault(t, 'realpath', file, failure);
  try { await assert.rejects(verify({ ...target.options, root: source }), error => error === failure); }
  finally { restore(); }
  const output = join(target.root, 'output'); let restoreRead = () => {};
  try {
    await assert.rejects(exportDir(output, { ...target.options, to: 'agents-md', onStep: async step => {
      if (step !== 'permissions') return;
      await mkdir(output); await writeFile(join(output, 'foreign.md'), 'Public peer output');
      restoreRead = ioFault(t, 'readFile', join(output, 'pm-memory-policy.json'), failure);
      await writeFile(join(output, 'pm-memory-policy.json'), '{}');
      await writeFile(join(output, 'AGENTS.md'), 'Public peer index');
    } }), error => error === failure);
  } finally { restoreRead(); }
  assert.equal(await readFile(join(output, 'foreign.md'), 'utf8'), 'Public peer output');
});


test('origin reads preserve typed filesystem refusals before namespace publication', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const failure = new MemoryError('privacy', 'Synthetic origin read policy refusal', 'Restore source access and retry');
  const restore = ioFault(t, 'open', join(target.workspace, TRACKER_ORIGIN_FILE), failure);
  try { await assert.rejects(readTrackerOrigin(target.store), error => error === failure); }
  finally { restore(); }
  assert.deepEqual(await snapshot(target.workspace), before);
  assert.equal(await readTrackerOrigin(target.store), undefined);
});

test('origin publication preserves typed link refusals and removes only its staging file', async t => {
  const target = await tracker(t); const failure = new MemoryError('conflict', 'Synthetic origin link policy refusal', 'Retain the namespace and retry');
  const restore = ioFault(t, 'link', join(target.workspace, TRACKER_ORIGIN_FILE), failure, 1);
  try { await assert.rejects(ensureTrackerOrigin(target.store), error => error === failure); }
  finally { restore(); }
  assert.equal(await readTrackerOrigin(target.store), undefined);
  assert.deepEqual((await readdir(join(target.workspace, 'runtime'))).filter(name => name.startsWith('memory-origin-')), []);
  const origin = await ensureTrackerOrigin(target.store);
  assert.equal(await readTrackerOrigin(target.store), origin);
});

test('recorded creation propagates unreadable publication receipts without granting or discarding ownership', async t => {
  const target = await tracker(t); await target.store.register();
  const transaction = 'memory-policy-' + 'a'.repeat(40); const id = 'memory-test-unsealed-birth';
  await commitItemMutations({ pmRoot: target.workspace, author: 'memory-test', transactionId: transaction + '-nodes', mutations: [{ op: 'create', id, options: { type: 'Knowledge', title: 'Unsealed legacy creation', memorySlug: 'legacy-birth', memoryKind: 'reference', message: `bulk-item-transaction ${transaction}-nodes ${id} create` } }] });
  assert.equal(await recordedCreation(target.store, id), false);
  const directory = join(target.workspace, 'transactions', 'sdk'); await mkdir(directory, { recursive: true });
  const receipt = join(directory, transaction + '-snapshot.json'); await writeFile(receipt, 'unreadable synthetic receipt');
  const receiptBefore = await readFile(receipt);
  const before = await snapshot(target.workspace);
  await assert.rejects(recordedCreation(target.store, id), error => {
    assert.ok(error instanceof MemoryError && error.code === 'transaction');
    assert.equal(error.message, 'Native transaction receipt could not be verified');
    assert.equal(error.remedy, 'Preserve the receipt and restore SDK-readable transaction evidence before retrying');
    assert.ok(error.cause instanceof Error); return true;
  });
  assert.deepEqual(await snapshot(target.workspace), before);
  assert.deepEqual(await readFile(receipt), receiptBefore);
});
