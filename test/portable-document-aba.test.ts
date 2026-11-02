import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importDir, exportDir, remember, MemoryError, LEGACY_ORIGINS } from '../index.ts';
import { encodeDocument } from '../src/portable-source.ts';
import { nativeState } from '../src/native-revision.ts';
import { exportedPolicy, tracker, snapshot } from './helpers.ts';

for (const adapter of ['raw', 'companion', 'policy'] as const) for (const boundary of ['before-planning', 'read'] as const) test(`document ABA refuses ${adapter} replacement ${boundary}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T00:00:00.000Z') });
  const target = await tracker(t); const file = join(target.root, 'AGENTS.md');
  const original = '---\nname: alpha\ncustom: A\n---\nAlpha body';
  await writeFile(file, original); await importDir(file, { ...target.options, from: 'agents-md' });
  const memory = (await target.store.read())[0]; const saved = await nativeState(target.store, memory.id);
  let input = file;
  if (adapter === 'policy') {
    await remember('Native policy mode', { ...target.options, slug: 'beta', kind: 'reference', forceNew: true });
    const exported = await exportedPolicy(target, 'editable'); input = exported.path;
    const row = exported.manifest.guidance.find(row => row.slug === 'alpha')!; const path = join(input, row.path);
    const bytes = await readFile(path, 'utf8');
    await writeFile(path, bytes.slice(0, bytes.indexOf('\n') + 1) + original.replace('custom: A', 'custom: B'));
  } else if (adapter === 'companion') {
    input = join(target.root, 'companion'); await exportDir(input, { ...target.options, to: 'agents-md' });
    assert.ok((await readFile(join(input, LEGACY_ORIGINS))).length > 0);
    await writeFile(join(input, 'AGENTS.md'), original.replace('custom: A', 'custom: B'));
  } else await writeFile(file, original.replace('custom: A', 'custom: B'));
  let injected = 0; let retained: Record<string, string> | undefined;
  const edit = async () => {
    injected++;
    await target.client.run('update', { id: memory.id, options: { memoryDocument: encodeDocument({ ...memory.document!, original: Buffer.from(original.replace('custom: A', 'custom: native C')).toString('base64') }) } });
    await target.client.run('update', { id: memory.id, options: { memoryDocument: encodeDocument(memory.document!) } });
    const restored = await nativeState(target.store, memory.id);
    assert.equal(restored.proof.hash, saved.proof.hash);
    assert.equal(restored.proof.length, saved.proof.length + 2);
    retained = await snapshot(target.workspace);
  };
  if (boundary === 'before-planning') await edit();
  const outcome = await importDir(input, { ...target.options, from: 'agents-md', onStep: async step => { if (boundary === 'read' && step === 'read') await edit(); } }).catch(error => {
    assert.ok(error instanceof MemoryError && error.code === 'conflict'); return undefined;
  });
  assert.equal(injected, 1);
  if (outcome !== undefined) { assert.equal(outcome.updated, 0); assert.ok('skipped' in outcome && outcome.skipped.some(row => row.conflict?.fields.includes('document'))); }
  assert.deepEqual(await snapshot(target.workspace), retained);
});
