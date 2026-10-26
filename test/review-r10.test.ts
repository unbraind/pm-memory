import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMutationReceipt } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, verify, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { tracker, snapshot } from './helpers.ts';

test('generated exports link only emitted facts across both harnesses', async t => {
  const { root, options, store, client } = await tracker(t);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'MEMORY.md'), '# Imported index\n');
  await importDir(source, { ...options, from: 'claude-code' });
  const artifact = (await store.read())[0];
  const active = await remember('Active deployment guidance', { ...options, kind: 'project', slug: 'active' });
  const archived = await remember('Archived historical context', { ...options, kind: 'reference', slug: 'archived' });
  const native = parseMutationReceipt(await client.run('create', { options: { title: 'Unrelated native task', type: 'Task' } }));
  await remember('Source relationship guidance', { ...options, kind: 'feedback', slug: 'source', links: [active.id, archived.id, artifact.id, native.id] });
  await client.update(archived.id, { status: 'canceled', closeReason: 'Synthetic archive' });
  await store.fields(artifact.id, { edited: true });
  const before = await snapshot(options.workspace);
  for (const to of ['claude-code', 'agents-md'] as const) {
    const output = join(root, to);
    await exportDir(output, { ...options, to });
    const manifest = JSON.parse(await readFile(join(output, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
    assert.deepEqual(manifest.guidance.find(row => row.slug === 'source')!.relationships.map(edge => edge.slug), ['active']);
    assert.deepEqual(manifest.guidance.map(row => row.slug).sort(), ['active', 'source']);
    const next = await tracker(t);
    assert.equal((await importDir(output, { ...next.options, from: to })).unresolved_links, 0);
  }
  assert.deepEqual(await snapshot(options.workspace), before);
});

test('preserved and revised source references resolve inside the emitted directory', async t => {
  const { root, options, store, client } = await tracker(t);
  const source = join(root, 'source'); await mkdir(source);
  const files = {
    'MEMORY.md': '- [Source](source.md)\n- [Target](target-file.md)\n- [Stable](stable.md)\n',
    'source.md': 'See [[target]], [[target-file]], [[memory]], [[absent]] and [[stable]].\n',
    'target-file.md': '---\nname: target\n---\nTarget instructions\n',
    'stable.md': 'Stable guidance\n',
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(source, name), bytes);
  await importDir(source, { ...options, from: 'claude-code' });
  const rows = await store.read(); const target = rows.find(row => row.slug === 'target')!;
  await client.update(target.id, { status: 'canceled', closeReason: 'Synthetic archive' });
  const output = join(root, 'output');
  const exported = await exportDir(output, { ...options, to: 'claude-code' });
  exported.omitted_links?.sort((a, b) => a.reason.localeCompare(b.reason));
  assert.deepEqual(exported, {
    exported: 4, byte_preserved: 0,
    omitted_links: [
      { slug: 'source', target: rows.find(row => row.artifact)!.id, kind: 'related', reason: 'artifact' },
      { slug: 'source', target: target.id, kind: 'related', reason: 'canceled' },
    ],
  });
  assert.equal((await readFile(join(output, 'memories/source.md'), 'utf8')).split('\n').slice(1).join('\n'), rows.find(row => row.slug === 'source')!.body);
  assert.match(await readFile(join(output, 'memories/stable.md'), 'utf8'), /Stable guidance/);
  assert.doesNotMatch(await readFile(join(output, 'MEMORY.md'), 'utf8'), /\]\(target-file\.md\)/);
  const next = await tracker(t);
  assert.equal((await importDir(output, { ...next.options, from: 'claude-code' })).unresolved_links, 0);
  await remember('Revised target content', { ...options, kind: 'reference', update: 'target' });
  const revised = join(root, 'revised'); await exportDir(revised, { ...options, to: 'claude-code' });
  assert.match(await readFile(join(revised, 'memories/source.md'), 'utf8'), /\[\[target\]\], \[\[target-file\]\]/);
  const last = await tracker(t);
  assert.equal((await importDir(revised, { ...last.options, from: 'claude-code' })).unresolved_links, 0);
});

test('SDK documentation includes the complete verify return contract', async t => {
  const { options, root } = await tracker(t);
  const result = await verify({ ...options, root });
  assert.deepEqual(Object.keys(result).sort(), ['checked', 'results', 'skipped', 'stale']);
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const contract = readme.slice(readme.indexOf('## SDK\n'), readme.indexOf('Embedded SDK clients'));
  assert.match(contract, /`verify\(options\)` returns checked\/stale counts, `skipped: string\[\]` containing slugs for snapshots changed or archived during verification, and per-memory claim results/);
});


test('export removes ambiguous aliases and refuses colliding re-imported keys before publication', async t => {
  const { root, options } = await tracker(t);
  const source = join(root, 'aliases'); await mkdir(source);
  await writeFile(join(source, '!alias!.md'), '---\nname: first\n---\nFirst fact\n');
  await writeFile(join(source, 'alias.md'), '---\nname: second\n---\nSecond fact\n');
  await writeFile(join(source, 'source.md'), 'See [[alias]], [[first]] and [[front]].\n');
  const front = '---\nname: "[[absent]]"\ndescription: "[[absent]]"\n---\nSee [[first]] and [[absent]].\n';
  await writeFile(join(source, 'front.md'), front);
  await importDir(source, { ...options, from: 'claude-code' });
  const output = join(root, 'resolved'); await exportDir(output, { ...options, to: 'claude-code' });
  assert.match(await readFile(join(output, 'memories/source.md'), 'utf8'), /See \[\[alias\]\], \[\[first\]\] and \[\[front\]\]/);
  assert.match(await readFile(join(output, 'memories/front.md'), 'utf8'), /See \[\[first\]\] and \[\[absent\]\]/);
  const next = await tracker(t);
  assert.equal((await importDir(output, { ...next.options, from: 'claude-code' })).unresolved_links, 0);
  const collision = await tracker(t);
  const file = join(collision.root, 'retained.md');
  await writeFile(file, '---\nname: memories-native\n---\nImported fact\n');
  await importDir(file, { ...collision.options, from: 'agents-md' });
  await remember('Native guidance', { ...collision.options, kind: 'project', slug: 'native' });
  const outputPath = join(collision.root, 'namespaced');
  await exportDir(outputPath, { ...collision.options, to: 'agents-md' });
  const manifest = JSON.parse(await readFile(join(outputPath, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  assert.deepEqual(manifest.guidance.map(row => row.path).sort(), ['memories/memories-native.md', 'memories/native.md']);
});
