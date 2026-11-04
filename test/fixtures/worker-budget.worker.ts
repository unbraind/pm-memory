import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.MEMORY_BUDGET_EVIDENCE!;
const scratch = await mkdtemp(join(tmpdir(), 'worker-cleanup-'));
await appendFile(join(root, 'scratch.txt'), scratch + '\n');
if (process.env.MEMORY_BUDGET_FAIL === '1') throw new Error('Expected worker failure');
const active = join(root, 'active'); await mkdir(active, { recursive: true });
const token = join(active, randomUUID()); await writeFile(token, 'owned');
try {
  await appendFile(join(root, 'counts.txt'), String((await readdir(active)).length) + '\n');
  await delay(200);
  console.log('WORKER_BUDGET completed');
} finally { await rm(token); }
