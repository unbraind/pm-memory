import { test } from 'node:test';
import { modelBatches } from './helpers.ts';

test('complete document law: 500 seeded raw companion and policy sequences', { timeout: 14400000 }, async t => {
  await modelBatches(t, new URL('./portable-document.worker.ts', import.meta.url), 'DOCUMENT', 25, (start, count) => `DOCUMENT_LAW start=${start} count=${count} MASTER_SEED=325308612`);
  t.diagnostic('DOCUMENT_LAW sequences=500/500 MASTER_SEED=325308612 wall=concurrent');
});
