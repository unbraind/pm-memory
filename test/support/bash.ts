/** Keep local Bash absence skippable while enforcing the CI prerequisite. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';

/** Probe Bash before executing a workflow shell fixture. */
export function workflowBash(t: TestContext): boolean {
  const result = spawnSync('bash', ['--version'], { encoding: 'utf8', timeout: 30000 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !process.env.CI) {
    t.skip('bash is unavailable on PATH');
    return false;
  }
  assert.equal(result.error, undefined, 'bash is required in CI');
  assert.equal(result.status, 0, result.stderr);
  return true;
}
