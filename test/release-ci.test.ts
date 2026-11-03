/** CI must invoke both complete package release gate entrypoints. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

test('CI invokes the complete npm and Bun release gates', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /^\s+run: npm run release:check$/mu);
  assert.match(ci, /^\s+run: bun run release:check$/mu);
});


test('CI separates full runtime gates while required checks refuse failed, canceled or skipped runtimes', () => {
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
