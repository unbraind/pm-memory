import { testDepth } from './support/depth.ts';
import { test } from 'node:test';
import { modelBatches } from './helpers.ts';

test('complete document law: depth-selected seeded raw companion and policy sequences', async t => {
  await modelBatches(t, new URL('./portable-document.worker.ts', import.meta.url), 'DOCUMENT', 25, (start, count) => `DOCUMENT_LAW start=${start} count=${count} MASTER_SEED=325308612`);
  t.diagnostic(`DOCUMENT_LAW sequences=${testDepth(500)}/${testDepth(500)} MASTER_SEED=325308612 wall=concurrent`);
});
