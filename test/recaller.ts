import { recall } from '../src/memory.ts';
/** Signal readiness before concurrent parent release; use independent SDK clients per call. */
process.send!('ready');
process.once('message', async () => {
  for (let n = 0; n < 3; n++) await recall('counter', { workspace: process.argv[2], author: 'memory-process' });
  process.disconnect!();
});
