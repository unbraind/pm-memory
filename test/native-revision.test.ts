import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { PmClient, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { remember, verify } from '../index.ts';
import { commitNativeFields, nativeState, sameNativeProof } from '../src/native-revision.ts';
import { metadata } from '../src/store.ts';
import { digest } from '../src/core.ts';
import { tracker } from './helpers.ts';

/** Capture real SDK evidence before exercising guarded native publication. */
async function fixture(t: Parameters<typeof tracker>[0]) {
  const target = await tracker(t);
  const item = await remember('Original A', { ...target.options, slug: 'alpha', kind: 'reference' });
  return { ...target, id: item.id };
}

test('native proof identity checks content, history length and history hash while ignoring diagnostic time', async t => {
  const target = await fixture(t); const { proof } = await nativeState(target.store, target.id);
  assert.equal(sameNativeProof({ ...proof, version: '1970-01-01T00:00:00.000Z' }, proof), true);
  assert.equal(sameNativeProof({ ...proof, hash: null }, proof), false);
  assert.equal(sameNativeProof({ ...proof, length: proof.length + 1 }, proof), false);
  const history = digest('independent synthetic history'); assert.notEqual(history, proof.history);
  assert.equal(sameNativeProof({ ...proof, history }, proof), false);
});

for (const noop of [false, true]) test(`native publication rechecks a real peer at the ${noop ? 'SDK no-op read-back' : 'SDK pre-write hook'}`, { timeout: 60000 }, async t => {
  const target = await fixture(t); const at = '2026-06-01T12:00:00.000Z';
  const evidence = { verdict: 'verified', reason: '', verified_at: at };
  if (noop) await target.store.fields(target.id, evidence);
  const expected = (await nativeState(target.store, target.id)).proof;
  const options = metadata(evidence); let peer: unknown;
  // Evaluating the real mutation input dispatches an independent SDK writer after the first guard.
  Object.defineProperty(options, 'memoryVerdict', { enumerable: true, get: () => {
    const script = "import { PmClient } from '@unbrained/pm-cli/sdk'; const client = new PmClient({cwd:process.argv[3],pmRoot:process.argv[2],author:'native-peer',noExtensions:true}); await client.update(process.argv[1],{body:'Native C'}); console.log(JSON.stringify((await client.get(process.argv[1],{full:true})).item));";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, target.id, target.workspace, target.root], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: target.root, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr);
    peer = JSON.parse(result.stdout) as unknown;
    return 'verified';
  } });
  assert.equal(await target.store.write(() => commitNativeFields(target.store, target.id, expected, options)), false);
  assert.ok(peer);
  assert.deepEqual((await target.client.get(target.id, { full: true })).item, peer, 'retain every field committed by the peer');
});

test('native guarded publication propagates write failures and restores disposable permissions', async t => {
  const target = await fixture(t); const expected = (await nativeState(target.store, target.id)).proof;
  const folder = join(target.workspace, 'knowledge'); const mode = (await stat(folder)).mode & 0o7777;
  try {
    await chmod(folder, 0o500);
    await assert.rejects(target.store.write(() => commitNativeFields(target.store, target.id, expected, metadata({ verdict: 'verified', reason: '', verified_at: '2026-06-01T12:00:00.000Z' }))), /EACCES|permission|read.only|write/iu);
  } finally { await chmod(folder, mode); }
  assert.equal((await stat(folder)).mode & 0o7777, mode);
  assert.equal((await target.client.get(target.id, { full: true })).item.body, 'Original A');
});


test('guarded verification retains environment and explicit invocation author precedence', async t => {
  const restore = new Map([['PM_AUTHOR', process.env.PM_AUTHOR]]);
  Object.assign(process.env, { PM_AUTHOR: 'environment-agent' });
  t.after(() => { for (const [key, value] of restore) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const author of [undefined, 'explicit-agent']) {
    const target = await fixture(t);
    const client = new PmClient({ pmRoot: target.workspace, author: 'host-fallback', noExtensions: true });
    assert.equal((await verify({ workspace: target.workspace, root: target.root, client, author })).checked, 1);
    const history = await readHistoryEntries(getHistoryPath(target.workspace, target.id), target.id);
    assert.equal(history.at(-1)!.author, author ?? 'environment-agent');
  }
  const target = await fixture(t);
  const expected = (await nativeState(target.store, target.id)).proof;
  const options = { ...metadata({ verdict: 'verified', verified_at: '2026-06-01T12:00:00.000Z' }), author: 'per-call-agent' };
  assert.equal(await target.store.write(() => commitNativeFields(target.store, target.id, expected, options)), true);
  assert.equal((await readHistoryEntries(getHistoryPath(target.workspace, target.id), target.id)).at(-1)!.author, 'per-call-agent');
});
