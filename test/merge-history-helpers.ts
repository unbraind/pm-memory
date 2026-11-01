import assert from 'node:assert/strict';
import { consolidate, remember } from '../index.ts';
import { nativeHost } from './native-host-helpers.ts';
import { tracker } from './helpers.ts';

/** Interrupt a genuine SDK host write after its durable forward merge intent. */
export async function interrupted(t: Parameters<typeof tracker>[0], boundary: 'publish' | 'cancel' | 'finish') {
  const target = await tracker(t);
  const source = await remember('Repeated safe guidance', { ...target.options, kind: 'project', slug: 'source' });
  const destination = await remember('Repeated safe guidance', { ...target.options, kind: 'project', slug: 'target', forceNew: true });
  let denied = 0;
  await nativeHost(target.workspace, async client => {
    await assert.rejects(consolidate({ ...target.options, client, apply: true }), /policy|guard/iu);
  }, context => {
    const before = context.before?.metadata; const after = context.after?.metadata;
    const match = boundary === 'publish' ? after?.id === destination.id && context.after!.body.includes('### Consolidated context') : after?.id === source.id && (boundary === 'cancel' ? before?.status !== 'canceled' && after.status === 'canceled' : before?.memory_merge !== '' && after.memory_merge === '');
    if (match) { denied++; return { allow: false, code: 'test_merge_interrupted', remediation: 'Resume the durable forward merge' }; }
  });
  assert.equal(denied, 1);
  assert.notEqual((await target.client.get(source.id, { full: true })).item.memory_merge, '');
  return { ...target, source, destination };
}
