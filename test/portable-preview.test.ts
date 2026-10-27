import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, readFile, readlink, symlink, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { remember, importDir, MemoryError } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { copyPreviewFile, hasPreviewPackages } from '../src/portable-preview.ts';
import { tracker, exportedPolicy } from './helpers.ts';

/** One native edit with unknown native edges and an installed foreign dependency link. */
async function projectionScenario(t: Parameters<typeof tracker>[0]) {
  const target = await tracker(t);
  const alpha = await remember('Alpha A', { ...target.options, slug: 'alpha', kind: 'reference' });
  await remember('Beta A', { ...target.options, slug: 'beta', kind: 'reference' });
  const task = (await target.client.create({ title: 'Foreign native task', body: 'Native body' })).item;
  await target.store.link(alpha.id, task.id);
  const { path, manifest } = await exportedPolicy(target);
  const row = manifest.guidance.find(row => row.slug === 'alpha')!;
  await writeFile(join(path, row.path), policyBody(row, 'Harness B'));
  assert.equal(await hasPreviewPackages(target.workspace), false);
  const bin = join(target.workspace, 'extensions', 'foreign', 'node_modules', '.bin'); await mkdir(bin, { recursive: true });
  const link = join(bin, 'yaml'); await symlink('missing-package-entry', link);
  return { target, alpha, task, path, link, row };
}

test('SDK preview ignores foreign installed code while retaining native fields and references', async t => {
  const { target, alpha, task, path, link, row } = await projectionScenario(t);
  const before = (await target.client.get(task.id, { full: true })).item;
  const steps: string[] = [];
  const result = await importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step.startsWith('preview-')) steps.push(step); } });
  assert.equal(result.updated, 1); assert.ok(steps.length >= 13);
  const actual = (await target.client.get(alpha.id, { full: true })).item;
  assert.equal(actual.body, 'Harness B'); assert.equal(actual.dependencies![0].id, task.id);
  assert.deepEqual((await target.client.get(task.id, { full: true })).item, before);
  assert.equal(await readlink(link), 'missing-package-entry');
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 2);
  await rm(join(target.workspace, 'extensions', 'foreign'), { recursive: true });
  await writeFile(join(path, row.path), policyBody(row, 'Harness C'));
  let projected = false;
  assert.equal((await importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step.startsWith('preview-')) projected = true; } })).updated, 1);
  assert.equal(projected, false); assert.equal((await target.client.get(alpha.id, { full: true })).item.body, 'Harness C');
  assert.deepEqual((await target.client.get(task.id, { full: true })).item, before);
});

test('preview projection admits fresh creations without adopting foreign package files', async t => {
  const { path } = await projectionScenario(t); const fresh = await tracker(t);
  const extensions = join(fresh.workspace, 'extensions'); await rm(extensions, { recursive: true, force: true });
  await writeFile(extensions, 'Foreign package state');
  assert.equal(await hasPreviewPackages(fresh.workspace), true);
  assert.equal((await importDir(path, { ...fresh.options, from: 'agents-md' })).imported, 2);
  assert.equal(await readFile(extensions, 'utf8'), 'Foreign package state');
  assert.equal((await fresh.client.listAllComplete()).items.length, 2);
});

/** Enumerate the public injection boundaries from an actual SDK projection. */
async function projectionBoundaries(t: Parameters<typeof tracker>[0]): Promise<number> {
  const scenario = await projectionScenario(t); let count = 0;
  await importDir(scenario.path, { ...scenario.target.options, from: 'agents-md', onStep: step => { if (step.startsWith('preview-')) count++; } });
  assert.ok(count >= 13); return count;
}

test('every private preview write boundary is crash safe and a retry converges once', async t => {
  const count = await projectionBoundaries(t);
  for (let boundary = 0; boundary < count; boundary++) {
    const { target, path, link } = await projectionScenario(t); const before = (await target.client.listAllComplete({ includeBody: true })).items;
    let index = 0; let crashed = false;
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => {
      if (step.startsWith('preview-') && index++ === boundary) { crashed = true; throw new WorkspaceTransactionInterruptedError(); }
    } }), WorkspaceTransactionInterruptedError);
    assert.equal(crashed, true); assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
    assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).updated, 1);
    assert.equal((await importDir(path, { ...target.options, from: 'agents-md' })).unchanged, 2);
    assert.equal((await target.client.listAllComplete()).items.length, 3); assert.equal(await readlink(link), 'missing-package-entry');
  }
});

test('native edits at every projection boundary win over frozen preview inputs', async t => {
  const count = await projectionBoundaries(t);
  for (let boundary = 0; boundary < count; boundary++) {
    const { target, alpha, task, path } = await projectionScenario(t); let index = 0; let injected = false;
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
      if (step.startsWith('preview-') && index++ === boundary) {
        await target.client.update(alpha.id, { body: 'Peer C', author: 'peer-agent' }); injected = true;
      }
    } }), error => error instanceof MemoryError);
    assert.equal(injected, true);
    const result = await importDir(path, { ...target.options, from: 'agents-md' });
    assert.ok('skipped' in result && result.skipped.some(row => row.reason.includes('Independently edited')));
    const actual = (await target.client.get(alpha.id, { full: true })).item;
    assert.equal(actual.body, 'Peer C'); assert.equal(actual.dependencies![0].id, task.id);
    assert.equal((await target.client.listAllComplete()).items.length, 3);
  }
});

test('projection refuses peers deleting a target before or after SDK location', async t => {
  for (const when of ['listed', 'located']) {
    const { target, alpha, path } = await projectionScenario(t); let injected = false;
    const before = (await target.client.listAllComplete({ includeBody: true })).items.filter(row => row.id !== alpha.id);
    await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: async step => {
      if (step !== (when === 'listed' ? 'preview-listed' : `preview-located:${alpha.id}`)) return;
      await target.client.run('delete', { id: alpha.id, options: { force: true } }); injected = true;
    } }), error => error instanceof MemoryError && error.code === 'conflict');
    assert.equal(injected, true); assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
  }
});

test('projection copies exact owned bytes while refusing nonregular native sources', async t => {
  const target = await tracker(t); const source = join(target.root, 'source'); const destination = join(target.root, 'copied', 'bytes');
  assert.equal(await copyPreviewFile(source, destination), false);
  await writeFile(source, Buffer.from([0, 255, 1, 10])); assert.equal(await copyPreviewFile(source, destination), true);
  assert.deepEqual(await readFile(destination), await readFile(source));
  const directory = join(target.root, 'directory'); await mkdir(directory);
  await assert.rejects(copyPreviewFile(directory, destination), error => error instanceof MemoryError && error.code === 'history');
  const link = join(target.root, 'source-link'); await symlink('source', link);
  await assert.rejects(copyPreviewFile(link, destination), error => error instanceof MemoryError && error.code === 'history');
  const packages = join(target.workspace, 'extensions'); await rm(packages, { recursive: true, force: true });
  assert.equal(await hasPreviewPackages(target.workspace), false);
  await mkdir(packages); await chmod(packages, 0);
  try { assert.equal(await hasPreviewPackages(target.workspace), true); }
  finally { await chmod(packages, 0o700); }
  assert.equal(await hasPreviewPackages(target.workspace), false);
});
