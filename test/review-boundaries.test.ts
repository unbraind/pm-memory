import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Linter } from 'eslint';
import type { Rule } from 'eslint';
import type { NewExpression, CallExpression } from 'estree';
import parser from '@babel/eslint-parser';
import { readItemTransaction, readWorkspaceTransaction } from '@unbrained/pm-cli/sdk';
import { MemoryError } from '../src/core.ts';
import { importIdentity, planError } from '../src/portable-plan.ts';
import { readTrackerOrigin } from '../src/portable-origin.ts';
import { copyPreviewFile } from '../src/portable-preview.ts';
import { tracker, snapshot, withoutGit } from './helpers.ts';

const root = resolve(import.meta.dirname, '..');

/** Follow static imports so the default discovery contract covers helper transitivity too. */
function dependencies(files: string[]): Set<string> {
  const seen = new Set<string>();
  for (let file; (file = files.pop()) !== undefined;) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = parser.parse(readFileSync(file, 'utf8'), { requireConfigFile: false, babelOptions: { plugins: ['@babel/plugin-syntax-typescript'] }, sourceType: 'module' });
    for (const statement of source.body) {
      if (statement.type !== 'ImportDeclaration' || typeof statement.source.value !== 'string') continue;
      const specifier = statement.source.value;
      if (specifier.startsWith('.') && specifier.endsWith('.ts')) files.push(resolve(dirname(file), specifier));
    }
  }
  return seen;
}

test('default test and coverage discovery exclude every packed consumer and retain install acceptance', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string>; coverageGate: { tests: string[] } };
  const ordinary = [...globSync('test/*.test.ts', { cwd: root })].map(file => join(root, file));
  const covered = [...globSync(manifest.coverageGate.tests, { cwd: root })].map(file => join(root, file));
  assert.match(manifest.scripts.test, /test\/\*\.test\.ts/);
  const imports = dependencies([...ordinary, ...covered]);
  assert.equal(imports.has(join(root, 'test/consumer-helpers.ts')), false, 'Packed consumers require the explicit installation gate');
  for (const file of globSync('test/*consumer*.acceptance.ts', { cwd: root })) {
    assert.ok(manifest.scripts['test:install'].includes(file), `${file} must remain required by the release gate`);
  }
  assert.ok(manifest.scripts['test:install'].includes('test/install.acceptance.ts'));
  assert.ok(manifest.scripts['release:check'].includes('npm run test:install'));
});

test('every operational catch translation preserves its original cause across package modules', () => {
  let translations = 0;
  const linter = new Linter();
  for (const file of globSync('src/**/*.ts', { cwd: root })) {
    const messages = linter.verify(readFileSync(join(root, file), 'utf8'), [{
      files: ['**/*.ts'],
      languageOptions: { parser, parserOptions: { requireConfigFile: false, babelOptions: { plugins: ['@babel/plugin-syntax-typescript'] } } },
      plugins: { audit: { rules: { cause: { create(context: Rule.RuleContext) {
        const check = (node: NewExpression | CallExpression): void => {
          if (node.callee.type !== 'Identifier') return;
          let position: number;
          if (node.type === 'NewExpression' && node.callee.name === 'MemoryError') {
            const category = node.arguments[0];
            // Content parsers omit raw syntax errors, which may contain refused input.
            if (category?.type !== 'Literal' || ['privacy', 'format', 'schema'].includes(String(category.value))) return;
            position = 3;
          } else if (node.type === 'CallExpression' && node.callee.name === 'refusal') position = 1;
          else return;
          const clause = context.sourceCode.getAncestors(node).reverse().find(parent => parent.type === 'CatchClause');
          if (clause?.type !== 'CatchClause') return;
          translations++;
          const caught = clause.param?.type === 'Identifier' ? clause.param.name : undefined;
          const options = node.arguments[position];
          const retained = caught !== undefined && options?.type === 'ObjectExpression' && options.properties.some(property => property.type === 'Property' && property.key.type === 'Identifier' && property.key.name === 'cause' && property.value.type === 'Identifier' && property.value.name === caught);
          if (!retained) context.report({ node, message: 'Operational translation loses the caught error' });
        };
        return { NewExpression: check, CallExpression: check };
      } } } } },
      rules: { 'audit/cause': 'error' },
    }], { filename: file });
    assert.deepEqual(messages, [], file);
  }
  assert.ok(translations >= 16, 'Audit must inspect operational translations throughout the package');
});

test('domain causes preserve arbitrary thrown values without entering serialized diagnostics', () => {
  for (const cause of [new MemoryError('transaction', 'Typed SDK failure', 'Retry safely'), new Error('Synthetic private detail'), new AggregateError([], 'Multiple failures'), { detail: 'Synthetic private detail' }, 'Synthetic private detail', null, undefined, 0]) {
    const failure = new MemoryError('transaction', 'Safe public message', 'Safe public remedy', { cause });
    assert.equal(failure.cause, cause);
    assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable, false);
    assert.equal(JSON.stringify(failure).includes('Synthetic private detail'), false);
    assert.throws(() => planError(cause), error => {
      if (cause instanceof MemoryError) return error === cause;
      assert.ok(error instanceof MemoryError); assert.equal(error.cause, cause);
      assert.equal(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable, false);
      return true;
    });
  }
});

test('all namespace readers retain typed SDK errors and leave malformed non-git receipts intact', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const input = 'cause-controls'; const candidate = 'stable-cause';
  const identity = await importIdentity(target.store, input, candidate);
  const directory = join(target.workspace, 'transactions', 'sdk'); await mkdir(directory, { recursive: true });
  for (const suffix of ['', '-nodes', '-snapshot']) {
    const id = identity.transactionId + suffix; const path = join(directory, id + '.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 999 }));
    const before = await snapshot(target.workspace);
    let original: Error | undefined;
    const reader = suffix === '-snapshot' ? readWorkspaceTransaction : readItemTransaction;
    await assert.rejects(reader(target.workspace, id), error => { assert.ok(error instanceof Error); original = error; return true; });
    await assert.rejects(importIdentity(target.store, input, candidate), error => {
      assert.ok(error instanceof MemoryError && error.code === 'transaction');
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.constructor, original!.constructor);
      assert.equal(error.cause.message, original!.message);
      assert.equal(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable, false);
      return true;
    });
    assert.deepEqual(await snapshot(target.workspace), before);
    // Leave a missing receipt for the next reader, confined to this temporary fixture.
    await rm(path);
  }
});

test('origin and preview operational failures retain their filesystem or parsing cause', async t => {
  const target = await tracker(t); withoutGit(t, target.root);
  const origin = join(target.workspace, 'memory-origin.json'); await writeFile(origin, 'not-json');
  await assert.rejects(readTrackerOrigin(target.store), error => error instanceof MemoryError && error.cause instanceof SyntaxError);
  const source = join(target.root, 'preview-link'); await symlink(origin, source);
  await assert.rejects(copyPreviewFile(source, join(target.root, 'output')), error => error instanceof MemoryError && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ELOOP');
  assert.equal(await readFile(origin, 'utf8'), 'not-json');
});
