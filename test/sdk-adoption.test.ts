import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commitWorkspaceTransaction, readWorkspaceTransaction, readItemTransaction, WorkspaceTransactionInterruptedError, PmClient, readHistoryEntries, getHistoryPath } from '@unbrained/pm-cli/sdk';
import type { PortableImportResult } from '../index.ts';
import { importDir, MemoryError, remember } from '../index.ts';
import { importIdentity, retireOwnedTransaction, retainForwardWrites } from '../src/portable-plan.ts';
import { previousOwnership } from '../src/portable-ownership.ts';
import { capturedPublication, applyCaptured } from './portable-publication-helpers.ts';
import { nativeHost } from './native-host-helpers.ts';
import { tracker, snapshot } from './helpers.ts';
import { privacy } from '../src/core.ts';

for (const host of [false, true]) test(`locked SDK revision refuses a concurrent foreign-field edit (${host ? 'host' : 'directory'})`, async t => {
  const { target, mutation } = await capturedPublication(t); let injected = false;
  const run = async (client?: PmClient) => importDir(join(target.root, 'input'), { ...target.options, client, from: 'agents-md', onStep: async step => {
    if (step !== 'revision-bound' || injected) return;
    injected = true; await target.client.update(mutation.id, { priority: 1 });
  } });
  const result = host ? await nativeHost(target.workspace, run) : await run();
  assert.ok(injected); assert.equal(result.updated, 0);
  assert.ok((result as PortableImportResult).skipped.some(row => row.conflict?.fields.includes('revision')));
  const item = (await target.client.get(mutation.id, { full: true })).item;
  assert.equal(item.body, 'Alpha A'); assert.equal(item.priority, 1);
});

test('public reader refuses malformed occupied identities rather than selecting around an unvalidated receipt', async t => {
  const target = await tracker(t); const input = 'public-reader-control'; const candidate = 'stable-attempt';
  const identity = await importIdentity(target.store, input, candidate);
  await commitWorkspaceTransaction({ pmRoot: target.workspace, author: target.options.author, transactionId: identity.transactionId, steps: [{ id: 'foreign', inspect: async () => ({ state: 'pending' }), apply: async () => null, compensate: retainForwardWrites }] });
  assert.ok(await readItemTransaction(target.workspace, identity.transactionId));
  assert.notEqual((await importIdentity(target.store, input, candidate)).transactionId, identity.transactionId);
  const file = join(target.workspace, 'transactions', 'sdk', `${identity.transactionId}.json`);
  const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const malformed = JSON.stringify({ ...original, schemaVersion: 999 }); await writeFile(file, malformed);
  await assert.rejects(importIdentity(target.store, input, candidate), error => error instanceof MemoryError && error.code === 'transaction');
  assert.equal(await readFile(file, 'utf8'), malformed);
});

test('public receipt validation cannot grant ownership from a counterfeit SDK schema', async t => {
  const { target, plan, mutation } = await capturedPublication(t); await applyCaptured(target, plan);
  const [item] = await target.store.read(); const ids = new Map([[item.id, item.slug]]);
  const owned = await previousOwnership(target.store, item, ids); assert.ok(owned?.fields.body);
  // Deliberate storage corruption is confined to this disposable tracker.
  const message = (await importHistory(target.workspace, mutation.id)).at(-1)!.message!;
  const transactionId = /^bulk-item-transaction (\S+) /.exec(message)![1];
  const journal = await readWorkspaceTransaction(target.workspace, `${transactionId}-snapshot`); assert.ok(journal);
  const file = join(target.workspace, 'transactions', 'sdk', `${transactionId}-snapshot.json`);
  const malformed = JSON.stringify({ ...journal, schemaVersion: 999 }); await writeFile(file, malformed);
  const kept = await snapshot(target.workspace);
  assert.notEqual((await previousOwnership(target.store, item, ids))?.fields.body, owned.fields.body);
  assert.equal(await readFile(file, 'utf8'), malformed); assert.deepEqual(await snapshot(target.workspace), kept);
});

