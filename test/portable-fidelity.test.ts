import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorkerPool } from './helpers.ts';

const SEED = 0x13631d07;
test('legacy fidelity and immutable identity: 500 independent SDK-read sequences', { timeout: 14400000 }, async t => {
  const configurations: Record<string, string>[] = []; const receipts: string[] = [];
  for (let start = 0; start < 500; start += 25) { configurations.push({ PM_MEMORY_FIDELITY_START: String(start), PM_MEMORY_FIDELITY_COUNT: '25' }); receipts.push(`FIDELITY start=${start} count=25 MASTER_SEED=${SEED}`); }
  await runModelWorkerPool(t, new URL('./portable-fidelity.worker.ts', import.meta.url), configurations, receipts);
  assert.equal(configurations.length * 25, 500); t.diagnostic(`FIDELITY sequences=500 MASTER_SEED=${SEED} batches=${configurations.length} wall=concurrent`);
});
