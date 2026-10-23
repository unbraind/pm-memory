import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import promises, { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { acquireLock, parseMutationReceipt } from '@unbrained/pm-cli/sdk';
import { consolidate, exportDir, importDir, recall, remember, verify } from '../index.ts';
import { MemoryError } from '../src/core.ts';
import { Store } from '../src/store.ts';
import { WRITER_TTL_SECONDS, writerWaitMs } from '../src/writer-lock.ts';
import { snapshot, tracker } from './helpers.ts';

/** Bound adversarial refusals without changing the package default wait. */
function failFast(t: TestContext): void {
  const previous = process.env.PM_LOCK_WAIT_MS; process.env.PM_LOCK_WAIT_MS = '0';
  t.after(() => { if (previous === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = previous; });
}
/** Start a real independent writer and wait until its critical section is entered. */
async function holder(t: TestContext, workspace: string) {
  const child = fork(new URL('./writer-holder.ts', import.meta.url), [workspace], { silent: true });
  t.after(() => { child.kill('SIGKILL'); });
  const ready = await once(child, 'message');
  assert.deepEqual(ready, ['holding', undefined]);
  return child;
}
/** Require actionable contention and ensure the callback cannot enter. */
async function blocked(store: Store): Promise<void> {
  await assert.rejects(store.write(async () => { assert.fail('critical section entered'); }), error => {
    assert.ok(error instanceof MemoryError);
    assert.equal(error.code, 'conflict');
    assert.match(error.message, /holder|PID/);
    assert.match(error.message, /age (?:\d+s|unknown)/);
    assert.match(error.remedy, /Retry.*Dead owners.*stop all writers.*owner process is dead.*locks\/memory-writer\.lock.*PID reuse/);
    return true;
  });
}

test('SIGKILLed writer recovers promptly and completes a real SDK write with native recovery', { timeout: 60000 }, async t => {
  const { store, workspace } = await tracker(t);
  failFast(t);
  const child = await holder(t, workspace);
  const lock = join(workspace, 'locks', 'memory-writer.lock');
  const payload = JSON.parse(await readFile(lock, 'utf8')) as { pid: number; owner: string; ttl_seconds: number };
  assert.equal(payload.pid, child.pid);
  assert.equal(payload.ttl_seconds, WRITER_TTL_SECONDS);
  child.kill('SIGKILL'); const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGKILL');
  const before = await snapshot(workspace);
  const started = performance.now();
  let elapsed = 0;
  const created = parseMutationReceipt(await store.write(async () => {
    elapsed = performance.now() - started;
    assert.deepEqual(await snapshot(workspace), before, 'recovery alone preserves durable bytes');
    return store.client.run('create', { options: { title: 'Recovered writer transaction', type: 'Task' } });
  }));
  assert.ok(elapsed < 5000, `dead-owner recovery took ${elapsed}ms`);
  assert.equal((await store.client.get(created.id)).item.title, 'Recovered writer transaction');
  assert.equal(payload.owner, 'writer-test');
  t.diagnostic(`SIGKILL recovery: ${elapsed.toFixed(2)}ms`);
});

test('live holder blocks and release permits a subsequent write', async t => {
  const { store, workspace } = await tracker(t);
  failFast(t);
  const child = await holder(t, workspace);
  await blocked(store);
  child.send('release'); await once(child, 'exit');
  assert.equal(await store.write(async () => 42), 42);
});

test('foreign, legacy and reused live PIDs are never reclaimed, even beyond TTL', async t => {
  const { store, workspace } = await tracker(t);
  failFast(t);
  const child = await holder(t, workspace);
  const path = join(workspace, 'locks', 'memory-writer.lock');
  const payload = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  child.kill('SIGKILL'); await once(child, 'exit');
  for (const owner of ['writer [pm-memory-host:foreign]', 'legacy-writer', payload.owner]) {
    // The test runner is an unrelated live process: simulate reuse of the recorded PID.
    const current = { ...payload, host_identity: owner === payload.owner ? payload.host_identity : owner === 'legacy-writer' ? undefined : 'foreign-host-identity', process_start_identity: undefined, owner, pid: owner === payload.owner ? process.pid : payload.pid, created_at: new Date(0).toISOString() };
    const bytes = JSON.stringify(current); await writeFile(path, bytes);
    await blocked(store);
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('simultaneous dead-owner recoverers retain mutual exclusion', async t => {
  const { store, workspace } = await tracker(t);
  const child = await holder(t, workspace);
  child.kill('SIGKILL'); await once(child, 'exit');
  let active = 0; let count = 0;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.write(async () => {
    active++; assert.equal(active, 1);
    await new Promise(resolve => { setTimeout(resolve, 15); });
    count++; active--;
  })));
  for (const result of results) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
  assert.equal(count, 8);
});

test('SDK-only dead owners now recover without package recovery', async t => {
  const { workspace } = await tracker(t);
  failFast(t);
  const child = fork(new URL('./sdk-lock-holder.ts', import.meta.url), [workspace], { silent: true });
  t.after(() => { child.kill('SIGKILL'); });
  await once(child, 'message'); child.kill('SIGKILL'); const [, signal] = await once(child, 'exit');
  assert.equal(signal, 'SIGKILL');
  const release = await acquireLock(workspace, 'sdk-repro', 3600, 'next-writer', false, true, 0);
  await release();
});

test('measure actual package critical sections across supported mutations in a non-git tracker', async t => {
  const { root, options } = await tracker(t);
  const samples: number[] = [];
  const original = Store.prototype.write;
  t.mock.method(Store.prototype, 'write', function<T>(this: Store, run: () => Promise<T>): Promise<T> {
    return original.call(this, async () => {
      const start = performance.now();
      try { return await run(); } finally { samples.push(performance.now() - start); }
    }) as Promise<T>;
  });
  const source = join(root, 'source'); await mkdir(source);
  for (let index = 0; index < 12; index++) await writeFile(join(source, `row-${index}.md`), `Imported distinct guidance number ${index}\n`);
  await importDir(source, { ...options, from: 'claude-code' });
  await remember('Synthetic critical section measurement', { ...options, kind: 'project', slug: 'measure' });
  await recall('guidance', { ...options, budget: 3000 });
  await verify({ ...options, root: source });
  await exportDir(join(root, 'output'), { ...options, to: 'claude-code' });
  await consolidate({ ...options, apply: true, minAgeDays: 0 });
  assert.ok(samples.length >= 6);
  const max = Math.max(...samples);
  assert.ok(max < WRITER_TTL_SECONDS * 1000);
  t.diagnostic(`Critical-section measurement: ${samples.length} operations; maximum ${max.toFixed(2)}ms; TTL ${WRITER_TTL_SECONDS}s`);
});

test('unverifiable payloads refuse safely and diagnostics handle unknown ages', async t => {
  const { store, workspace } = await tracker(t);
  failFast(t);
  const path = join(workspace, 'locks', 'memory-writer.lock');
  await mkdir(join(workspace, 'locks'), { recursive: true });
  const valid = { id: 'memory-writer', pid: process.pid, owner: 'legacy', created_at: 'invalid-date', ttl_seconds: 3600 };
  for (const value of ['{broken', 'null', '[]', '{}', JSON.stringify({ ...valid, pid: -1 }), JSON.stringify(valid)]) {
    await writeFile(path, value); await blocked(store);
    assert.equal(await readFile(path, 'utf8'), value);
  }
  await promises.unlink(path); await mkdir(path);
  await assert.rejects(store.write(async () => 1), { code: 'EISDIR' });
});

test('permission-denied owner probes and contended recovery gates cannot reclaim owners', async t => {
  const { store, workspace } = await tracker(t);
  failFast(t);
  const child = await holder(t, workspace);
  const path = join(workspace, 'locks', 'memory-writer.lock');
  const bytes = await readFile(path, 'utf8');
  child.kill('SIGKILL'); await once(child, 'exit');
  const probe = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('probe denied'), { code: 'EPERM' }); });
  await blocked(store); probe.mock.restore();
  assert.equal(await readFile(path, 'utf8'), bytes);
  const gate = `${path}.stale-cleanup`;
  await mkdir(gate); await writeFile(join(gate, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'gate-test' }));
  await blocked(store);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.match(await readFile(join(gate, 'owner.json'), 'utf8'), /gate-test/);
});

