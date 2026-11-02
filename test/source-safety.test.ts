import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';
import { sourceDocument, stemOf } from '../src/portable-source.ts';
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

test('legacy scalar adaptation preserves accepted colon delimiters and quoted or block scalars', () => {
  let seed = 0x1363f016;
  for (let sequence = 0; sequence < 1000; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const scalar = ['Title', '!: : value', ': : value', 'value: final', 'value: ending', 'plain', 'literal # comment', '  padded: value'][seed % 8];
    const ending = sequence % 2 === 0 ? '\n' : '\r\n';
    const value = scalar.includes(': ') ? scalar : JSON.stringify(scalar);
    const input = ['---', `name: ${value}`, `description: ${value}`, '---', '# Body'].join(ending);
    const source = sourceDocument('alpha.md', Buffer.from(input), 'agents-md');
    assert.equal(source.title, scalar); assert.equal(source.description, scalar);
    assert.equal(source.body, '# Body'); assert.equal(source.original, Buffer.from(input).toString('base64'));
  }
  for (const [value, expected] of [['plain', 'plain'], ['plain # comment: ', 'plain'], ['plain # comment: value', 'plain # comment: value'], ['"quoted: value"', 'quoted: value'], ["'quoted: value'", 'quoted: value'], ['|\n  Block: value\n', 'Block: value\n'], ['>\n  Folded: value\n', 'Folded: value\n']]) {
    const source = sourceDocument('alpha.md', Buffer.from(`---\nname: alpha\ndescription: ${value}\n---\nBody`), 'cursor');
    assert.equal(source.description, expected);
  }
});

test('previously accepted YAML scalars retain their parsed values and exact original bytes', () => {
  const tokens = ['plain', ': ', ' # comment', ' ', ': tail', '\t', ':', '!: ', '"quoted: value"', "'quoted: value'"];
  let allowed = 0;
  for (const left of tokens) for (const middle of tokens) for (const right of tokens) {
    const value = left + middle + right;
    const input = `name: alpha\ndescription: ${value}`;
    let previous: unknown;
    try { previous = parse(input.replace(/^(name|description): ([^"'|>\n].*: .+)$/gm, (_line, key: string, scalar: string) => `${key}: ${JSON.stringify(scalar)}`), { logLevel: 'error' }); } catch { continue; }
    const original = `---\n${input}\n---\nBody`;
    const source = sourceDocument('alpha.md', Buffer.from(original), 'cursor');
    const expected = (previous as { description?: unknown }).description;
    assert.equal(source.description, typeof expected === 'string' ? expected : '', JSON.stringify(value));
    assert.equal(source.original, Buffer.from(original).toString('base64')); allowed++;
  }
  assert.ok(allowed > 500);
});

test('long colon-rich YAML scalars remain complete through the shared source parser', () => {
  const value = '!: ' + ': '.repeat(100000);
  for (const from of ['agents-md', 'claude-code', 'cursor'] as const) {
    const input = `---\nname: alpha\ndescription: ${value}\n---\nBody`;
    const parsed = sourceDocument('alpha.md', Buffer.from(input), from);
    assert.equal(parsed.description, value); assert.equal(parsed.body, 'Body');
    assert.equal(parsed.original, Buffer.from(input).toString('base64'));
  }
});
