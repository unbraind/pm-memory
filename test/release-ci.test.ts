/** Required PR checks must preserve routing, coverage and the exhaustive deep gate. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const workflow = (name: string) => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

test('required checks run directly on hosted quick jobs; deep preserves all runtime gates', () => {
  const ci = workflow('ci'); const deep = workflow('ci-deep'); const codeql = workflow('codeql');
  assert.deepEqual(Object.keys(ci.on).sort(), ['pull_request', 'workflow_dispatch']);
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  assert.equal(ci.jobs.test.name, 'test (${{ matrix.node-version }})');
  assert.deepEqual(ci.jobs.test.strategy.matrix['node-version'], [22, 26]);
  assert.equal(ci.jobs.test['runs-on'], 'ubuntu-latest');
  assert.equal(ci.jobs.test.needs, undefined);
  assert.equal(ci.jobs.test.env.PM_TEST_DEPTH, 'quick');
  const steps = ci.jobs.test.steps;
  const gate = steps.find((step: { run?: string }) => step.run === 'npm run release:check');
  assert.equal(gate.if, "steps.changes.outputs.code == 'true' && matrix.node-version == 26");
  assert.equal(steps.some((step: { run?: string }) => step.run === 'bun run release:check'), false);
  assert.equal(steps.find((step: { run?: string }) => step.run === 'npm test').if, "steps.changes.outputs.code == 'true' && matrix.node-version == 22");
  assert.equal(steps.find((step: { run?: string }) => step.run === 'npm run changelog:check').if, "steps.changes.outputs.code != 'true'");
  assert.ok(steps.some((step: { run?: string; if?: string }) => step.run === './node_modules/.bin/pm health --strict-exit --require-merge-drivers' && step.if === undefined));
  assert.deepEqual(Object.keys(deep.on).sort(), ['push', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(deep.on.push.branches, ['main']);
  assert.deepEqual(deep.jobs.deep.strategy.matrix, { 'node-version': [22, 26], runtime: ['npm', 'bun'] });
  assert.deepEqual(deep.jobs.deep.env, { NPM_CONFIG_USERCONFIG: '/dev/null', PM_TEST_DEPTH: 'full', PM_TEST_TIME_SCALE: 3 });
  assert.equal(deep.jobs.deep['timeout-minutes'], 120);
  assert.match(deep.jobs.deep['runs-on'], /PM_LOCAL_DEEP != 'off'/);
  assert.equal(deep.jobs.deep.steps.find((step: { run?: string }) => step.run === 'npm run release:check').if, "matrix.runtime == 'npm'");
  assert.equal(deep.jobs.deep.steps.find((step: { run?: string }) => step.run === 'bun run release:check').if, "matrix.runtime == 'bun'");
  assert.notEqual(deep.jobs.deep.name, ci.jobs.test.name);
  for (const config of [ci, codeql]) for (const job of Object.values(config.jobs) as Record<string, unknown>[]) {
    assert.ok(Number(job['timeout-minutes']) > 0 && Number(job['timeout-minutes']) <= 30);
  }
  // CodeQL is required here: docs-only PRs must still receive its result.
  assert.equal(codeql.on.pull_request['paths-ignore'], undefined);
  assert.equal(codeql.on.push['paths-ignore'], undefined);
  assert.equal(codeql.on.schedule[0].cron, '47 1 * * 1');
});

test('PR change detection handles docs, source, deletions, renames and unusual filenames', t => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if ((bash.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !process.env.CI) {
    t.skip('bash is unavailable on PATH');
    return;
  }
  assert.equal(bash.error, undefined, 'bash is required in CI');
  assert.equal(bash.status, 0, bash.stderr);
  const script = workflow('ci').jobs.test.steps.find((step: { id?: string }) => step.id === 'changes').run;
  const root = mkdtempSync(join(tmpdir(), 'memory-ci-routing-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;'); git('add', 'source.ts'); git('commit', '-qm', 'Fixture');
    const base = git('rev-parse', 'HEAD');
    const detect = (expected: boolean, label: string) => {
      const output = join(root, 'output');
      const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8', env: { ...process.env, BASE_SHA: base, HEAD_SHA: git('rev-parse', 'HEAD'), GITHUB_EVENT_NAME: 'pull_request', RUNNER_TEMP: root, GITHUB_OUTPUT: output } });
      assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(output, 'utf8'), `code=${expected}\n`, label);
    };
    const cases: [string, boolean][] = [['README.md', false], ['docs/guide.txt', false], ['.agents/pm/tasks/sample.toon', false], ['LICENSE', false], ['src/new.ts', true], ['source\nname.ts', true]];
    for (const [path, expected] of cases) {
      git('reset', '--hard', base); git('clean', '-fd');
      mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), 'fixture');
      git('add', '--', path); git('commit', '-qm', 'Fixture change');
      detect(expected, path);
    }
    git('reset', '--hard', base); git('clean', '-fd'); git('mv', 'source.ts', 'guide.md'); git('commit', '-qm', 'Rename fixture');
    detect(true, 'source-to-docs rename still includes source deletion');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
