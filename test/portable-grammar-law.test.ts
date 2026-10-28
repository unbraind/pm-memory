import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorker } from './helpers.ts';

test('current grammar law: 500 SDK-modeled envelope transitions across import adapters', { timeout: 14400000 }, async t => {
  let completed = 0;
  for (let start = 0; start < 500; start += 25) {
    await runModelWorker(t, new URL('./portable-grammar.worker.ts', import.meta.url), { PM_MEMORY_GRAMMAR_START: String(start), PM_MEMORY_GRAMMAR_COUNT: '25' }, `GRAMMAR_LAW start=${start} count=25 MASTER_SEED=325316613`);
    completed += 25;
  }
  assert.equal(completed, 500); t.diagnostic('GRAMMAR_LAW sequences=500/500 MASTER_SEED=325316613');
});
