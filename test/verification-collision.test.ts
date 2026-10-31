import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { remember, verify } from '../index.ts';
import { tracker, clonedTracker } from './helpers.ts';
import { nativeState, sameNativeProof } from '../src/native-revision.ts';
import type { NativeProof } from '../src/native-revision.ts';

test('verification property: timestamp collisions never authorize another semantic or source revision', { timeout: 600000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  let signalRequest: () => void = () => {};
  let release: Promise<void> = Promise.resolve();
  const endpoint = createServer(async (_request, response) => { signalRequest(); await release; response.end('synthetic claim'); });
  await new Promise<void>(resolve => { endpoint.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>(resolve => { endpoint.close(() => resolve()); }));
  const address = endpoint.address(); assert.ok(address && typeof address === 'object');
  const base = await tracker(t);
  const memory = await remember(`Review http://127.0.0.1:${address.port}/claim`, { ...base.options, slug: 'alpha', kind: 'reference' });
  await base.client.schemaAddField('external_payload', { type: 'string', description: 'Opaque independently owned payload' });
  await base.client.schemaAddField('external_context', { type: 'string', description: 'Opaque independently owned context' });
  const mutations: Record<string, unknown>[] = [
    {},
    { memoryChangedAt: '2026-06-02T12:00:00.000Z' },
    { description: 'Native C' }, { memoryKind: 'project' }, { tags: ['native-c'] }, { memoryPinned: true },
    { externalPayload: JSON.stringify({ payload: 'Native C' }) }, { externalContext: JSON.stringify({ context: 'Native C' }) },
    { memoryOriginal: Buffer.from('Native C').toString('base64') },
    { memorySource: 'agents-md:relative-file' }, { memoryPath: 'AGENTS.md' }, { memorySlug: 'native-c' },
    { title: 'Native C' }, { body: 'Native C' }, { memoryWhy: 'Native C' }, { memoryHow: 'Native C' },
    { body: 'Native C before restoring the original body' },
  ];
  // The synthetic HTTP response is deliberately delayed, rather than racing a timer or mocking the SDK.
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  for (const [index, options] of mutations.entries()) {
    await t.test(index === 0 ? 'wall clock only' : index === mutations.length - 1 ? 'same-content ABA' : `field=${Object.keys(options)[0]}`, async () => {
      t.mock.timers.setTime(Date.parse('2026-06-01T12:00:00.000Z'));
      const target = await clonedTracker(t, base);
      let arrive: () => void = () => {}; const requested = new Promise<void>(resolve => { arrive = resolve; });
      signalRequest = arrive;
      let finish: () => void = () => {}; release = new Promise<void>(resolve => { finish = resolve; });
      const before = await nativeState(target.store, memory.id);
      let abaProof: NativeProof | undefined;
      const checking = verify({ ...target.options, root: target.root, network: true });
      await requested;
      try {
        if (index === 0) t.mock.timers.setTime(Date.parse('2026-06-02T12:00:00.000Z'));
        else await target.client.run('update', { id: memory.id, options });
        if (index === mutations.length - 1) {
          await target.client.update(memory.id, { body: before.document!.body });
          const after = await nativeState(target.store, memory.id);
          assert.equal(after.proof.hash, before.proof.hash, 'ABA must return the complete SDK content hash to its saved value');
          abaProof = after.proof;
        }
        const changed = (await target.client.get(memory.id, { full: true })).item;
        assert.equal(changed.updated_at, '2026-06-01T12:00:00.000Z', `case=${index}: force native timestamp collision`);
        if (index !== 1) assert.equal(changed.memory_changed_at, '2026-06-01T12:00:00.000Z', `case=${index}: force content timestamp collision`);
      } finally { finish(); }
      const result = await checking;
      assert.equal(result.checked, index === 0 ? 1 : 0, `case=${index} field=${Object.keys(options)[0]}`);
      if (abaProof !== undefined) assert.equal(sameNativeProof(abaProof, before.proof), false, 'immutable history must still distinguish ABA');
      assert.deepEqual(result.skipped, index === 0 ? [] : ['alpha']);
      assert.equal((await target.client.get(memory.id, { full: true })).item.memory_verdict, index === 0 ? 'verified' : 'unknown');
      if (index === 0) {
        const settled = (await nativeState(target.store, memory.id)).proof;
        assert.equal((await verify({ ...target.options, root: target.root, network: true })).checked, 1);
        assert.deepEqual((await nativeState(target.store, memory.id)).proof, settled, 'an identical SDK no-op retains native history');
      }
    });
  }
  t.diagnostic('VERIFICATION_COLLISIONS=14 SDK_REVISION_REFUSAL=1 ABA_REFUSAL=1 WALL_CLOCK_ONLY_ALLOW=1 real_non_git_trackers=true');
});
