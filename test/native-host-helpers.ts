import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { PmClient, runWithActiveExtensions, setActiveExtensionHooks } from '@unbrained/pm-cli/sdk';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import { defineExtension } from '@unbrained/pm-cli/sdk/authoring';
import type { BeforeMutationHook, ExtensionHookRegistry } from '@unbrained/pm-cli/sdk/authoring';
import extension, { remember } from '../index.ts';
import { nativeState, commitNativeFields } from '../src/native-revision.ts';
import type { NativeProof } from '../src/native-revision.ts';
import { Store } from '../src/store.ts';
import type { MemoryOptions } from '../src/types.ts';
import { tracker } from './helpers.ts';

/** Run real host clients under SDK-activated memory and independent policy hooks. */
export async function nativeHost<T>(workspace: string, run: (client: PmClient, hooks: ExtensionHookRegistry) => Promise<T>, policy: BeforeMutationHook = () => {}) {
  const memory = await createExtensionTestHarness(extension, { capabilities: ['commands', 'schema', 'hooks'] });
  const peer = await createExtensionTestHarness(defineExtension({ name: 'test-native-policy', version: '1.0.0', activate(api) { api.hooks.beforeMutation(policy); } }), { capabilities: ['hooks'] });
  const hooks = { ...memory.activation.hooks, beforeMutation: [...peer.activation.hooks.beforeMutation, ...memory.activation.hooks.beforeMutation] };
  return runWithActiveExtensions({ path: workspace, noExtensions: true }, async () => {
    setActiveExtensionHooks(hooks);
    return run(PmClient.forActiveExtensionHost({ pmRoot: workspace, author: 'host-fallback' }), hooks);
  });
}

/** Write through an independent genuine SDK process at the saved native timestamp, optionally restoring every document byte. */
export function nativePeer(target: { id: string; workspace: string; root: string }, version: string, restore?: string): Record<string, unknown> {
  const script = "import { mock } from 'node:test'; import { PmClient } from '@unbrained/pm-cli/sdk'; mock.timers.enable({apis:['Date'],now:Date.parse(process.argv[4])}); const client = new PmClient({cwd:process.argv[3],pmRoot:process.argv[2],author:'native-peer',noExtensions:true}); await client.update(process.argv[1],{body:'Native C'}); if(process.argv[5]==='aba') await client.update(process.argv[1],{body:process.argv[6]}); console.log(JSON.stringify((await client.get(process.argv[1],{full:true})).item));";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, target.id, target.workspace, target.root, version, restore === undefined ? 'edit' : 'aba', restore ?? ''], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: target.root, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.status, 0, result.stderr);
  const item = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(item.updated_at, version, 'force an independent native timestamp collision at the SDK publication boundary');
  return item;
}

/** Capture genuine SDK evidence shared by default-path and host-path regression controls. */
export async function nativeFixture(t: Parameters<typeof tracker>[0]) {
  const target = await tracker(t);
  const item = await remember('Original A', { ...target.options, slug: 'alpha', kind: 'reference' });
  return { ...target, id: item.id, saved: await nativeState(target.store, item.id) };
}

/** Exercise the real injected host dispatcher while retaining the package writer lease. */
export function hostPublication(target: { id: string; options: MemoryOptions }, proof: NativeProof, fields: Record<string, unknown>): Promise<boolean> {
  return nativeHost(target.options.workspace, async client => {
    const store = new Store({ ...target.options, client });
    return store.write(() => commitNativeFields(store, target.id, proof, fields));
  });
}
