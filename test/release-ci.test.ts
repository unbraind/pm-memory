/** CI must invoke both complete package release gate entrypoints. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('CI invokes the complete npm and Bun release gates', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /^\s+run: npm run release:check$/mu);
  assert.match(ci, /^\s+run: bun run release:check$/mu);
});
