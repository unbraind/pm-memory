import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorker } from './helpers.ts';

for (const [index, law] of ['identity', 'locality', 'foreign'].entries()) {
  test(`ownership law ${law}: 500 independent SDK-read sequences`, { timeout: 14400000 }, async t => {
    let completed = 0; const master = (0x1363b0a1 + index * 0x1020304) >>> 0;
    for (let start = 0; start < 500; start += 25) {
      await runModelWorker(t, new URL('./portable-laws.worker.ts', import.meta.url), { PM_MEMORY_LAW: law, PM_MEMORY_LAW_START: String(start), PM_MEMORY_LAW_COUNT: '25' }, `OWNERSHIP_LAW law=${law} start=${start} count=25 MASTER_SEED=${master}`);
      completed += 25;
    }
    assert.equal(completed, 500); t.diagnostic(`OWNERSHIP_LAW ${law} sequences=${completed}/500 MASTER_SEED=${master}`);
  });
}