test('supported abandonment retires an interrupted owned step and preserves a foreign item batch', async t => {
  const target = await tracker(t); const transactionId = 'owned-retirement-control';
  const steps = [{ id: 'owned-step', inspect: async () => ({ state: 'pending' as const }), apply: async () => null, compensate: retainForwardWrites }];
  await assert.rejects(commitWorkspaceTransaction({ pmRoot: target.workspace, author: target.options.author, transactionId, steps, onTransition: event => { if (event.transition === 'prepared') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const kept = await snapshot(target.workspace);
  await retireOwnedTransaction(target.store, transactionId, target.options.author, 'owned-step');
  assert.equal((await readWorkspaceTransaction(target.workspace, transactionId))?.status, 'abandoned');
  await retireOwnedTransaction(target.store, transactionId, target.options.author, 'owned-step');
  await assert.rejects(target.client.commitItemMutations({ transactionId: 'foreign-batch-control', mutations: [{ op: 'create', id: 'memory-test-foreign', options: { title: 'Foreign planned task' } }], onTransition: event => { if (event.transition === 'prepared') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  await assert.rejects(commitWorkspaceTransaction({ pmRoot: target.workspace, author: target.options.author, transactionId: 'started-retirement-control', steps, onTransition: event => { if (event.transition === 'step_applied') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  await retireOwnedTransaction(target.store, 'started-retirement-control', target.options.author, 'owned-step');
  assert.equal((await readWorkspaceTransaction(target.workspace, 'started-retirement-control'))?.status, 'abandoned');
  await commitWorkspaceTransaction({ pmRoot: target.workspace, author: target.options.author, transactionId: 'committed-retirement-control', steps });
  await retireOwnedTransaction(target.store, 'committed-retirement-control', target.options.author, 'owned-step');
  assert.equal((await readWorkspaceTransaction(target.workspace, 'committed-retirement-control'))?.status, 'committed');
  for (const [author, ids, requested] of [['foreign-author', ['owned-step'], 'owned-step'], [target.options.author, ['one', 'two'], 'one'], [target.options.author, ['foreign-step'], 'owned-step']] as const) {
    const id = `foreign-${requested}-${ids.length}-${author}`;
    await assert.rejects(commitWorkspaceTransaction({ pmRoot: target.workspace, author, transactionId: id, steps: ids.map(id => ({ ...steps[0], id })), onTransition: event => { if (event.transition === 'prepared') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
    const before = await readWorkspaceTransaction(target.workspace, id);
    await assert.rejects(retireOwnedTransaction(target.store, id, target.options.author, requested), error => error instanceof MemoryError && error.code === 'foreign_intent');
    assert.deepEqual(await readWorkspaceTransaction(target.workspace, id), before);
  }
  const foreign = await readItemTransaction(target.workspace, 'foreign-batch-control'); assert.ok(foreign);
  await assert.rejects(retireOwnedTransaction(target.store, 'foreign-batch-control', foreign.journal.author, foreign.journal.stepIds[0]), error => error instanceof MemoryError && error.code === 'foreign_intent');
  assert.deepEqual(await readItemTransaction(target.workspace, 'foreign-batch-control'), foreign);
  const after = await snapshot(target.workspace);
  // Supported abandonment appends workspace audit events; it never erases them.
  delete kept['history/_workspace.jsonl']; delete after['history/_workspace.jsonl'];
  assert.deepEqual(after, kept);
});

/** Read native history through the supported SDK stream reader. */
async function importHistory(workspace: string, id: string) { return readHistoryEntries(getHistoryPath(workspace, id), id); }

for (const encoding of ['raw', 'percent', 'escape', 'unicode', 'hex', 'nested', 'overlimit', 'invisible'] as const) test(`shared SDK secrets refuse ${encoding} content before any tracker write without echo`, async t => {
  const target = await tracker(t); const secret = 'npm_' + 'SyntheticFixture1234567890';
  let fixture = secret;
  if (['percent', 'nested', 'overlimit'].includes(encoding)) for (let depth = 0; depth < (encoding === 'nested' ? 4 : encoding === 'overlimit' ? 5 : 1); depth++) fixture = [...fixture].map(char => '%' + char.charCodeAt(0).toString(16)).join('');
  if (encoding === 'escape' || encoding === 'hex') fixture = [...secret].map(char => encoding === 'escape' ? '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0') : '\\x' + char.charCodeAt(0).toString(16)).join('');
  if (encoding === 'unicode') fixture = [...secret].map(char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)).join('');
  if (encoding === 'invisible') fixture = secret.slice(0, 2) + '\u200b' + secret.slice(2);
  const kept = await snapshot(target.workspace);
  for (const allowEmail of [false, true]) await assert.rejects(remember(fixture, { ...target.options, allowEmail, kind: 'reference' }), error => {
    assert.ok(error instanceof MemoryError); assert.equal(error.code, 'privacy');
    assert.ok(!JSON.stringify({ message: error.message, remedy: error.remedy, cause: error.cause }).includes(secret));
    assert.ok(!error.message.includes(fixture)); return true;
  });
  assert.deepEqual(await snapshot(target.workspace), kept);
  await remember('Use a secret manager; token=$SOME_VARIABLE; password=${BUILD_PASSWORD}; invalid encoding %ff remains literal', { ...target.options, kind: 'reference', slug: 'safe' });
  await remember('Contact person@example.test', { ...target.options, allowEmail: true, kind: 'reference', slug: 'consented', forceNew: true });
});

test('SDK credential policy rejects new provider keys in raw portable files and retains safe long input', async t => {
  const target = await tracker(t); const path = join(target.root, 'input'); await mkdir(path);
  const file = join(path, 'alpha.md'); const long = 'eyJ-'.repeat(50000);
  await writeFile(file, long); assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).imported, 1);
  const kept = await snapshot(target.workspace);
  for (const secret of ['xoxb-' + 'SyntheticFixture12345', 'ASIA' + 'ABCDEFGHIJKLMNOP', 'glpat-' + 'SyntheticFixture1234567890']) {
    await writeFile(file, long + '\n' + secret);
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md' }), error => error instanceof MemoryError && error.code === 'privacy' && !error.message.includes(secret));
    assert.deepEqual(await snapshot(target.workspace), kept);
  }
});


test('shared scanner and stronger memory supplements retain legacy refusals and environment allowances', () => {
  for (const value of [
    'npm_' + 'SyntheticFixture1234567890', 'pk-' + 'x'.repeat(16), 'rk-' + 'x'.repeat(16),
    'sk-' + 'x'.repeat(16), 'sk-proj-' + 'x'.repeat(16), 'SK-' + 'X'.repeat(25),
    'ghp_' + 'x'.repeat(16), 'GHP_' + 'X'.repeat(25), 'akia' + 'abcdefghijklmnop',
    '-----begin rsa private key-----', '-----BEGIN ' + 'X'.repeat(160) + ' PRIVATE KEY-----',
    'Authorization: Basic synthetic-value', 'pwd=lowentropy', 'access token=lowentropy',
    'https://synthetic:lowentropy@service.test/path',
    'eyJ' + 'x'.repeat(400) + '.' + 'x'.repeat(400) + '.' + 'x'.repeat(8),
  ]) assert.throws(() => privacy(value, true), error => error instanceof MemoryError && error.code === 'privacy');
  for (const value of ['', 'token: accounting', 'password=$BUILD_PASSWORD', '_authToken=${BUILD_TOKEN}', 'Use a secret manager', 'https://service.test/path', 'resources/guide.md']) privacy(value);
});
