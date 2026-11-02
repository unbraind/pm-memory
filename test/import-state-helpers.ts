import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportDir, importDir, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { tracker } from './helpers.ts';

/** Exercise source text, companion snapshots and canonical payload edits through their public entry point. */
export async function sourceFixture(t: Parameters<typeof tracker>[0], mode: 'raw' | 'companion' | 'policy', initial?: string) {
  const target = await tracker(t); const original = initial ?? '---\nname: alpha\ndescription: Original hook\ntype: feedback\ncustom: retained\n---\n# Alpha\nOriginal content\n**Why:** Original evidence\n**How to apply:** Obsolete instructions\n';
  const raw = join(target.root, 'raw'); await mkdir(raw); await writeFile(join(raw, 'alpha.md'), original);
  await writeFile(join(raw, 'MEMORY.md'), '- [Alpha](alpha.md)\n');
  await importDir(raw, { ...target.options, from: 'claude-code' });
  const path = mode === 'raw' ? raw : join(target.root, mode);
  if (mode !== 'raw') await exportDir(path, { ...target.options, to: mode === 'policy' ? 'agents-md' : 'claude-code' });
  const from = mode === 'policy' ? 'agents-md' : 'claude-code';
  const id = (await target.client.listAllComplete()).items.find(item => item.memory_slug === 'alpha')!.id;
  let file = join(path, 'alpha.md'); let marker = '';
  if (mode === 'policy') {
    const manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    file = join(path, manifest.guidance.find(row => row.slug === 'alpha')!.path);
    const bytes = await readFile(file, 'utf8'); marker = bytes.slice(0, bytes.indexOf('\n') + 1);
  }
  return { ...target, id, path, from: from as 'agents-md' | 'claude-code', file, marker };
}
