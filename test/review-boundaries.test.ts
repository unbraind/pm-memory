import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Linter } from 'eslint';
import type { Rule } from 'eslint';
import type { NewExpression, CallExpression, Node } from 'estree';
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

/** Cause-audit rule: every catch translation into a typed package refusal must retain the caught error and must not re-code an existing typed error. */
function causeAuditRule(): Rule.RuleModule {
  return { create(context: Rule.RuleContext) {
    const check = (node: NewExpression | CallExpression): void => {
      if (node.callee.type !== 'Identifier') return;
      let position: number;
      if (node.type === 'NewExpression' && node.callee.name === 'MemoryError') {
        const category = node.arguments[0];
        // Established re-diagnosis categories re-wrap deliberately; content parsers omit raw syntax errors, which may contain refused input.
        // A variable category is audited like any literal one: only the three exclusions above are exempt.
        if (category?.type === 'Literal' && ['privacy', 'format', 'schema'].includes(String(category.value))) return;
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
      // Refusal helpers are the deliberate merge-domain re-diagnosis: malformed pending receipts fail closed as a
      // merge conflict, with the original cause retained. Only direct typed constructions must additionally rethrow
      // an existing typed error instead of re-coding it; the guard may be a conditional expression that selects the
      // caught typed error, a direct `caught instanceof MemoryError` rethrow, or a negated foreign-type test.
      if (caught === undefined || node.type === 'CallExpression') return;
      const parent = context.sourceCode.getAncestors(node).at(-1);
      const conditional = parent !== undefined && parent.type === 'ConditionalExpression' && parent.alternate === node && parent.test.type === 'BinaryExpression' && parent.test.operator === 'instanceof' && parent.test.left.type === 'Identifier' && parent.test.left.name === caught && parent.test.right.type === 'Identifier' && parent.test.right.name === 'MemoryError' && parent.consequent.type === 'Identifier' && parent.consequent.name === caught;
      // Only known disjoint classes prove that a MemoryError will take the rethrow branch.
      // Error itself includes MemoryError, and an arbitrary constructor may do so too.
      const negatedForeign = (argument: Node): boolean => argument.type === 'BinaryExpression' && argument.operator === 'instanceof' && argument.left.type === 'Identifier' && argument.left.name === caught && argument.right.type === 'Identifier' && ['SyntaxError', 'PmCliError'].includes(argument.right.name);
      const guardTest = (test: Node): boolean => test.type === 'BinaryExpression' && test.operator === 'instanceof' && test.left.type === 'Identifier' && test.left.name === caught && test.right.type === 'Identifier' && test.right.name === 'MemoryError'
        || test.type === 'LogicalExpression' && test.operator === '||' && (guardTest(test.left) || guardTest(test.right))
        || test.type === 'UnaryExpression' && test.operator === '!' && negatedForeign(test.argument);
      const rethrowsTyped = conditional || clause.body.body.some(statement => {
        if (statement.type !== 'IfStatement' || statement.range![1] > node.range![0]) return false;
        if (!guardTest(statement.test)) return false;
        const consequent = statement.consequent;
        const rethrow = consequent.type === 'ThrowStatement' ? consequent : consequent.type === 'BlockStatement' && consequent.body.length === 1 ? consequent.body[0] : undefined;
        const thrown = rethrow?.type === 'ThrowStatement' ? rethrow.argument : undefined;
        return thrown?.type === 'Identifier' && thrown.name === caught;
      });
      if (!rethrowsTyped) context.report({ node, message: 'Operational translation re-codes an existing typed error' });
    };
    return { NewExpression: check, CallExpression: check };
  } };
}
/** Lint one source with the cause audit rule under the package's TypeScript configuration. */
function auditSource(filename: string, source: string) {
  const linter = new Linter();
  return linter.verify(source, [{
    files: ['**/*.ts'],
    languageOptions: { parser, parserOptions: { requireConfigFile: false, babelOptions: { plugins: ['@babel/plugin-syntax-typescript'] } } },
    plugins: { audit: { rules: { cause: causeAuditRule() } } },
    rules: { 'audit/cause': 'error' },
  }], { filename });
}

let translations = 0;

test('every operational catch translation preserves its original cause across package modules', () => {
  for (const file of globSync(['src/**/*.ts', 'scripts/**/*.ts', 'index.ts', 'eslint.config.ts'], { cwd: root })) {
    const messages = auditSource(file, readFileSync(join(root, file), 'utf8'));
    assert.deepEqual(messages, [], file);
  }
  assert.ok(translations >= 16, 'Audit must inspect operational translations throughout the package');
});

test('the cause audit rejects misleading guards and accepts braced rethrows', () => {
  for (const category of ["'transaction'", 'category', "`dynamic-${category}`"]) {
    const wrap = `throw new MemoryError(${category}, 'Typed refusal', 'Remedy', { cause });`;
    for (const body of [
      `${wrap} if (cause instanceof MemoryError) throw cause;`,
      `if (!(cause instanceof Error)) throw cause; ${wrap}`,
      `if (!(cause instanceof UnknownError)) throw cause; ${wrap}`,
      `if (cause instanceof MemoryError) { if (false) throw cause; } ${wrap}`,
    ]) {
      assert.ok(auditSource('synthetic-cause.ts', `try { operation(); } catch (cause) { ${body} }`).some(message => message.message === 'Operational translation re-codes an existing typed error'), body);
    }
    assert.deepEqual(auditSource('synthetic-cause.ts', `try { operation(); } catch (cause) { if (cause instanceof MemoryError) { throw cause; } ${wrap} }`), []);
  }
});

test('removing any direct typed rethrow guard is detected by the package cause audit', () => {
  let mutations = 0;
  for (const file of globSync('src/**/*.ts', { cwd: root })) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(/if \((\w+) instanceof MemoryError\) throw \1;/g)) {
      const mutated = source.slice(0, match.index) + source.slice(match.index + match[0].length);
      assert.ok(auditSource(file, mutated).some(message => message.message === 'Operational translation re-codes an existing typed error'), `${file}:${match.index}`);
      mutations++;
    }
  }
  assert.ok(mutations >= 12, 'Every direct guard added in this review must have a negative control');
});

