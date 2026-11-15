import { testDepth } from './support/depth.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorkerPool } from './helpers.ts';

for (const [index, law] of ['identity', 'locality', 'foreign'].entries()) {
  test(`ownership law ${law}: depth-selected SDK-read sequences in concurrent 25-sequence batches`, async t => {
    const master = (0x1363b0a1 + index * 0x1020304) >>> 0;
    const configurations: Record<string, string>[] = []; const receipts: string[] = [];
    for (let start = 0; start < testDepth(500); start += 25) { configurations.push({ PM_MEMORY_LAW: law, PM_MEMORY_LAW_START: String(start), PM_MEMORY_LAW_COUNT: '25' }); receipts.push(`OWNERSHIP_LAW law=${law} start=${start} count=25 MASTER_SEED=${master}`); }
    await runModelWorkerPool(t, new URL('./portable-laws.worker.ts', import.meta.url), configurations, receipts, law);
    assert.equal(configurations.length * 25, testDepth(500)); t.diagnostic(`OWNERSHIP_LAW ${law} sequences=${testDepth(500)} MASTER_SEED=${master} wall=concurrent`);
  });
}
