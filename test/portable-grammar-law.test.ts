import { test } from 'node:test';
import { modelBatches } from './helpers.ts';

test('current grammar law: 500 SDK-modeled envelope transitions across import adapters', { timeout: 14400000 }, async t => {
  await modelBatches(t, new URL('./portable-grammar.worker.ts', import.meta.url), 'GRAMMAR', 25, (start, count) => `GRAMMAR_LAW start=${start} count=${count} MASTER_SEED=325316613`);
  t.diagnostic('GRAMMAR_LAW sequences=500/500 MASTER_SEED=325316613 wall=concurrent');
});
