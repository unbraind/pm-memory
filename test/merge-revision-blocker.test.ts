import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { remember, consolidate, MemoryError } from '../index.ts';
import { nativeState } from '../src/portable-write.ts';
import { tracker } from './helpers.ts';

test('legacy frozen merge intent must refuse a same-time native body ABA before replay', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T12:00:00.000Z') });
  const target = await tracker(t);
  const source = await remember('Repeated safe guidance', { ...target.options, kind: 'project', slug: 'source' });
  const survivor = await remember('Repeated safe guidance', { ...target.options, kind: 'project', slug: 'target', forceNew: true });
  const initial = (await target.client.get(survivor.id, { full: true })).item;
  await consolidate({ ...target.options, apply: true });
  const entries = await readHistoryEntries(getHistoryPath(target.workspace, source.id), source.id);
  const saved = entries.flatMap(entry => entry.patch).find(patch => patch.path.endsWith('/memory_merge') && 'value' in patch && typeof patch.value === 'string' && patch.value !== '');
  assert.ok(saved && 'value' in saved && typeof saved.value === 'string');
  await target.client.update(source.id, { status: 'open' });
  await target.client.update(survivor.id, { body: String(initial.body) });
  await target.store.fields(source.id, { merge: saved.value });
  const before = await nativeState(target.store, survivor.id);
  await target.client.update(survivor.id, { body: 'Native C after the frozen intent' });
  await target.client.update(survivor.id, { body: String(initial.body) });
  const afterPeer = await nativeState(target.store, survivor.id);
  assert.equal(afterPeer.proof.hash, before.proof.hash, 'return the complete native content hash, including its timestamp, to the saved value');
  assert.equal(afterPeer.proof.length, before.proof.length + 2);
  let failure: unknown;
  try { await consolidate({ ...target.options, apply: true }); } catch (error) { failure = error; }
  t.diagnostic(`LEGACY_MERGE_REPLAY source_status=${(await target.client.get(source.id, { full: true })).item.status} replay_error=${failure !== undefined}`);
  assert.equal((await target.client.get(survivor.id, { full: true })).item.body, initial.body, 'frozen merge replay must retain the native value restored after an intervening edit');
  assert.ok(failure instanceof MemoryError && failure.code === 'conflict', 'an intervening native generation requires an explicit conflict');
  assert.ok(failure.remedy.length > 0);
});
