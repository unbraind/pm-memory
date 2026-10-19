import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activateExtensionForTest, decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { estimatePmOutputTokens } from '@unbrained/pm-cli/sdk';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import extension, { remember } from '../index.ts';
import { runCommand } from '../src/commands.ts';
import { tracker } from './helpers.ts';

/** Install the actual extension entry point in a scratch tracker for host rendering acceptance. */
async function installExtension(workspace: string): Promise<void> {
  const dir = join(workspace, 'extensions', 'pm-memory'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pm-memory', version: '2026.10.19', entry: 'entry.js', capabilities: ['commands', 'schema'] }));
  await writeFile(join(dir, 'entry.js'), `export { default } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};\n`);
}
/** Invoke the genuine CLI host so TOON and JSON are verified as emitted. */
function cli(root: string, workspace: string, args: string[]) {
  return spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'memory', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PM_PATH: workspace, PM_AUTHOR: 'memory-test' } });
}

test('all commands activate and actual host recall/index stay bounded in TOON and JSON', async t => {
  const { options, workspace, root } = await tracker(t); await installExtension(workspace);
  const activation = await activateExtensionForTest(extension, { capabilities: ['commands', 'schema'] }); assert.equal(activation.failed.length, 0);
  const help = cli(root, workspace, ['--help']); assert.equal(help.status, 0, help.stderr);
  for (const command of ['remember', 'recall', 'get', 'index', 'import', 'export', 'verify', 'consolidate']) assert.ok(help.stdout.includes(command));
  const importHelp = cli(root, workspace, ['import', '--help']);
  assert.match(importHelp.stdout, /Read claude-code, agents-md or cursor files/);
  assert.match(importHelp.stdout, /A directory or regular memory file/);
  assert.match(importHelp.stdout, /pm memory import .\/memories --from claude-code/);
  assert.ok(!importHelp.stdout.includes('Extension argument'));
  const first = cli(root, workspace, ['remember', 'Actual native host memory', '--kind', 'project', '--slug', 'host', '--pin', '--why', 'Context matters', '--how', 'Read memory', '--json']); assert.equal(first.status, 0, first.stderr);
  for (const format of [[], ['--json']]) for (const args of [['recall', 'host'], ['index']]) {
    const result = cli(root, workspace, [...args, '--budget', '200', ...format]); assert.equal(result.status, 0, result.stderr);
    const packet = (format.length ? JSON.parse(result.stdout) : decodeToon(result.stdout)) as { complete: boolean; estimated_tokens: number };
    assert.equal(packet.complete, true); assert.ok(estimatePmOutputTokens(Buffer.byteLength(result.stdout)) <= 200);
  }
  const full = cli(root, workspace, ['get', 'host', '--json']); assert.equal(full.status, 0, full.stderr); assert.equal(JSON.parse(full.stdout).body, 'Actual native host memory');
  const ctx = { command: 'memory remember', pm_root: workspace, args: ['New linked instructions'], options: { kind: 'user', slug: 'linked', link: ['host'], why: 'Learned policy', how: 'Apply policy', pin: true, allowEmail: true, forceNew: true }, global: { author: 'memory-test' } } as CommandHandlerContext;
  await runCommand('remember', ctx);
  await runCommand('remember', { ...ctx, args: ['Revised linked instructions'], options: { kind: 'feedback', update: 'linked', link: 'host' } });
  await runCommand('recall', { ...ctx, args: ['instructions'], options: { kind: 'feedback', budget: '300' } });
  await runCommand('recall', { ...ctx, args: ['instructions'], options: {} }); await runCommand('index', { ...ctx, options: {} });
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'sample.md'), '# Imported example\nA standalone reference');
  await runCommand('import', { ...ctx, args: [source], options: { from: 'claude-code', allowEmail: true } });
  await runCommand('export', { ...ctx, args: [join(root, 'export')], options: { to: 'claude-code' } });
  await runCommand('verify', { ...ctx, args: [], options: { root: [root], slug: 'host' } });
  await runCommand('verify', { ...ctx, args: [], options: { root } });
  await runCommand('verify', { ...ctx, args: [], options: {} });
  await runCommand('consolidate', { ...ctx, args: [], options: {} });
  await runCommand('consolidate', { ...ctx, args: [], options: { apply: true, minAgeDays: '60' } });
  await remember('Independent SDK memory', { ...options, kind: 'project' });
});

test('typed refusal exit codes include remedies and sanitize unexpected filesystem failures', async t => {
  const { workspace } = await tracker(t);
  const ctx = { command: 'memory remember', pm_root: workspace, args: [], options: {}, global: {} } as CommandHandlerContext;
  await assert.rejects(runCommand('unknown', ctx), { exitCode: 2 });
  await assert.rejects(runCommand('remember', ctx), { exitCode: 2 });
  await assert.rejects(runCommand('remember', { ...ctx, args: ['token=fake0000000000'], options: { kind: 'project' } }), { exitCode: 4 });
  await runCommand('remember', { ...ctx, args: ['Synthetic remembered fact'], options: { kind: 'user', slug: 'first' } });
  await assert.rejects(runCommand('remember', { ...ctx, args: ['Synthetic remembered fact'], options: { kind: 'user', slug: 'second' } }), { exitCode: 3 });
  await assert.rejects(runCommand('import', { ...ctx, args: ['missing-source'], options: { from: 'claude-code' } }), error => { assert.match(String(error), /Remedy: Check source permissions/); assert.ok(!String(error).includes(workspace)); return true; });
});
