import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runModelWorker } from './helpers.ts';

const MASTER_SEED = 0x1363cafe;
const SEQUENCES = 500;
const BATCH_SIZE = 5;

// Fresh real Node processes bound Node 22 coverage bookkeeping. Workers inherit
// NODE_V8_COVERAGE, so c8 still measures every production path in every batch.
test('model: 500 seeded stateful sequences preserve old replays, SDK-normalized provenance and relationships', { timeout: 14400000 }, async t => {
  let total = 0; let checks = 0;
  for (let start = 0; start < SEQUENCES; start += BATCH_SIZE) {
    const freshIndex = start / BATCH_SIZE;
    const batchChecks = BATCH_SIZE * 45 + 4 + (freshIndex % 31 >= 9 && freshIndex % 2 === 0 ? 1 : 0);
    await t.test(`sequences ${start}-${start + BATCH_SIZE - 1}`, async batch => {
      await runModelWorker(batch, new URL('./portable-model.worker.ts', import.meta.url), { PM_MEMORY_MODEL_START: String(start), PM_MEMORY_MODEL_COUNT: String(BATCH_SIZE) }, `MODEL_BATCH start=${start} count=${BATCH_SIZE} SDK-read steps=${batchChecks} MASTER_SEED=0x${MASTER_SEED.toString(16)}`);
      total += BATCH_SIZE; checks += batchChecks;
    });
    // A cancelled/failed child must never be counted as a completed sequence.
    assert.equal(total, start + BATCH_SIZE);
    t.diagnostic(`MASTER_SEED=0x${MASTER_SEED.toString(16)} sequences=${total}/${SEQUENCES} SDK-read steps=${checks}`);
  }
  assert.equal(total, SEQUENCES);
  assert.equal(checks, 22933);
});
