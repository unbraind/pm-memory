import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { stemOf } from '../src/portable-source.ts';
import { testEnvironment } from '../scripts/environment.ts';

test('source path normalization preserves the existing contract over 2000 seeded paths', () => {
  let seed = 0x1363f015;
  for (let sequence = 0; sequence < 2000; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const path = ['Alpha', '_', '-', '/', '.', ' ', '中', '\\'][seed % 8].repeat(seed % 40) + ['.md', '/A.B', '---', '', '/'][sequence % 5];
    const normalized = path.replace(/\.[^./]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const chars = [...normalized];
    while (chars[0] === '-') chars.shift();
    while (chars.at(-1) === '-') chars.pop();
    assert.equal(stemOf(path), chars.join(''), `sequence=${sequence} seed=${seed}`);
  }
  for (const [value, expected] of [['', ''], ['-', ''], ['---', ''], ['A---B', 'a---b'], ['---A---', 'a'], ['A--B---C', 'a--b---c']]) assert.equal(stemOf(value), expected);
});

test('untrusted source paths consume long hyphen runs once, including nonmatching suffixes', () => {
  const module = new URL('../src/portable-source.ts', import.meta.url).href;
  const code = `import assert from 'node:assert/strict'; import { stemOf, sourceDocument } from ${JSON.stringify(module)};
    const run = '-'.repeat(1000000);
    for (const path of [run, 'a' + run + 'b', run + 'alpha' + run, 'a' + run + '/b.md']) {
      const stem = stemOf(path); assert.ok(!stem.startsWith('-') && !stem.endsWith('-'));
      const source = sourceDocument(path, Buffer.from('# Long-path input'), 'agents-md');
      assert.equal(source.body, '# Long-path input'); assert.ok(source.slug.length <= 120);
    }
    console.log('bounded source scans passed');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15000, env: testEnvironment(process.env) });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /bounded source scans passed/);
});
