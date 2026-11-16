import { basename } from 'node:path';
import { Worker } from 'node:worker_threads';
import { testTime } from './time.ts';

// --test-timeout does not stop a file with live handles after its final test.
// A separate thread also enforces the deadline if the file's JS loop blocks.
// Unref lets healthy files exit naturally; only an expired file is killed.
if (process.env.NODE_TEST_CONTEXT !== undefined) {
  const configured = Number(process.env.PM_TEST_FILE_TIMEOUT_MS);
  const deadline = Number.isFinite(configured) && configured > 0
    ? configured : testTime(process.env.PM_TEST_DEPTH === 'quick' ? 600_000 : 1_800_000);
  const watchdog = new Worker(`
    const { workerData } = require('node:worker_threads');
    const { writeSync } = require('node:fs');
    setTimeout(() => {
      writeSync(2, 'Test file deadline exceeded: ' + workerData.file + ' (' + workerData.deadline + 'ms)\\n');
      process.kill(process.pid, 'SIGKILL');
    }, workerData.deadline);
  `, {
    eval: true,
    // Do not recursively load the parent's --import in this watchdog thread.
    execArgv: [],
    workerData: { file: basename(process.argv[1] ?? 'test'), deadline },
  });
  watchdog.unref();
}
