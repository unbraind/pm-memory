import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { ownerIsGone, runModelWorker, runModelWorkerPool } from './helpers.ts';

/** Independently observe real child overlap and require all child-owned temporary directories gone. */
async function evidence(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'worker-budget-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
/** A child deliberately leaves its fixture behind; the parent must own final cleanup. */
async function assertCleaned(root: string) {
  for (const path of (await readFile(join(root, 'scratch.txt'), 'utf8')).trim().split('\n')) {
    await assert.rejects(access(path), { code: 'ENOENT' });
  }
}
test('worker pools share at most four available cores and remove child temp directories', async t => {
  const root = await evidence(t); const variables = { MEMORY_BUDGET_EVIDENCE: root };
  const configurations = Array.from({ length: 4 }, () => variables);
  const receipts = configurations.map(() => 'WORKER_BUDGET completed');
  const worker = new URL('./fixtures/worker-budget.worker.ts', import.meta.url);
  await Promise.all([runModelWorkerPool(t, worker, configurations, receipts), runModelWorkerPool(t, worker, configurations, receipts)]);
  const counts = (await readFile(join(root, 'counts.txt'), 'utf8')).trim().split('\n').map(Number);
  assert.equal(counts.length, 8);
  assert.ok(Math.max(...counts) <= Math.min(4, availableParallelism()), String(counts));
  await assertCleaned(root);
});
test('a failed worker still removes every child temporary directory', async t => {
  const root = await evidence(t);
  await assert.rejects(runModelWorker(t, new URL('./fixtures/worker-budget.worker.ts', import.meta.url), { MEMORY_BUDGET_EVIDENCE: root, MEMORY_BUDGET_FAIL: '1' }, 'unused'), /Expected worker failure/);
  await assertCleaned(root);
});
test('one failed batch stops every pool lane from claiming further batches', async t => {
  const root = await evidence(t);
  const worker = new URL('./fixtures/worker-budget.worker.ts', import.meta.url);
  const configurations = Array.from({ length: 12 }, (_, index) => ({ MEMORY_BUDGET_EVIDENCE: root, ...(index === 0 ? { MEMORY_BUDGET_FAIL: '1' } : {}) }));
  await assert.rejects(runModelWorkerPool(t, worker, configurations, configurations.map(() => 'WORKER_BUDGET completed')), /pooled worker batch\(es\) failed/);
  const started = (await readFile(join(root, 'scratch.txt'), 'utf8')).trim().split('\n').length;
  // Lanes already running finish their batch; nobody claims a new one after the failure.
  assert.ok(started < configurations.length, `${started} of ${configurations.length} batches started after the first failure`);
  await assertCleaned(root);
});
test('a slot is reclaimable only when its recorded owner process is gone', async t => {
  const root = await evidence(t);
  const exited = spawnSync(process.execPath, ['-e', '']).pid!;
  const cases: [string, boolean][] = [[String(exited), true], [String(process.pid), false], ['', false], ['not-a-pid', false]];
  for (const [owner, gone] of cases) {
    const file = join(root, `slot-${owner || 'empty'}`); await writeFile(file, owner);
    assert.equal(await ownerIsGone(file), gone, owner || 'empty');
  }
  assert.equal(await ownerIsGone(join(root, 'missing')), false);
});
