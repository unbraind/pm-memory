import { testDepth } from './support/depth.ts';
import { test } from 'node:test';
import { modelBatches } from './helpers.ts';

const SEED = 0x13631d07;
test('legacy fidelity and immutable identity: depth-selected independent SDK-read sequences', async t => {
  await modelBatches(t, new URL('./portable-fidelity.worker.ts', import.meta.url), 'FIDELITY', 25, (start, count) => `FIDELITY start=${start} count=${count} MASTER_SEED=${SEED}`);
  t.diagnostic(`FIDELITY sequences=${testDepth(500)} MASTER_SEED=${SEED} batches=${testDepth(500) / 25} wall=concurrent`);
});
