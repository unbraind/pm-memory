import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorkerPool } from './helpers.ts';

test('current grammar law: 500 SDK-modeled envelope transitions across import adapters', { timeout: 14400000 }, async t => {
  const configurations: Record<string, string>[] = []; const receipts: string[] = [];
  for (let start = 0; start < 500; start += 25) { configurations.push({ PM_MEMORY_GRAMMAR_START: String(start), PM_MEMORY_GRAMMAR_COUNT: '25' }); receipts.push(`GRAMMAR_LAW start=${start} count=25 MASTER_SEED=325316613`); }
  await runModelWorkerPool(t, new URL('./portable-grammar.worker.ts', import.meta.url), configurations, receipts);
  assert.equal(configurations.length * 25, 500); t.diagnostic('GRAMMAR_LAW sequences=500/500 MASTER_SEED=325316613 wall=concurrent');
});
