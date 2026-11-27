import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanMutationSecrets } from '@unbrained/pm-cli/sdk';
import { privacy } from '../src/core.ts';

/** Check verdicts that come from the package's own scanner. */
function assertLocalVerdicts(allowed: string, refused: string): void {
  assert.equal(scanMutationSecrets(allowed).length, 0);
  assert.equal(scanMutationSecrets(refused).length, 0);
  assert.doesNotThrow(() => privacy(allowed));
  assert.throws(() => privacy(refused), { code: 'privacy', message: 'Credential-shaped memory refused' });
}

test('reference-adjacent literal fragments use their combined length', () => {
  assertLocalVerdicts('pwd="${X}"abcd"efg"', 'pwd="${X}"abcd"efgh"');
});

test('a complete quoted reference adds no literal characters to an adjacent run', () => {
  assertLocalVerdicts('pwd="${X}"abcd"${BUILD_PASSWORD}"efg', 'pwd="${X}"abcd"e"efg');
});

test('unterminated quoted segments preserve the combined literal verdict', () => {
  assertLocalVerdicts('pwd="${X}"abcd"efg', 'pwd="${X}"abcd"efgh');
});
