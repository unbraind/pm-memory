/** CI must invoke both complete package release gate entrypoints. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

/**
 * The workflow steps under test are bash scripts that use jq, as on GitHub's
 * runners. Locally a missing tool skips them with its name; under CI it fails,
 * so the hosted check can never pass by skipping.
 */
function requireWorkflowTools(t: TestContext): boolean {
  const missing = ['bash', 'jq'].filter(tool => spawnSync(tool, ['--version'], { stdio: 'ignore' }).error !== undefined);
  if (missing.length === 0) return true;
  assert.equal(process.env.CI, undefined, `CI must provide ${missing.join(' and ')} for the workflow step tests`);
  t.skip(`${missing.join(' and ')} not installed; the workflow step tests need them`);
  return false;
}

test('CI invokes the complete npm and Bun release gates', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /^\s+run: npm run release:check$/mu);
  assert.match(ci, /^\s+run: bun run release:check$/mu);
});


test('CI separates full runtime gates while required checks refuse failed, canceled or skipped runtimes', t => {
  if (!requireWorkflowTools(t)) return;
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(ci.jobs.runtime.strategy.matrix.include, [
    { 'node-version': 22, runtime: 'npm' }, { 'node-version': 26, runtime: 'npm' }, { 'node-version': 26, runtime: 'bun' },
  ]);
  assert.equal(ci.jobs.runtime.strategy['fail-fast'], false);
  const steps = ci.jobs.runtime.steps;
  assert.equal(steps.find((step: { run?: string }) => step.run === 'npm run release:check').if, "matrix.runtime == 'npm'");
  assert.equal(steps.find((step: { run?: string }) => step.run === 'bun run release:check').if, "matrix.runtime == 'bun'");
  const required = ci.jobs.test;
  assert.equal(required.name, 'test (${{ matrix.node-version }})');
  assert.deepEqual(required.strategy.matrix['node-version'], [22, 26]);
  assert.equal(required.needs, 'runtime'); assert.equal(required.if, '${{ always() }}');
  assert.equal(required.steps[0].env.RUNTIME_RESULT, '${{ needs.runtime.result }}');
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    const actual = spawnSync('bash', ['-c', required.steps[0].run], { env: { ...process.env, RUNTIME_RESULT: result } });
    assert.equal(actual.status, result === 'success' ? 0 : 1, result);
  }
});

test('required checks also verify each runtime leg, including legs carried over by a re-run', t => {
  if (!requireWorkflowTools(t)) return;
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const required = ci.jobs.test;
  assert.deepEqual(required.permissions, { actions: 'read' });
  const legs = required.steps[1];
  assert.equal(legs.env.GH_TOKEN, '${{ github.token }}');
  assert.match(legs.run, /actions\/runs\/\$GITHUB_RUN_ID\/jobs\?filter=latest/u);
  // A stand-in gh applies the workflow's own --jq filter to job objects, or fails like an API error.
  const bin = mkdtempSync(join(tmpdir(), 'memory-ci-gh-'));
  try {
    writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\n[ -n "$JOBS" ] || exit 1\nwhile [ $# -gt 0 ]; do [ "$1" = --jq ] && { jq -c "$2" <<<"$JOBS"; exit; }; shift; done\nexit 2\n', { mode: 0o755 });
    // Job names come from the workflow's own name template and matrix, as GitHub renders them.
    const legNames = (ci.jobs.runtime.strategy.matrix.include as { 'node-version': number; runtime: string }[]).map(leg =>
      String(ci.jobs.runtime.name).replace('${{ matrix.node-version }}', String(leg['node-version'])).replace('${{ matrix.runtime }}', leg.runtime));
    assert.deepEqual(legNames, ['release gate (22, npm)', 'release gate (26, npm)', 'release gate (26, bun)']);
    // The step's expected-name list must be exactly the rendered matrix names.
    const expected = /== (\[[^\]]*\])/u.exec(legs.run)?.[1];
    assert.ok(expected, 'the step must compare against an explicit leg-name list');
    assert.deepEqual(JSON.parse(expected), [...legNames].sort());
    const jobs = (conclusions: (string | null)[], others: [string, string | null][] = []) => JSON.stringify({ jobs: [
      ...legNames.slice(0, conclusions.length).map((name, index) => ({ name, conclusion: conclusions[index] })),
      ...conclusions.slice(legNames.length).map(conclusion => ({ name: 'release gate (26, npm)', conclusion })),
      ...others.map(([name, conclusion]) => ({ name, conclusion })),
    ] });
    // While an aggregator runs, both aggregators are still in progress (conclusion null).
    const running: [string, string | null][] = [['test (22)', null], ['test (26)', null]];
    const cases: [string, number, string][] = [
      [jobs(['success', 'success', 'success'], running), 0, 'three successful legs beside running aggregators'],
      [jobs(['success', 'success', 'success'], [...running, ['unrelated', 'failure']]), 0, 'an unrelated failed job is not a runtime leg'],
      [jobs(['success', 'failure', 'success'], [...running, ['unrelated', 'success']]), 1, 'a failed leg beside an unrelated success'],
      [jobs(['success', 'success'], [...running, ['unrelated', 'success']]), 1, 'a missing leg'],
      [jobs(['success', 'success', 'success', 'success'], running), 1, 'a duplicated leg'],
      [JSON.stringify({ jobs: [...[legNames[0], legNames[1], legNames[1]].map(name => ({ name, conclusion: 'success' })), ...running.map(([name, conclusion]) => ({ name, conclusion }))] }), 1, 'a duplicated leg standing in for a missing one'],
      [jobs(['success', 'cancelled', 'success'], running), 1, 'a cancelled leg'],
      [jobs(['success', 'skipped', 'success'], running), 1, 'a skipped leg'],
      [jobs(['success', null, 'success'], running), 1, 'a leg without a conclusion'],
      ['', 1, 'an API failure'],
    ];
    for (const [payload, status, label] of cases) {
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, JOBS: payload, GITHUB_REPOSITORY: 'unbraind/pm-memory', GITHUB_RUN_ID: '1' };
      assert.equal(spawnSync('bash', ['-c', legs.run], { env }).status, status, label);
    }
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
