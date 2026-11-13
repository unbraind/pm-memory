import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isPmCliExpectedError, scanMutationSecrets } from '@unbrained/pm-cli/sdk';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { remember, get, renew, observe, importDir, exportDir, MemoryError } from '../index.ts';
import { privacy } from '../src/core.ts';
import { runCommand } from '../src/commands.ts';
import { tracker, snapshot, withoutGit } from './helpers.ts';
import { causeDiagnostics } from './privacy-diagnostics.ts';

const literal = 'SyntheticOnly123!';
const unsafe = 'password=${X}(' + literal + ')';
/** Check the domain refusal and its complete public diagnostic without echoing content. */
function refused(error: unknown): boolean {
  assert.ok(error instanceof MemoryError && error.code === 'privacy');
  assert.equal([error.message, error.remedy, causeDiagnostics(error.cause)].some(value => value.includes(literal)), false);
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

test('reference boundaries inspect adjacent quoted literals and preserve pure reference twins', () => {
  for (const key of ['password', 'passphrase', 'api_key', 'client_secret', '_authToken']) {
    for (const reference of ['${X}', '$BUILD_SECRET', '${BUILD_SECRET}(provided by the environment)']) {
      for (const outer of ['', '"', "'"]) for (const quote of ['"', "'"]) {
        const prefix = key + '=' + outer + reference + outer;
        const value = prefix + quote + literal + quote;
        for (const encoded of [value, JSON.stringify(value), prefix + quote + literal, [...value].map(char => '%' + char.charCodeAt(0).toString(16)).join(''), value.replaceAll('"', '\\u0022').replaceAll("'", '\\u0027')]) assert.throws(() => privacy(encoded, true), refused);
        for (const twin of [prefix, prefix + quote + '${NEXT_SECRET}' + quote]) if (scanMutationSecrets(twin).length === 0) privacy(twin, true);
      }
    }
  }
  privacy('password=${X}"${Y}"; api_key=${Z}"${Q}"');
  // A literal adjacent to the closing quote of a reference suffix, directly or after further quoted references.
  for (const value of ['password=${X}"${Y}"' + literal, 'password=${X}"${Y}"\'${Z}\'' + literal, "password=${X}'${Y}'\"" + literal + '"', 'api_key=${X}"${Y}"' + literal + '; note=ok']) {
    for (const encoded of [value, JSON.stringify(value)]) assert.throws(() => privacy(encoded), refused);
  }
  // A bracket-wrapped literal adjacent to the closing quote is checked like the standalone wrapper form.
  for (const value of ['password=${X}"${Y}"<' + literal + '>', 'api_key=${X}"${Y}"<' + literal]) for (const encoded of [value, JSON.stringify(value)]) assert.throws(() => privacy(encoded), refused);
  privacy('password=${X}"${Y}"<secret-manager-reference>');
  // The same wrapper directly after an unquoted or closed-quote reference.
  for (const value of ['password=${X}<' + literal + '>', 'password="${X}"<' + literal + '>', "api_key='${X}'<" + literal + '>']) for (const encoded of [value, JSON.stringify(value)]) assert.throws(() => privacy(encoded), refused);
  privacy('password=${X}<secret-manager-reference>');
  // A literal split across adjacent quoted or bare segments is judged by its combined text.
  for (const value of ['password=${X}"Synthet""icOnly1""23!"', "password=${X}'Synthet'icOnly'123!'", 'password="${X}"Synthet"icOnly123!"', 'password=${X}ab"cdefgh"', 'password=${X}"abcd""efgh"']) for (const encoded of [value, JSON.stringify(value)]) assert.throws(() => privacy(encoded), refused);
  for (const value of ['password=${X}"ab""cd"', 'password=${X}"${Y}""${Z}"', 'password=${X}"a"<secret-manager-reference>', 'pwd="${X}"'.repeat(3), 'password=${X}"${Y}"api_key=${Z}', 'pwd="${X}"; token="${Y}"']) privacy(value);
  // Complete references are consumed whole, so a literal after one is inspected and pure references stay public.
  for (const value of ['password=${X}"${Y}"${Z}' + literal, 'password=${X}"${Y}"${Z}"' + literal + '"']) for (const encoded of [value, JSON.stringify(value)]) assert.throws(() => privacy(encoded), refused);
  for (const value of ['password=${X}"${Y}"${BUILD_PASSWORD}', 'password=${X}"${Y}"$BUILD_PASSWORD', 'password="${X}"${BUILD_PASSWORD}']) privacy(value);
  // Must allow: adjacent pure references and whitespace-separated prose stay public.
  for (const value of ['password=${X}"${Y}"${Z}', 'password=${X}"${Y}" plus the deployment note', 'password=${X}"${Y}"\'${Z}\'']) privacy(value);
  assert.throws(() => privacy('password=${X}"${Y}"; api_key=${Z}"' + literal + '"'), refused);
  privacy(JSON.stringify({ note: 'password=${X}' }, null, 2));
  privacy(JSON.stringify({ first: 'password=${X}', second: 'api_key=${Y}' }, null, 2));
  privacy('password=${X}"}"; api_key=${Y}"}"'); privacy('password="${X}"ab');
  for (const leading of ['}', ',', ']', ':']) {
    const value = 'password=${X}"' + leading + literal + '"';
    for (const encoded of [value, JSON.stringify(value)]) assert.throws(() => privacy(encoded), refused);
  }
  for (const quote of ['"', "'"]) assert.throws(() => privacy('password=' + quote + '${X}' + quote + literal), refused);
  for (const quote of ['"', "'"]) {
    for (const ending of [quote, '']) {
      const value = 'password=' + quote + '${BUILD_PASSWORD} ' + literal + ending;
      for (const encoded of [value, JSON.stringify(value)]) assert.throws(() => privacy(encoded), refused);
      privacy('password=' + quote + '${BUILD_PASSWORD} ' + ending);
    }
    privacy(JSON.stringify('password=' + quote + '${BUILD_PASSWORD} ' + quote));
    assert.throws(() => privacy('password=' + quote + '${X} ' + quote + literal), refused);
  }
});

test('complete annotated references under quoted credential keys survive native admission and both transfers', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const reference = '${BUILD_PASSWORD}(provided by the environment)';
  for (const [index, value] of [JSON.stringify({ password: reference }), "'password': '" + reference + "'", JSON.stringify({ nested: [{ api_key: reference }] }), JSON.stringify({ config: { note: 'password=${BUILD_PASSWORD}' } }, null, 8)].entries()) {
    privacy(value);
    await remember(value, { ...target.options, kind: 'reference', slug: 'annotated-' + index, forceNew: true });
    const supplied = value.includes(reference) ? reference : '${BUILD_PASSWORD}';
    assert.throws(() => privacy(value.replace(supplied, supplied + literal)), refused);
  }
  for (const to of ['agents-md', 'claude-code'] as const) {
    const directory = join(target.root, to); await exportDir(directory, { ...target.options, to });
    const fresh = await tracker(t);
    assert.equal((await importDir(directory, { ...fresh.options, from: to })).imported, 4);
    assert.deepEqual((await fresh.store.read()).map(row => row.body).sort(), (await target.store.read()).map(row => row.body).sort());
  }
});

