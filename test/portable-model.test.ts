import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { testEnvironment } from '../scripts/environment.ts';

const MASTER_SEED = 0x1363cafe;
const SEQUENCES = 500;
const BATCH_SIZE = 10;

// Fresh real Node processes bound Node 22 coverage bookkeeping. Workers inherit
// NODE_V8_COVERAGE, so c8 still measures every production path in every batch.
test('model: 500 seeded stateful sequences preserve old replays, SDK-normalized provenance and relationships', { timeout: 5400000 }, async t => {
  let total = 0;
  for (let start = 0; start < SEQUENCES; start += BATCH_SIZE) {
    await t.test(`sequences ${start}-${start + BATCH_SIZE - 1}`, async batch => {
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./portable-model.worker.ts', import.meta.url))], {
        env: { ...testEnvironment(process.env), PM_MEMORY_MODEL_START: String(start), PM_MEMORY_MODEL_COUNT: String(BATCH_SIZE) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      batch.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, `MASTER_SEED=${MASTER_SEED} start=${start}\n${stdout}\n${stderr}`);
      assert.ok(stdout.includes(`MODEL_BATCH start=${start} count=${BATCH_SIZE} SDK-read steps=${BATCH_SIZE * 15} MASTER_SEED=0x${MASTER_SEED.toString(16)}`), `Missing complete SDK-verified batch receipt: ${stdout}`);
      total += BATCH_SIZE;
    });
    // A cancelled/failed child must never be counted as a completed sequence.
    assert.equal(total, start + BATCH_SIZE);
    t.diagnostic(`MASTER_SEED=0x${MASTER_SEED.toString(16)} sequences=${total}/${SEQUENCES} SDK-read steps=${total * 15}`);
  }
  assert.equal(total, SEQUENCES);
});
