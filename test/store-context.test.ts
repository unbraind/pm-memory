import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import { Store } from '../src/store.ts';
import { tracker, withoutGit } from './helpers.ts';

test('repeated Store writers keep a bounded set of asynchronous context engines', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const engines = new Set<AsyncLocalStorage<unknown>>();
  const original = AsyncLocalStorage.prototype.run;
  t.mock.method(AsyncLocalStorage.prototype, 'run', function (this: AsyncLocalStorage<unknown>, ...args: unknown[]) {
    // Count engines invoked directly by Store, excluding SDK-owned contexts.
    const caller = new Error().stack!.split('\n').find(line => /^\s+at /.test(line) && !line.includes('store-context.test.ts') && !line.includes('node:')) ?? '';
    if (/[\\/]src[\\/]store\.ts:/.test(caller)) engines.add(this);
    return Reflect.apply(original, this, args);
  });
  const write = async () => {
    const store = new Store(target.options);
    await store.write(() => store.fence(async () => {}));
  };
  await write(); const warmed = engines.size; assert.ok(warmed > 0);
  for (let at = 0; at < 25; at++) await write();
  assert.equal(engines.size, warmed, 'completed Store instances must not accumulate enabled context engines');
});

test('nested Store scopes retain independent leases and restore the outer fence', async t => {
  const first = await tracker(t); const second = await tracker(t); withoutGit(t, first.root);
  const a = first.store; const b = second.store;
  await a.write(async () => {
    const leaseA = a.leases.getStore(); assert.ok(leaseA);
    assert.equal(b.leases.getStore(), undefined);
    await b.fence(async () => { assert.equal(b.fences.getStore(), undefined); });
    await a.fence(async () => {
      const fenceA = a.fences.getStore(); assert.ok(fenceA);
      await b.write(async () => {
        const leaseB = b.leases.getStore(); assert.ok(leaseB); assert.notEqual(leaseB, leaseA);
        assert.equal(a.leases.getStore(), leaseA); assert.equal(a.fences.getStore(), fenceA);
        await b.fence(async () => {
          assert.equal(b.fences.getStore()!.lease, leaseB);
          await a.fence(async () => { assert.equal(a.fences.getStore(), fenceA); });
        });
        assert.equal(b.fences.getStore(), undefined);
      });
      assert.equal(b.leases.getStore(), undefined); assert.equal(a.fences.getStore(), fenceA);
    });
    assert.equal(a.fences.getStore(), undefined); assert.equal(a.leases.getStore(), leaseA);
  });
  assert.equal(a.leases.getStore(), undefined); assert.equal(b.leases.getStore(), undefined);
});
