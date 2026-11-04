import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
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
test('a claimed slot is never visible without its owner PID', { skip: process.platform === 'win32' ? 'SIGSTOP is POSIX-only' : false }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'worker-budget-test-'));
  // The claimer's parent is this process, so its slots live in a directory named after this PID.
  const directory = join(root, `memory-worker-slots-${process.pid}`);
  const claimer = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/slot-claimer.ts', import.meta.url))], { env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, stdio: 'ignore' });
  const exited = new Promise(resolve => { claimer.once('exit', resolve); });
  // Stop the claimer before removing its directory, or it recreates files there.
  t.after(async () => { claimer.kill('SIGKILL'); await exited; await rm(root, { recursive: true, force: true }); });
  const owner = String(claimer.pid);
  // The claimer loads the whole helper module first; freeze only once it is claiming.
  for (let waited = 0; claimer.exitCode === null && (await readdir(directory).catch(() => [])).length === 0; waited += 25) {
    assert.ok(waited < 60_000, 'the claimer never claimed a slot');
    await delay(25);
  }
  // Freezing the claimer at arbitrary moments leaves the files exactly as a hard kill would.
  let observed = 0; const ownerless: string[] = [];
  for (let freeze = 0; freeze < 600 && claimer.exitCode === null; freeze++) {
    await delay(Math.random() * 2);
    claimer.kill('SIGSTOP');
    try {
      for (const name of await readdir(directory).catch(() => [])) {
        if (!/^\d+$/.test(name)) continue;
        const recorded = await readFile(join(directory, name), 'utf8').catch(() => null);
        if (recorded === null) continue;
        observed++;
        if (recorded !== owner) ownerless.push(JSON.stringify(recorded));
      }
    } finally { claimer.kill('SIGCONT'); }
  }
  assert.equal(claimer.exitCode, null, 'the claimer must still be running');
  assert.ok(observed >= 100, `only ${observed} claimed slots were observed`);
  assert.deepEqual(ownerless, [], 'a published slot must already record its owner');
});

/** Whether a process still runs: it exists and, where procfs shows it, is not a zombie awaiting its reaper. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
}
test('an orphaned slot claimer exits once its parent process is gone', { skip: process.platform === 'win32' ? 'POSIX process probes only' : false }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'worker-budget-test-'));
  const fixture = fileURLToPath(new URL('./fixtures/slot-claimer.ts', import.meta.url));
  // An intermediate parent starts the claimer, reports its PID and is then killed without any cleanup.
  const launcher = `const { spawn } = require('node:child_process'); const claimer = spawn(process.execPath, [${JSON.stringify(fixture)}], { stdio: 'ignore' }); console.log(claimer.pid); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['-e', launcher], { env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, stdio: ['ignore', 'pipe', 'ignore'] });
  const parentExited = new Promise(resolve => { parent.once('exit', resolve); });
  let claimer = 0;
  t.after(async () => {
    parent.kill('SIGKILL'); await parentExited;
    if (claimer > 0) {
      if (running(claimer)) process.kill(claimer, 'SIGKILL');
      for (let waited = 0; running(claimer) && waited < 5000; waited += 25) await delay(25);
    }
    await rm(root, { recursive: true, force: true });
  });
  claimer = await new Promise<number>((resolve, reject) => {
    let output = '';
    parent.stdout.on('data', chunk => { output += String(chunk); const reported = /^(\d+)\n/.exec(output); if (reported) resolve(Number(reported[1])); });
    parent.once('exit', () => { reject(new Error('the launcher exited before reporting the claimer')); });
  });
  const directory = join(root, `memory-worker-slots-${parent.pid}`);
  for (let waited = 0; (await readdir(directory).catch(() => [])).length === 0; waited += 25) {
    assert.ok(waited < 60_000 && running(claimer), 'the claimer never claimed a slot');
    await delay(25);
  }
  parent.kill('SIGKILL'); await parentExited;
  for (let waited = 0; running(claimer) && waited < 15_000; waited += 25) await delay(25);
  assert.equal(running(claimer), false, 'an orphaned claimer must stop instead of spinning');
});
