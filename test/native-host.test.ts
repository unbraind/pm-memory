import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { PmClient, setActiveExtensionHooks } from '@unbrained/pm-cli/sdk';
import { verify, MemoryError } from '../index.ts';
import { commitNativeFields, nativeState } from '../src/native-revision.ts';
import { Store, metadata } from '../src/store.ts';
import { nativeHost, nativePeer, nativeFixture as fixture, hostPublication } from './native-host-helpers.ts';
import { snapshot, clonedTracker, installExtension } from './helpers.ts';

test('host verification honors independent active mutation policy before writing', async t => {
  const target = await fixture(t); const before = await snapshot(target.workspace); let denied = 0;
  await nativeHost(target.workspace, async client => {
    await assert.rejects(verify({ ...target.options, client, root: target.root }), /guard|policy/iu);
  }, context => {
    if (context.operation === 'update') { denied++; return { allow: false, code: 'test_native_policy', remediation: 'Keep original native evidence' }; }
  });
  assert.equal(denied, 1);
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('host publication retains complete-hash ABA protection after the initial revision check', async t => {
  const target = await fixture(t); let ran = false;
  const fields = metadata({ verdict: 'verified', verified_at: '2026-06-01T12:00:00.000Z' });
  Object.defineProperty(fields, 'memoryVerdict', { enumerable: true, get() {
    nativePeer(target, target.saved.proof.version!, target.saved.document!.body); ran = true; return 'verified';
  } });
  assert.equal(await hostPublication(target, target.saved.proof, fields), false);
  const after = await nativeState(target.store, target.id);
  assert.equal(ran, true); assert.equal(after.proof.hash, target.saved.proof.hash);
  assert.ok(after.proof.length > target.saved.proof.length); assert.notEqual(after.proof.history, target.saved.proof.history);
});

for (const mode of ['inactive', 'missing-mutation-guard', 'foreign-tracker', 'foreign-missing-item'] as const) test(`host publication fails closed without an in-process revision guard: ${mode}`, async t => {
  const target = await fixture(t); const before = await snapshot(target.workspace);
  /** Assert a typed refusal and preserve every durable native record. */
  const refuse = async (client: PmClient) => {
    await assert.rejects(verify({ ...target.options, client, root: target.root }), error => error instanceof MemoryError && error.code === 'host_guard');
  };
  if (mode === 'inactive') await refuse(new PmClient({ pmRoot: target.workspace, noExtensions: true }));
  else {
    // A nested SDK call cannot change cwd while the caller's host scope is open.
    const foreign = mode === 'foreign-tracker' ? await clonedTracker(t, target) : mode === 'foreign-missing-item' ? await fixture(t) : undefined;
    await nativeHost(target.workspace, async (client, hooks) => {
      if (foreign === undefined) {
        setActiveExtensionHooks({ ...hooks, beforeMutation: [] });
        await refuse(client);
        return;
      }
      const retained = await snapshot(foreign.workspace);
      await assert.rejects(commitNativeFields(new Store({ ...target.options, client: PmClient.forActiveExtensionHost({ pmRoot: foreign.workspace }) }), target.id, target.saved.proof, metadata({ verdict: 'verified' })), error => error instanceof MemoryError && error.code === 'host_guard');
      assert.deepEqual(await snapshot(foreign.workspace), retained);
    });
  }
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('an active host rejects discovery reads outside the bound tracker', async t => {
  const target = await fixture(t);
  const foreign = await clonedTracker(t, target);
  const before = await snapshot(target.workspace);
  await nativeHost(target.workspace, async (client, hooks) => {
    setActiveExtensionHooks({
      ...hooks,
      onRead: hooks.onRead.map(hook => ({
        ...hook,
        run: context => hook.run({ ...context, path: join(foreign.workspace, 'settings.json') }),
      })),
    });
    await assert.rejects(verify({ ...target.options, client, root: target.root }), { code: 'host_guard' });
  });
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('host publication allows unchanged snapshots and validates SDK no-ops without adding history', { timeout: 60000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  const target = await fixture(t);
  await nativeHost(target.workspace, async client => {
    assert.equal((await verify({ ...target.options, client, root: target.root })).checked, 1);
    const settled = await nativeState(target.store, target.id);
    assert.equal((await verify({ ...target.options, client, root: target.root })).checked, 1);
    assert.deepEqual(await nativeState(target.store, target.id), settled);
  });
});

test('host no-op read-back refuses a colliding native peer after initial validation', async t => {
  const target = await fixture(t);
  const evidence = { verdict: 'verified', verified_at: '2026-06-01T12:00:00.000Z' };
  await target.store.fields(target.id, evidence);
  const saved = await nativeState(target.store, target.id);
  const fields = metadata(evidence); let peer: unknown;
  Object.defineProperty(fields, 'memoryVerdict', { enumerable: true, get() { peer = nativePeer(target, saved.proof.version!); return 'verified'; } });
  assert.equal(await hostPublication(target, saved.proof, fields), false);
  assert.ok(peer); assert.deepEqual((await target.client.get(target.id, { full: true })).item, peer);
});

test('a policy refusal during guard discovery cannot authorize a host write', async t => {
  const target = await fixture(t); const before = await snapshot(target.workspace);
  await nativeHost(target.workspace, async client => {
    await assert.rejects(verify({ ...target.options, client, root: target.root }), error => error instanceof MemoryError && error.code === 'host_guard');
  }, () => ({ allow: false, code: 'test_discovery_denied', remediation: 'Keep original native evidence' }));
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('active host mutation guards require atomic invalidation for memory guidance only', async t => {
  const target = await fixture(t);
  await nativeHost(target.workspace, async client => {
    const task = (await client.create({ title: 'Ordinary host task', type: 'Task' })).item.id;
    await client.update(task, { body: 'Ordinary host mutation' });
    assert.equal((await client.get(task, { full: true })).item.body, 'Ordinary host mutation');
    await target.store.fields(target.id, { changed_at: '2020-01-01T00:00:00.000Z', verdict: 'verified', verified_at: '2020-01-01T00:00:00.000Z', reason: 'Prior evidence' });
    const before = await snapshot(target.workspace);
    const revision = { body: 'Unprepared native guidance edit', memoryChangedAt: '2022-01-01T00:00:00.000Z', memoryVerdict: 'unknown' };
    for (const patch of [
      { body: revision.body, memoryChangedAt: 'invalid time' },
      { ...revision, memoryChangedAt: '2020-01-01T00:00:00.000Z' },
      { ...revision, memoryVerdict: 'verified', unset: ['memory_verified_at', 'memory_reason'] },
      revision,
      { ...revision, unset: ['memory_verified_at'] },
    ]) {
      await assert.rejects(client.run('update', { id: target.id, options: patch }), /must invalidate verification/u);
      assert.deepEqual(await snapshot(target.workspace), before);
    }
  });
});

test('embedded clients keep the discovered host scope alive until publication finishes', async t => {
  const target = await fixture(t); await installExtension(target.workspace);
  const client = new PmClient({ pmRoot: target.workspace });
  assert.equal((await verify({ ...target.options, client, root: target.root })).checked, 1);
  assert.equal((await target.client.get(target.id, { full: true })).item.memory_verdict, 'unknown');
});

test('an inactive host guard refuses before repairing missing persistent schema fields', async t => {
  const target = await fixture(t);
  await target.client.schemaRemoveField('memory_consent');
  const before = await snapshot(target.workspace);
  const client = new PmClient({ pmRoot: target.workspace, noExtensions: true });
  await assert.rejects(verify({ ...target.options, client, root: target.root }), error => error instanceof MemoryError && error.code === 'host_guard');
  assert.deepEqual(await snapshot(target.workspace), before);
  await nativeHost(target.workspace, async active => {
    assert.equal((await verify({ ...target.options, client: active, root: target.root })).checked, 1);
  });
  assert.equal((await target.client.schemaListFields()).fields.some(field => field.key === 'memory_consent'), false, 'active host fields need no persistent schema repair');
});
