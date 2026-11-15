import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { testEnvironment } from '../scripts/environment.ts';
import { ownFixtureChild, tracker } from './helpers.ts';
import { testDepth } from './support/depth.ts';
import { testTime } from './support/time.ts';

// The child is intentionally idle after a green test. --test-timeout alone
// leaves it alive forever; the file watchdog must turn that into a failure.
for (const [mode, script, started] of [
  ['idle handle', "test('done', () => {}); setInterval(() => {}, 1000);", /done/],
  ['blocked event loop', "test('busy', () => { writeSync(2, 'entered busy loop\\n'); while (true) {} });", /entered busy loop/],
]) test(`file watchdog rejects ${mode}`, async t => {
  const { root } = await tracker(t); const file = join(root, 'stuck.test.ts');
  await writeFile(file, "import { test } from 'node:test'; import { writeSync } from 'node:fs'; " + script + '\n');
  const result = spawnSync(process.execPath, ['--import', resolve('test/support/file-deadline.ts'), '--test', '--test-reporter=spec', file], {
    encoding: 'utf8', timeout: 30_000, env: { ...testEnvironment(process.env), PM_TEST_FILE_TIMEOUT_MS: '500' },
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, started as RegExp);
  assert.match(result.stdout + result.stderr, /Test file deadline exceeded: stuck.test.ts/);
});

test('CLI fixtures suppress detached telemetry writers even with replacement environments', async t => {
  const { root, workspace } = await tracker(t);
  const probe = join(root, 'spawn-probe.mjs'); const marker = join(root, 'detached-writer');
  // Observe the pinned CLI dispatcher at the OS-process boundary, without
  // launching a flusher or contacting its endpoint. Old fixture isolation
  // schedules this writer after the CLI command has finished its work.
  await writeFile(probe, `import cp from 'node:child_process'; import { appendFileSync } from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawn;
cp.spawn = function (file, args, options) { if (args?.some(arg => String(arg).includes('telemetry-flush'))) { appendFileSync(${JSON.stringify(marker)}, 'spawned'); throw new Error('Controlled detached writer'); } return original.call(this, file, args, options); }; syncBuiltinESMExports();`);
  const base = { PATH: process.env.PATH, HOME: root, PM_GLOBAL_PATH: join(root, '.pm-cli'), PM_PATH: workspace, PM_AUTHOR: 'memory-test', PM_TELEMETRY_SOURCE_CONTEXT: 'automation' };
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--import', probe, resolve('node_modules/.bin/pm'), 'list', '--limit', '1'], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  const isolated = run(testEnvironment(base));
  assert.equal(isolated.error, undefined); assert.equal(isolated.status, 0, isolated.stderr);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  // Positive control proves that this exact CLI/settings combination would
  // dispatch a detached writer if the replacement env lost suppression.
  const original = run(base);
  assert.equal(original.error, undefined); assert.equal(original.status, 0, original.stderr);
  assert.match(await readFile(marker, 'utf8'), /^(spawned)+$/);
});

test('depth keeps full default and deterministic quick budgets; slow-host scale is explicit', t => {
  const depth = process.env.PM_TEST_DEPTH; const scale = process.env.PM_TEST_TIME_SCALE;
  t.after(() => { if (depth === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = depth; if (scale === undefined) delete process.env.PM_TEST_TIME_SCALE; else process.env.PM_TEST_TIME_SCALE = scale; });
  delete process.env.PM_TEST_DEPTH; assert.equal(testDepth(500), 500);
  process.env.PM_TEST_DEPTH = 'quick'; assert.equal(testDepth(500), 50); assert.equal(testDepth(100), 25); assert.equal(testDepth(20), 20);
  process.env.PM_TEST_DEPTH = 'full'; assert.equal(testDepth(500), 500);
  process.env.PM_TEST_DEPTH = 'unknown'; assert.equal(testDepth(500), 500);
  delete process.env.PM_TEST_TIME_SCALE; assert.equal(testTime(100), 100);
  process.env.PM_TEST_TIME_SCALE = '3'; assert.equal(testTime(100), 300);
  for (const value of ['0', '-1', 'invalid']) { process.env.PM_TEST_TIME_SCALE = value; assert.equal(testTime(100), 100); }
});

// The child deliberately creates lock files during asynchronous shutdown. The
// root must disappear only after that child closes, so it cannot be recreated.
test('fixture teardown awaits a delayed child writer before removing its root', async t => {
  const outer = await tracker(t); const finished = join(outer.root, 'finished'); let root = '';
  await t.test('child-owned fixture', async inner => {
    const target = await tracker(inner); root = target.root;
    const script = `const fs = require('node:fs/promises'); const path = require('node:path');
process.on('SIGTERM', () => { setTimeout(async () => { await fs.mkdir(path.join(process.argv[1], '.pm-cli', 'locks'), { recursive: true }); await fs.writeFile(process.argv[2], 'closed'); process.exit(0); }, 25); });
console.log('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script, root, finished], { stdio: ['ignore', 'pipe', 'pipe'], env: testEnvironment(process.env) });
    ownFixtureChild(inner, child); await once(child.stdout!, 'data');
  });
  assert.equal(await readFile(finished, 'utf8'), 'closed');
  await assert.rejects(access(root), { code: 'ENOENT' });
});


test('fractional runner scale rounds spawnSync deadlines up to integer milliseconds', t => {
  const previous = process.env.PM_TEST_TIME_SCALE;
  t.after(() => { if (previous === undefined) delete process.env.PM_TEST_TIME_SCALE; else process.env.PM_TEST_TIME_SCALE = previous; });
  process.env.PM_TEST_TIME_SCALE = '1.1';
  assert.equal(testTime(101), 112);
  const result = spawnSync(process.execPath, ['-e', ''], { timeout: testTime(10_001), encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});
