import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { remember, get, renew, observe, importDir, exportDir, MemoryError } from '../index.ts';
import { privacy } from '../src/core.ts';
import { runCommand } from '../src/commands.ts';
import { tracker, snapshot, withoutGit } from './helpers.ts';

const literal = 'SyntheticOnly123!';
const unsafe = 'password=${X}(' + literal + ')';
/** Check the domain refusal and its complete public diagnostic without echoing content. */
function refused(error: unknown): boolean {
  assert.ok(error instanceof MemoryError && error.code === 'privacy');
  assert.equal(JSON.stringify(error).includes(literal), false);
  return true;
}

test('reference exemptions preserve literal context across assignment and transport grammars', () => {
  let cases = 0;
  for (const name of ['password', 'passphrase', 'passwd', 'pwd', 'api_key', 'API-KEY', 'api key', 'access_token', 'auth-token', 'secret', 'token', '_authToken']) {
    for (const reference of ['${X}', '$BUILD_SECRET']) for (const quote of ['', '"', "'"]) for (const separator of ['=', ': ']) {
      for (const suffix of ['(' + literal + ')', '(provided by the environment)' + literal, '(provided by the environment)(' + literal + ')', '(' + 'a '.repeat(101) + literal + ')', '(unterminated' + literal]) {
        const value = name + separator + quote + reference + suffix + quote;
        for (const encoded of [value, [...value].map(char => '%' + char.charCodeAt(0).toString(16)).join(''), value.replace('(', '\\u0028')]) {
          assert.throws(() => privacy(encoded, true), refused); cases++;
        }
      }
    }
  }
  assert.equal(cases, 2160);
  for (const value of ['passphrase=SyntheticOnly123!', 'passphrase=${X}SyntheticOnly123!', 'passphrase=$BUILD_SECRET!' + literal, 'passphrase=(' + literal + ')', 'passphrase={' + literal + '}']) assert.throws(() => privacy(value), refused);
  const bounded = '(a ' + 'b'.repeat(196) + ')'; assert.equal(bounded.length, 200);
  privacy('password=${X}' + bounded);
  for (const suffix of [bounded + literal, bounded.slice(0, -1) + 'b)', '(x)']) assert.throws(() => privacy('password=${X}' + suffix), refused);
  for (const value of ['password=${X}', 'password="${X}"', 'passphrase=short', 'password=${X}(provided by the environment)', 'password=${X}(provided by the environment); more guidance', 'password=${X}(provided by the environment)\npassword=${BUILD_SECRET}', 'password=${X}(provided by the environment)"']) privacy(value);
});

test('all SDK memory and evidence fields refuse reference suffix literals before writes without git', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const before = await snapshot(target.workspace);
  for (const field of ['fact', 'why', 'how', 'slug', 'update', 'tags', 'links']) {
    const options = { ...target.options, kind: 'reference' as const, ...(field === 'fact' ? {} : { [field]: field === 'tags' || field === 'links' ? [unsafe] : unsafe }) };
    await assert.rejects(remember(field === 'fact' ? unsafe : 'Safe reference', options), refused);
  }
  await assert.rejects(renew('absent', { ...target.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: unsafe }), refused);
  await assert.rejects(observe('absent', { ...target.options, recall: 'a'.repeat(24), task: 'task', feedback: 'helpful', outcome: 'improved', attribution: 'isolated', evidence: unsafe }), refused);
  assert.deepEqual(await snapshot(target.workspace), before);
  const safe = 'password=${X}(provided by the environment)';
  const saved = await remember(safe, { ...target.options, kind: 'reference' });
  assert.equal((await get(saved.slug, target.options)).body, safe);
});

test('every command privacy refusal replaces host recovery arguments with safe metadata', async t => {
  const target = await tracker(t); const before = await snapshot(target.workspace);
  const ctx = { command: 'memory remember', pm_root: target.workspace, args: [unsafe], options: { kind: 'reference' }, global: {} } as CommandHandlerContext;
  for (const fact of [unsafe, 'password=' + literal, JSON.stringify({ password: literal })]) {
    await assert.rejects(runCommand('remember', { ...ctx, args: [fact] }), error => {
      assert.ok(isPmCliExpectedError(error)); assert.equal(error.exitCode, 4);
      assert.equal(JSON.stringify(error).includes(literal), false);
      assert.deepEqual(error.context.recovery, { attempted_command: 'pm memory remember [redacted]', normalized_args: ['memory', 'remember'], provided_fields: [] });
      return true;
    });
  }
  assert.deepEqual(await snapshot(target.workspace), before);
});

test('both harnesses refuse suffix credentials on intake and export while legacy records remain readable', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const source = join(target.root, 'source'); await mkdir(source);
  await writeFile(join(source, 'alpha.md'), unsafe);
  await writeFile(join(source, 'MEMORY.md'), '- [Alpha](alpha.md)\n');
  const before = await snapshot(target.workspace);
  for (const from of ['agents-md', 'claude-code'] as const) {
    await assert.rejects(importDir(source, { ...target.options, from }), refused);
    assert.deepEqual(await snapshot(target.workspace), before);
  }
  const saved = await remember('Safe legacy guidance', { ...target.options, kind: 'reference' });
  for (const patch of [{ body: unsafe }, { body: 'Safe legacy guidance', memoryDocument: JSON.stringify({ version: 1, format: 'legacy', harness: 'agents-md', path: 'alpha.md', original: Buffer.from(unsafe).toString('base64') }) }]) {
    await target.client.update(saved.id, patch);
    assert.equal((await get(saved.slug, target.options)).body, patch.body);
    const retained = await snapshot(target.workspace);
    for (const to of ['agents-md', 'claude-code'] as const) {
      const output = join(target.root, 'export-' + to);
      await assert.rejects(exportDir(output, { ...target.options, to }), refused);
      await assert.rejects(access(output), { code: 'ENOENT' });
      assert.deepEqual(await snapshot(target.workspace), retained);
    }
  }
});
