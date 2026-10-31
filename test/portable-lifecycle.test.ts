import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readSettings, resolveTransactionSchema, resolveRuntimeStatusRegistry, getHistoryPath, readHistoryEntries } from '@unbrained/pm-cli/sdk';
import { remember, renew, get, recall, exportDir, importDir, MemoryError } from '../index.ts';
import { tracker } from './helpers.ts';

test('SDK custom cancellation stays native across selectors exports renewal and forward retry', async t => {
  const target = await tracker(t); const alpha = await remember('Alpha inactive guidance', { ...target.options, slug: 'alpha', kind: 'reference' });
  const path = join(target.root, 'initial'); await exportDir(path, { ...target.options, to: 'agents-md' });
  await target.client.schemaRemapStatus('canceled', 'discarded', {});
  const schema = await resolveTransactionSchema(target.workspace, await readSettings(target.workspace)); const canceled = resolveRuntimeStatusRegistry(schema.schema).canceled_status;
  assert.equal(canceled, 'discarded'); await target.client.update(alpha.id, { status: canceled, closeReason: 'Explicit native cancellation' });
  assert.equal((await target.store.read())[0].canceled, true);
  await assert.rejects(get('alpha', target.options), error => error instanceof MemoryError && error.code === 'missing');
  assert.equal((await recall('Alpha', target.options)).memories!.length, 0);
  assert.equal((await exportDir(join(target.root, 'inactive'), { ...target.options, to: 'agents-md' })).exported, 2);
  await assert.rejects(renew('alpha', { ...target.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Inactive native guidance' }), MemoryError);
  await importDir(path, { ...target.options, from: 'agents-md' });
  const current = (await target.client.get(alpha.id, { full: true })).item; assert.equal(current.status, canceled); assert.equal(current.close_reason, 'Explicit native cancellation');
  assert.equal((await target.client.listAllComplete()).items.length, 1); assert.equal((await readHistoryEntries(getHistoryPath(target.workspace, alpha.id), alpha.id)).filter(row => row.op === 'create').length, 1);
});
