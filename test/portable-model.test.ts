import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorkerPool } from './helpers.ts';

const MASTER_SEED = 0x1363cafe;
const SEQUENCES = 500;
const BATCH_SIZE = 5;

// Fresh real Node processes bound Node 22 coverage bookkeeping, now running their
// independent batches concurrently through one bounded pool. Workers inherit
// NODE_V8_COVERAGE, so c8 still measures every production path in every batch.
test('model: 500 seeded stateful sequences preserve old replays, SDK-normalized provenance and relationships', { timeout: 14400000 }, async t => {
  const configurations: Record<string, string>[] = []; const receipts: string[] = []; let checks = 0;
  for (let start = 0; start < SEQUENCES; start += BATCH_SIZE) {
    const freshIndex = start / BATCH_SIZE;
    const batchChecks = BATCH_SIZE * 45 + 4 + (freshIndex % 31 >= 9 && freshIndex % 2 === 0 ? 1 : 0);
    checks += batchChecks;
    configurations.push({ PM_MEMORY_MODEL_START: String(start), PM_MEMORY_MODEL_COUNT: String(BATCH_SIZE) });
    receipts.push(`MODEL_BATCH start=${start} count=${BATCH_SIZE} SDK-read steps=${batchChecks} MASTER_SEED=0x${MASTER_SEED.toString(16)}`);
  }
  await runModelWorkerPool(t, new URL('./portable-model.worker.ts', import.meta.url), configurations, receipts);
  assert.equal(configurations.length * BATCH_SIZE, SEQUENCES);
  assert.equal(checks, 22933);
  t.diagnostic(`MODEL sequences=${SEQUENCES} SDK-read steps=${checks} MASTER_SEED=0x${MASTER_SEED.toString(16)} batches=${configurations.length} wall=concurrent`);
});
