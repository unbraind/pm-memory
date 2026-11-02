import assert from 'node:assert/strict';
import { consolidate, remember } from '../index.ts';
import { nativeHost } from './native-host-helpers.ts';
import type { BeforeMutationHook } from '@unbrained/pm-cli/sdk/authoring';
import { tracker } from './helpers.ts';

/** Prepare one real source/target pair for independent merge interruption schedules. */
export async function mergePair(t: Parameters<typeof tracker>[0]) {
  const target = await tracker(t);
  const source = await remember('Repeated safe guidance', { ...target.options, kind: 'project', slug: 'source', why: 'Unique retained rationale', how: 'Unique retained application' });
  const destination = await remember('Repeated safe guidance', { ...target.options, kind: 'project', slug: 'target', forceNew: true });
  return { ...target, source, destination };
}
/** Require the real host to refuse the injected merge transition with the exact expected category. */
export async function refuseMerge(target: Awaited<ReturnType<typeof tracker>>, policy: Parameters<typeof nativeHost>[2], expected: RegExp | ((error: unknown) => boolean) = /policy|guard/iu) {
  await nativeHost(target.workspace, async client => {
    await assert.rejects(consolidate({ ...target.options, client, apply: true }), expected);
  }, policy);
}
/** Identify the actual SDK transition by its documents, never by callback count. */
export function atMergeBoundary(context: Parameters<BeforeMutationHook>[0], pair: Pick<Awaited<ReturnType<typeof mergePair>>, 'source' | 'destination'>, boundary: 'publish' | 'cancel' | 'finish'): boolean {
  const before = context.before?.metadata; const after = context.after?.metadata;
  if (boundary === 'publish') return after?.id === pair.destination.id && context.after!.body.includes('### Consolidated context');
  return after?.id === pair.source.id && (boundary === 'cancel' ? before?.status !== 'canceled' && after.status === 'canceled' : before?.memory_merge !== '' && after.memory_merge === '');
}
/** Interrupt a genuine SDK host write after its durable forward merge intent. */
export async function interrupted(t: Parameters<typeof tracker>[0], boundary: 'publish' | 'cancel' | 'finish') {
  const target = await mergePair(t); const { source, destination } = target;
  let denied = 0;
  await refuseMerge(target, context => {
    const match = atMergeBoundary(context, target, boundary);
    if (match) { denied++; return { allow: false, code: 'test_merge_interrupted', remediation: 'Resume the durable forward merge' }; }
  });
  assert.equal(denied, 1);
  assert.notEqual((await target.client.get(source.id, { full: true })).item.memory_merge, '');
  return { ...target, source, destination };
}
