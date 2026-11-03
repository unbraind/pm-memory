import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROPERTY_MASTERS, declaredSeeds, assertSeedCoverage } from './property-seeds.ts';

for (const suite of Object.keys(PROPERTY_MASTERS)) {
  test(`property seed guard: ${suite} requires all declared 500 completed seeds`, () => {
    const complete = declaredSeeds(suite);
    assert.equal(complete.length, 500);
    assertSeedCoverage(suite, complete);
    assert.throws(() => assertSeedCoverage(suite, complete.filter(row => row.sequence !== 237)), /completed seed count/);
    assert.throws(() => assertSeedCoverage(suite, [...complete.slice(0, 499), complete[0]]), /completed seed list/);
    assert.throws(() => assertSeedCoverage(suite, complete.map(row => row.sequence === 237 ? { ...row, seed: row.seed ^ 1 } : row)), /completed seed list/);
  });
}
