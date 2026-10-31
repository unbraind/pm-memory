import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorker } from './helpers.ts';

test('complete document law: 500 seeded raw companion and policy sequences', { timeout: 14400000 }, async t => {
  let completed = 0;
  for (let start = 0; start < 500; start += 25) {
    await runModelWorker(t, new URL('./portable-document.worker.ts', import.meta.url), { PM_MEMORY_DOCUMENT_START: String(start), PM_MEMORY_DOCUMENT_COUNT: '25' }, `DOCUMENT_LAW start=${start} count=25 MASTER_SEED=325308612`);
    completed += 25;
  }
  assert.equal(completed, 500); t.diagnostic(`DOCUMENT_LAW sequences=${completed}/500 MASTER_SEED=325308612`);
});
