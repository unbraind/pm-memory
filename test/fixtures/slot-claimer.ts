import { workerSlot } from '../helpers.ts';

// Claim and release worker slots without pause until the parent stops this process.
const { signal } = new AbortController();
const parent = process.ppid;

/**
 * Whether the test process that started this claimer still exists.
 *
 * Bun keeps reporting the original `process.ppid` after re-parenting, so the
 * original parent is also probed directly. A hard-killed test run never stops
 * this loop itself, and an orphaned claimer would otherwise spin forever.
 */
function parentAlive(): boolean {
  if (process.ppid !== parent) return false;
  try { process.kill(parent, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

while (parentAlive()) {
  const release = await workerSlot({ signal });
  await release();
}
