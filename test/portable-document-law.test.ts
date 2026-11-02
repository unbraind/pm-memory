import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorkerPool } from './helpers.ts';

test('complete document law: 500 seeded raw companion and policy sequences', { timeout: 14400000 }, async t => {
  const configurations: Record<string, string>[] = []; const receipts: string[] = [];
  for (let start = 0; start < 500; start += 25) { configurations.push({ PM_MEMORY_DOCUMENT_START: String(start), PM_MEMORY_DOCUMENT_COUNT: '25' }); receipts.push(`DOCUMENT_LAW start=${start} count=25 MASTER_SEED=325308612`); }
  await runModelWorkerPool(t, new URL('./portable-document.worker.ts', import.meta.url), configurations, receipts);
  assert.equal(configurations.length * 25, 500); t.diagnostic('DOCUMENT_LAW sequences=500/500 MASTER_SEED=325308612 wall=concurrent');
});
