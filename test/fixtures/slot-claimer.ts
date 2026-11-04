import { workerSlot } from '../helpers.ts';

// Claim and release worker slots without pause until the parent stops this process.
const { signal } = new AbortController();
for (;;) {
  const release = await workerSlot({ signal });
  await release();
}