test('the cause audit reports variable categories, bare catches and typed re-coding, and accepts established exclusions', () => {
  const reported = (source: string): boolean => auditSource('synthetic-cause.ts', source).length > 0;
  // Must-refuse corpus: every gap class reports.
  assert.ok(reported("import { MemoryError } from './core.ts';\nfunction translate(value: string, cause: unknown) { try { JSON.parse(value); } catch (cause) { throw new MemoryError(value, 'Typed refusal', 'Remedy'); } }"), 'A variable category without cause retention must report');
  assert.ok(reported("import { MemoryError } from './core.ts';\nfunction translate(value: string) { try { JSON.parse(value); } catch (cause) { throw new MemoryError(value, 'Typed refusal', 'Remedy', { cause }); } }"), 'A variable category without a typed rethrow guard must report');
  assert.ok(reported("import { MemoryError } from './core.ts';\nfunction translate() { try { JSON.parse('{'); } catch (cause) { throw new MemoryError('transaction', 'Typed refusal', 'Remedy', { cause }); } }"), 'A literal category without a typed rethrow guard must report');
  assert.ok(reported("import { MemoryError } from './core.ts';\nfunction translate() { try { JSON.parse('{'); } catch { throw new MemoryError('transaction', 'Typed refusal', 'Remedy'); } }"), 'A bare catch cannot retain the caught error and must report');
  assert.ok(reported("import { MemoryError } from './core.ts';\nfunction refusal(source: string): MemoryError { throw new MemoryError('conflict', 'Typed refusal', 'Remedy'); }\nfunction translate(source: string) { try { JSON.parse('{'); } catch (cause) { throw refusal(source); } }"), 'A refusal translation without cause retention must report');
  // Must-allow corpus: guarded, cause-retaining translations and the established re-diagnosis exclusions stay silent.
  assert.equal(reported("import { MemoryError } from './core.ts';\nfunction refusal(source: string, cause: unknown): MemoryError { throw new MemoryError('conflict', 'Typed refusal', 'Remedy', { cause }); }\nfunction translate(source: string) { try { JSON.parse('{'); } catch (cause) { throw refusal(source, { cause }); } }"), false, 'A deliberate refusal re-diagnosis with cause retained must stay silent');
  assert.equal(reported("import { MemoryError } from './core.ts';\nfunction translate(value: string) { try { JSON.parse(value); } catch (cause) { if (cause instanceof MemoryError) throw cause; throw new MemoryError(value, 'Typed refusal', 'Remedy', { cause }); } }"), false, 'A guarded variable-category translation with cause must stay silent');
  assert.equal(reported("import { MemoryError } from './core.ts';\nfunction translate() { try { JSON.parse('{'); } catch (cause) { if (cause instanceof MemoryError) throw cause; throw new MemoryError('transaction', 'Typed refusal', 'Remedy', { cause }); } }"), false, 'A guarded literal-category translation with cause must stay silent');
  assert.equal(reported("import { MemoryError } from './core.ts';\nfunction refusal(source: string, cause?: ErrorOptions): MemoryError { throw new MemoryError('conflict', 'Typed refusal', 'Remedy', cause); }\nfunction translate(source: string) { try { JSON.parse('{'); } catch (cause) { if (cause instanceof MemoryError) throw cause; throw refusal(source, { cause }); } }"), false, 'A guarded refusal translation with cause must stay silent');
  assert.equal(reported("import { MemoryError } from './core.ts';\nfunction translate() { try { JSON.parse('{'); } catch (error) { const refusal = error instanceof MemoryError ? error : new MemoryError('sdk', 'Typed refusal', 'Remedy', { cause: error }); throw refusal; } }"), false, 'A conditional guard that selects the caught typed error must stay silent');
  assert.equal(reported("import { MemoryError } from './core.ts';\nfunction translate() { try { JSON.parse('{'); } catch (error) { if (!(error instanceof SyntaxError) || error.message !== 'conflict') throw error; throw new MemoryError('conflict', 'Typed refusal', 'Remedy', { cause: error }); } }"), false, 'A negated foreign-type guard that rethrows the caught error must stay silent');
  for (const category of ['privacy', 'format', 'schema']) {
    assert.equal(reported(`import { MemoryError } from './core.ts';\nfunction translate() { try { JSON.parse('{'); } catch { throw new MemoryError('${category}', 'Established re-diagnosis', 'Remedy'); } }`), false, `The established ${category} exclusion must stay silent`);
  }
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
