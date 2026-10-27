import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorker } from './helpers.ts';

const SEED = 0x13631d07;
test('legacy fidelity and immutable identity: 500 independent SDK-read sequences', { timeout: 14400000 }, async t => {
  let completed = 0;
  for (let start = 0; start < 500; start += 25) {
    await runModelWorker(t, new URL('./portable-fidelity.worker.ts', import.meta.url), { PM_MEMORY_FIDELITY_START: String(start), PM_MEMORY_FIDELITY_COUNT: '25' }, `FIDELITY start=${start} count=25 MASTER_SEED=${SEED}`);
    completed += 25;
  }
  assert.equal(completed, 500); t.diagnostic(`FIDELITY sequences=${completed} MASTER_SEED=${SEED}`);
});
