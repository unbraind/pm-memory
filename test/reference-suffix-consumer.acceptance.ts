import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { consumerFixture, installConsumer, execute } from './consumer-helpers.ts';

test('one packed artifact preserves safe causes and refuses reference suffix credentials in npm and Bun SDK/CLI consumers', t => {
  const fixture = consumerFixture(t);
  const archive = join(fixture.scratch, fixture.packed[0].filename);
  assert.equal('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64'), fixture.packed[0].integrity);
  const literal = 'SyntheticOnly123!'; const unsafe = 'password=${X}(' + literal + ')';
  for (const manager of ['npm', 'bun']) {
    const consumer = installConsumer(fixture, manager);
    assert.equal(existsSync(join(consumer, '.git')), false, 'Consumer must use a non-git tracker');
    const runtime = manager === 'npm' ? process.execPath : 'bun';
    const executable = manager === 'npm' ? 'npx' : 'bunx';
    const prefix = manager === 'npm' ? ['--no-install', 'pm'] : ['--bun', '--no-install', 'pm'];
    const env = { ...fixture.env, PM_PATH: join(consumer, 'tracker') };
    writeFileSync(join(consumer, 'probe.ts'), `import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { remember, get, exportDir, MemoryError } from 'pm-memory';
const options = { workspace: process.env.PM_PATH, author: 'memory-consumer' };
const client = new PmClient({ pmRoot: options.workspace, author: options.author, noExtensions: true });
const unsafe = ${JSON.stringify(unsafe)};
if (process.argv[2] === 'setup') {
  await client.init('suffix', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  await assert.rejects(remember(unsafe, { ...options, kind: 'reference' }), e => e instanceof MemoryError && e.code === 'privacy');
  assert.equal((await client.listAllComplete()).items.length, 0);
  await remember('password=' + '$' + '{X}(provided by the environment)', { ...options, kind: 'reference', slug: 'safe' });
  const malformed = '"password": ' + String.fromCharCode(92, 34).repeat(50000);
  await remember(malformed, { ...options, kind: 'reference', slug: 'malformed', forceNew: true });
  assert.equal((await get('malformed', options)).body, malformed);
  await writeFile('input.md', unsafe);
} else if (process.argv[2] === 'origin') {
  await assert.rejects(exportDir('refused-origin-sdk', { ...options, to: 'agents-md' }), error => {
    assert.ok(error instanceof MemoryError && error.code === 'origin_missing');
    assert.ok(error.cause instanceof SyntaxError);
    assert.equal(Object.getOwnPropertyDescriptor(error, 'cause').enumerable, false);
    assert.equal(JSON.stringify(error).includes('Synthetic private origin detail'), false);
    return true;
  });
} else {
  const item = await get('safe', options);
  await client.update(item.id, { body: unsafe });
  assert.equal((await get('safe', options)).body, unsafe);
}
console.log('packed suffix SDK accepted');
`);
    assert.match(execute(consumer, ['probe.ts', 'setup'], runtime, env), /packed suffix SDK accepted/);
    execute(consumer, [...prefix, 'package', 'install', archive], executable, env);
    const refused = (args: string[], json: boolean) => {
      const output = execute(consumer, [...prefix, 'memory', ...args, ...(json ? ['--json'] : [])], executable, env, 4);
      assert.match(output, /privacy/); assert.equal(output.includes(literal), false);
      if (json) assert.equal(JSON.parse(output).code, 'privacy');
    };
    for (const json of [false, true]) {
      for (const args of [
        ['remember', unsafe, '--kind', 'reference'],
        ['remember', 'Safe content', '--kind', 'reference', '--why', unsafe],
        ['remember', 'Safe content', '--kind', 'reference', '--how', unsafe],
        ['renew', 'safe', '--valid-from', '2026-01-01T00:00:00.000Z', '--valid-until', '2027-01-01T00:00:00.000Z', '--evidence', unsafe],
        ['observe', 'safe', '--recall', 'a'.repeat(24), '--task', 'task', '--feedback', 'helpful', '--outcome', 'improved', '--attribution', 'isolated', '--evidence', unsafe],
        ['import', 'input.md', '--from', 'agents-md'],
        ['import', 'input.md', '--from', 'claude-code'],
      ]) refused(args, json);
    }
    const origin = join(env.PM_PATH, 'memory-origin.json');
    const original = existsSync(origin) ? readFileSync(origin) : undefined;
    writeFileSync(origin, 'Synthetic private origin detail');
    try {
      assert.match(execute(consumer, ['probe.ts', 'origin'], runtime, env), /packed suffix SDK accepted/);
      for (const json of [false, true]) {
        const output = execute(consumer, [...prefix, 'memory', 'export', 'refused-origin-cli', '--to', 'agents-md', ...(json ? ['--json'] : [])], executable, env, 2);
        assert.match(output, /origin_missing/);
        assert.equal(output.includes('Synthetic private origin detail'), false);
        if (json) assert.equal(JSON.parse(output).code, 'origin_missing');
        assert.equal(existsSync(join(consumer, 'refused-origin-cli')), false);
      }
      assert.equal(existsSync(join(consumer, 'refused-origin-sdk')), false);
      assert.equal(readFileSync(origin, 'utf8'), 'Synthetic private origin detail');
    } finally { if (original === undefined) rmSync(origin, { force: true }); else writeFileSync(origin, original); }
    assert.match(execute(consumer, ['probe.ts', 'legacy'], runtime, env), /packed suffix SDK accepted/);
    for (const json of [false, true]) for (const to of ['agents-md', 'claude-code']) {
      refused(['export', 'refused-' + to, '--to', to], json);
      assert.equal(existsSync(join(consumer, 'refused-' + to)), false);
    }
  }
});
