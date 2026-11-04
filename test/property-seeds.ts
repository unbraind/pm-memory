import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

/** The fixed public property budgets; a changed batch size cannot change their seeds. */
export const PROPERTY_MASTERS: Record<string, number> = {
  MODEL: 0x1363cafe, OWNED: 0x1363f014, GRAMMAR: 0x1363f005,
  FIDELITY: 0x13631d07, DOCUMENT: 0x1363d0c4,
  identity: 0x1363b0a1, locality: (0x1363b0a1 + 0x1020304) >>> 0,
  foreign: (0x1363b0a1 + 2 * 0x1020304) >>> 0,
};
/** One sequence that reached all of its assertions successfully. */
export interface SeedExecution { sequence: number; seed: number }
/** Independently enumerate every declared seed, including the owned-field LCG stream. */
export function declaredSeeds(suite: string): SeedExecution[] {
  assert.ok(Object.hasOwn(PROPERTY_MASTERS, suite), `Unknown property suite: ${suite}`);
  const master = PROPERTY_MASTERS[suite]; let random = master;
  return Array.from({ length: 500 }, (_, sequence) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return { sequence, seed: suite === 'OWNED' ? random : (master + Math.imul(sequence, 0x9e3779b9)) >>> 0 };
  });
}
/** Fail on omissions, duplicate coordinates, altered seeds or extra executions. */
export function assertSeedCoverage(suite: string, actual: readonly SeedExecution[], start = 0, count = 500): void {
  const expected = declaredSeeds(suite).slice(start, start + count);
  assert.equal(actual.length, count, `${suite}: completed seed count`);
  assert.deepEqual([...actual].sort((a, b) => a.sequence - b.sequence), expected, `${suite}: completed seed list`);
}
/** Record only completed sequences; parent workers verify and publish the complete list. */
export function seedLedger(t: TestContext, suite: string, start: number, count: number): SeedExecution[] {
  const executed: SeedExecution[] = [];
  t.after(() => {
    assertSeedCoverage(suite, executed, start, count);
    t.diagnostic(`SEED_RECEIPT=${JSON.stringify({ suite, executed })}`);
  });
  return executed;
}
