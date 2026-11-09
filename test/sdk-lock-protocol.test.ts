import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { acquireLockLease, PmCliError } from '@unbrained/pm-cli/sdk';
import { remember, MemoryError } from '../index.ts';
import { tracker } from './helpers.ts';

/** Start a package writer with Git unavailable and wait for its live lease. */
async function writer(t: TestContext, root: string, workspace: string, mode = 'item') {
  const child = fork(new URL('./lease-writer.ts', import.meta.url), [workspace, mode, join(root, 'published')], {
    silent: true, cwd: root,
    env: { ...process.env, PM_LOCK_WAIT_MS: '0', PATH: root, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  t.after(() => { child.kill('SIGKILL'); });
  assert.deepEqual(await once(child, 'message'), ['holding', undefined]);
  return child;
}

test('SDK process-start evidence recovers a reused PID while protecting a live owner', async t => {
  const { root, workspace, store } = await tracker(t);
  const child = await writer(t, root, workspace);
  const path = join(workspace, 'locks', 'memory-writer.lock');
  const payload = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const environment = { ...process.env };
  t.after(() => { process.env = environment; });
  process.env.PM_LOCK_WAIT_MS = '0';
  await assert.rejects(store.write(async () => assert.fail('live owner was reclaimed')), error => {
    assert.ok(error instanceof MemoryError && error.code === 'conflict');
    assert.ok(error.cause instanceof PmCliError); assert.equal(error.cause.exitCode, 4);
    assert.equal(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable, false);
    return true;
  });
  assert.equal(typeof payload.host_identity, 'string');
  assert.match(String(payload.process_start_identity), /^\d+$/);
  await writeFile(path, JSON.stringify({ ...payload, process_start_identity: String(BigInt(String(payload.process_start_identity)) + 1n) }));
  assert.equal(await store.write(async () => 42), 42, 'original process identity mismatch must recover despite a live PID');
});

test('terminated owner recovers through the SDK in a non-git tracker without Git', async t => {
  const { root, workspace, store } = await tracker(t);
  const child = await writer(t, root, workspace);
  const exited = once(child, 'exit'); child.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  await store.write(() => store.client.create({ title: 'Recovered native writer', type: 'Task' }));
  assert.equal((await store.client.listAllComplete()).items[0].title, 'Recovered native writer');
});

for (const mode of ['item', 'file', 'export']) {
  test(`expired writer cannot publish ${mode} through a successor lease`, async t => {
    const { root, workspace, store, options } = await tracker(t);
    if (mode === 'export') await remember('Verified portable policy', { ...options, kind: 'project', slug: 'portable' });
    const child = await writer(t, root, workspace, mode);
    const path = join(workspace, 'locks', 'memory-writer.lock');
    const payload = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    // Advance this lease's recorded age without waiting an hour in the regression.
    await writeFile(path, JSON.stringify({ ...payload, created_at: new Date(0).toISOString() }));
    const successor = await acquireLockLease(workspace, 'memory-writer', 3600, 'successor', true, true, 0, { maxWaitMs: 0 });
    t.after(() => successor.release());
    const successorBytes = await readFile(path, 'utf8');
    const message = once(child, 'message'); const exited = once(child, 'exit'); child.send('publish');
    assert.deepEqual((await message)[0], { code: 'lock_lost' });
    assert.deepEqual(await exited, [0, null]);
    assert.equal(await readFile(path, 'utf8'), successorBytes, 'stale release must preserve successor ownership');
    assert.equal((await store.client.listAllComplete()).items.length, mode === 'export' ? 1 : 0);
    await assert.rejects(readFile(join(root, 'published')), { code: 'ENOENT' });
  });
}

test('unfenced administrative dispatch and standalone file publication remain available', async t => {
  const { store } = await tracker(t);
  assert.equal(await store.fence(async () => 42), 42);
  assert.equal((await store.client.listAllComplete()).items.length, 0);
});

test('detached native publication cannot reuse a completed fence or released writer lease', async t => {
  const { store } = await tracker(t); let resume: () => void = () => {}; let delayed: Promise<unknown> | undefined;
  const ready = new Promise<void>(resolve => { resume = resolve; });
  await store.write(() => store.fence(async () => {
    delayed = (async () => { await ready; return store.client.create({ title: 'Detached stale publication', type: 'Task' }); })();
    assert.equal((await store.client.listAllComplete()).items.length, 0, 'nested SDK reads reuse the active fence');
  }));
  const refused = assert.rejects(delayed!, { code: 'lock_lost' }); resume(); await refused;
  assert.equal((await store.client.listAllComplete()).items.length, 0);
});
