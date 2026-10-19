import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { TestContext } from 'node:test';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { Store } from '../src/store.ts';

/** Initialize a real tracker and register cleanup before any mutations. */
export async function tracker(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'memory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, '.agents', 'pm');
  const client = new PmClient({ cwd: root, pmRoot: workspace, author: 'memory-test', noExtensions: true });
  await client.init('memory-test', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const options = { workspace, author: 'memory-test' }; const store = new Store(options);
  return { root, workspace, client, options, store };
}
/** Snapshot durable tracker bytes while excluding disposable caches and locks. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  /** Collect durable files recursively from the bounded test tracker. */
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['runtime', 'locks', 'search', 'transactions', 'checkpoints'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path); else result[relative(root, path)] = (await readFile(path)).toString('base64');
    }
  }
  await walk(root); return result;
}