test('recovery rechecks replacement ownership under the shared SDK gate', async t => {
  const { store, workspace } = await tracker(t);
  failFast(t);
  const child = await holder(t, workspace);
  const path = join(workspace, 'locks', 'memory-writer.lock');
  const dead = await readFile(path, 'utf8');
  child.kill('SIGKILL'); await once(child, 'exit');
  const original = promises.mkdir;
  for (const outcome of ['live', 'missing', 'denied']) {
    await writeFile(path, dead);
    let injected = false;
    const hook = t.mock.method(promises, 'mkdir', (async (...args: Parameters<typeof original>) => {
      if (args[0] === `${path}.stale-cleanup` && !injected) {
        injected = true;
        if (outcome === 'denied') throw Object.assign(new Error('gate denied'), { code: 'EACCES' });
        if (outcome === 'missing') await promises.unlink(path);
        else await writeFile(path, JSON.stringify({ ...JSON.parse(dead) as Record<string, unknown>, pid: process.pid, host_identity: undefined, process_start_identity: undefined }));
      }
      return original(...args);
    }) as typeof original);
    syncBuiltinESMExports();
    try {
      if (outcome === 'live') await blocked(store);
      else assert.equal(await store.write(async () => 1), 1);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
  }
});

test('native acquisition IO failures retain their SDK error and callback failures release the lock', async t => {
  const { store, workspace } = await tracker(t);
  const original = promises.open;
  const hook = t.mock.method(promises, 'open', (async (...args: Parameters<typeof original>) => {
    if (args[0] === join(workspace, 'locks', 'memory-writer.lock')) throw Object.assign(new Error('open failed'), { code: 'EIO' });
    return original(...args);
  }) as typeof original);
  syncBuiltinESMExports();
  try { await assert.rejects(store.write(async () => 1), /Failed to acquire lock/); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(store.write(async () => { throw new Error('callback failure'); }), /callback failure/);
  assert.equal(await store.write(async () => 2), 2);
});


test('writer wait parsing preserves fail-fast overrides and caps total contention', () => {
  for (const value of ['', '-1', '1.5', 'bad', '999999999999999999999']) assert.equal(writerWaitMs(value), 30000);
  assert.equal(writerWaitMs(' 0 '), 0);
  assert.equal(writerWaitMs('100'), 100);
  assert.equal(writerWaitMs('90000'), 30000);
});
