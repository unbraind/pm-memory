import { test } from 'node:test';
import { modelBatches } from './helpers.ts';

const SEED = 0x13631d07;
test('legacy fidelity and immutable identity: 500 independent SDK-read sequences', { timeout: 14400000 }, async t => {
  await modelBatches(t, new URL('./portable-fidelity.worker.ts', import.meta.url), 'FIDELITY', 25, (start, count) => `FIDELITY start=${start} count=${count} MASTER_SEED=${SEED}`);
  t.diagnostic(`FIDELITY sequences=500 MASTER_SEED=${SEED} batches=20 wall=concurrent`);
});