test('quoted literal after a reference refuses every entry path without writes while pure twins survive', async t => {
  const target = await tracker(t); const value = 'password=${X}"' + literal + '"';
  const before = await snapshot(target.workspace);
  await assert.rejects(remember(value, { ...target.options, kind: 'reference' }), refused);
  const input = join(target.root, 'adjacent.md'); await writeFile(input, value);
  for (const from of ['agents-md', 'claude-code'] as const) await assert.rejects(importDir(input, { ...target.options, from }), refused);
  const ctx = { command: 'memory remember', pm_root: target.workspace, args: [value], options: { kind: 'reference' }, global: {} } as CommandHandlerContext;
  await assert.rejects(runCommand('remember', ctx), error => {
    assert.ok(isPmCliExpectedError(error)); assert.equal(error.exitCode, 4);
    assert.equal(error.cause, undefined); assert.equal((String(error) + JSON.stringify(error)).includes(literal), false); return true;
  });
  assert.deepEqual(await snapshot(target.workspace), before);
  const safe = await remember('password=${X}', { ...target.options, kind: 'reference', slug: 'pure' });
  for (const to of ['agents-md', 'claude-code'] as const) await exportDir(join(target.root, 'safe-' + to), { ...target.options, to });
  await target.client.update(safe.id, { body: value });
  const retained = await snapshot(target.workspace);
  for (const to of ['agents-md', 'claude-code'] as const) await assert.rejects(exportDir(join(target.root, 'unsafe-' + to), { ...target.options, to }), refused);
  assert.deepEqual(await snapshot(target.workspace), retained);
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

test('cause diagnostics render object values inside aggregate causes', () => {
  // Negative control: a refusal whose aggregate cause holds a plain object must expose that object's text to the no-secret checks.
  const nested = new Error('outer', { cause: new AggregateError([{ detail: literal, inner: { again: literal } }], 'aggregate') });
  assert.ok(causeDiagnostics(nested.cause).includes(literal));
  const cyclic: Record<string, unknown> = { detail: 'public' }; cyclic.self = cyclic;
  assert.ok(causeDiagnostics(new AggregateError([cyclic])).includes('public'));
});
