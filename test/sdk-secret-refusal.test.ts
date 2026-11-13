import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExtensionCommandSdk, createPmCliExpectedError, evaluateMutationGuard, isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { runCommand } from '../src/commands.ts';
import { nativeHost } from './native-host-helpers.ts';
import { snapshot, tracker } from './helpers.ts';

const literal = 'SyntheticOnly123!';

/** Inspect every real tracker file, including journals and runtime receipts omitted by snapshots. */
async function assertNoLiteral(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoLiteral(path);
    else if (entry.isFile()) assert.equal((await readFile(path)).includes(Buffer.from(literal)), false);
  }
}

for (const mode of ['remember', 'import', 'aggregate'] as const) test(`SDK secret refusal is privacy-safe through the real ${mode} host path`, async t => {
  const command = mode === 'import' ? 'import' : 'remember';
  const target = await tracker(t); await target.store.register();
  const before = await snapshot(target.workspace); let checks = 0;
  const fact = 'password=${BUILD_PASSWORD}';
  const input = join(target.root, 'sdk-control.md'); await writeFile(input, fact);
  await nativeHost(target.workspace, async client => {
    const ctx = { command: 'memory ' + command, pm_root: target.workspace, args: [command === 'remember' ? fact : input], options: command === 'remember' ? { kind: 'reference', slug: 'sdk-control' } : { from: 'agents-md' }, global: {}, sdk: createExtensionCommandSdk(target.workspace, client) } as CommandHandlerContext;
    await assert.rejects(runCommand(command, ctx), error => {
      assert.ok(isPmCliExpectedError(error));
      assert.equal((inspect(error, { depth: 10 }) + JSON.stringify(error) + String(error)).includes(literal), false);
      assert.equal(error.cause, undefined);
      assert.equal(error.context.code, 'privacy'); assert.equal(error.exitCode, 4);
      assert.deepEqual(error.context.recovery, { attempted_command: 'pm memory ' + command + ' [redacted]', normalized_args: ['memory', command], provided_fields: [] });
      return true;
    });
  }, context => {
    if (context.after?.metadata.memory_slug !== 'sdk-control') return;
    checks++;
    try { evaluateMutationGuard({ author: 'sdk-policy', payload: 'password=' + literal, settings: { require_attributed_author: true, secret_guard: 'block', stale_in_progress_hours: 24 } }); }
    catch (error) {
      assert.ok(isPmCliExpectedError(error)); assert.equal(error.code, 'mutation_secret_guard_blocked');
      Object.defineProperty(error, 'cause', { value: new Error('Synthetic rejected operand ' + literal), configurable: true });
      if (mode === 'aggregate') {
        const peer = new Error('Synthetic cyclic peer'); Object.defineProperty(peer, 'cause', { value: peer });
        throw createPmCliExpectedError('Synthetic operation wrapper', { cause: new AggregateError([error, peer, peer], 'Synthetic aggregate ' + literal) });
      }
      throw error;
    }
    assert.fail('The real SDK must refuse the synthetic literal');
  });
  assert.ok(checks > 0);
  const after = await snapshot(target.workspace);
  if (command === 'remember') assert.deepEqual(after, before);
  for (const bytes of Object.values(after)) assert.equal(Buffer.from(bytes, 'base64').includes(Buffer.from(literal)), false);
  await assertNoLiteral(target.workspace);
  assert.equal((await target.client.listAllComplete()).items.length, 0);
});

test('SDK reference-only policy twin succeeds through the same host guard and command', async t => {
  const target = await tracker(t); let checks = 0;
  const fact = 'password=${BUILD_PASSWORD}';
  await nativeHost(target.workspace, async client => {
    const ctx = { command: 'memory remember', pm_root: target.workspace, args: [fact], options: { kind: 'reference', slug: 'sdk-reference' }, global: {}, sdk: createExtensionCommandSdk(target.workspace, client) } as CommandHandlerContext;
    await runCommand('remember', ctx);
    assert.equal((await target.store.read())[0].body, fact);
  }, context => {
    if (context.after?.metadata.memory_slug !== 'sdk-reference') return;
    checks++;
    assert.deepEqual(evaluateMutationGuard({ author: 'sdk-policy', payload: fact, settings: { require_attributed_author: true, secret_guard: 'block', stale_in_progress_hours: 24 } }).findings, []);
  });
  assert.ok(checks > 0);
});

test('an unrelated SDK refusal with a primitive cause preserves operational error semantics', async t => {
  const target = await tracker(t);
  const refusal = createPmCliExpectedError('Synthetic operational refusal', { cause: 'Synthetic ordinary detail', context: { code: 'synthetic_operation' } });
  await nativeHost(target.workspace, async client => {
    const ctx = { command: 'memory remember', pm_root: target.workspace, args: ['password=${BUILD_PASSWORD}'], options: { kind: 'reference', slug: 'operational' }, global: {}, sdk: createExtensionCommandSdk(target.workspace, client) } as CommandHandlerContext;
    await assert.rejects(runCommand('remember', ctx), error => {
      assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, 'sdk');
      assert.equal(error.exitCode, 2); assert.equal(error.cause, refusal); return true;
    });
  }, context => { if (context.after?.metadata.memory_slug === 'operational') throw refusal; });
});
