import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { PmClient, itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, POLICY_MANIFEST } from '../index.ts';
import type { PortableExportResult, PortablePolicyManifest } from '../index.ts';
import { tracker } from './helpers.ts';

const MASTER = 0x13631d07;
const START = Number(process.env.PM_MEMORY_FIDELITY_START);
const COUNT = Number(process.env.PM_MEMORY_FIDELITY_COUNT);
assert.ok(Number.isInteger(START) && START >= 0 && START < 500);
assert.ok(Number.isInteger(COUNT) && COUNT > 0 && COUNT <= 25 && START + COUNT <= 500);
type Rows = Awaited<ReturnType<PmClient['listAllComplete']>>['items'];
/** Fresh-state oracle has no importer, ownership, hashing or normalization dependency. */
function semantic(rows: Rows, receipt: PortableExportResult) {
  const all = rows.filter(row => row.memory_slug !== undefined && row.status !== 'canceled');
  const included = all.filter(row => !(row.memory_artifact === true && receipt.byte_preserved === 0));
  return all.flatMap(row => {
    if (row.memory_artifact === true && receipt.byte_preserved === 0) {
      const fields = receipt.lossy?.find(entry => entry.slug === row.memory_slug)?.fields;
      assert.deepEqual(fields, ['slug', 'title', 'description', 'body', 'kind', 'why', 'how', 'pinned', 'tags', 'relationships', 'artifact', ...(row.memory_document === undefined ? [] : ['document'])], 'Unreported native artifact omission');
      return [];
    }
    const lossy = receipt.lossy?.find(entry => entry.slug === row.memory_slug)?.fields ?? [];
    const relationships = (row.dependencies ?? []).flatMap(edge => {
      const target = included.find(target => target.id === edge.id);
      if (target === undefined) { assert.ok(lossy.includes('relationships'), `Unreported missing edge: ${row.memory_slug}`); return []; }
      const value = { ...edge, id: target.memory_slug };
      if (lossy.includes('relationships.author_source')) delete value.author_source;
      return [value];
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [{ slug: row.memory_slug, title: row.title, description: row.description, body: row.body, kind: row.memory_kind, why: row.memory_why, how: row.memory_how, pinned: row.memory_pinned, tags: row.tags, artifact: row.memory_artifact, relationships }];
  }).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}
/** Copy only native tracker data, never live leases or runtime state. */
async function copyTracker(from: string, to: string) {
  await cp(from, to, { recursive: true, filter: path => !['runtime', 'locks', 'search', 'checkpoints'].includes(relative(from, path).split('/')[0]) });
}

test(`fidelity sequences ${START}-${START + COUNT - 1}`, { timeout: 600000 }, async t => {
  const base = await tracker(t); const empty = await tracker(t); await empty.store.register();
  const raw = join(base.root, 'raw'); await mkdir(raw);
  await writeFile(join(raw, 'MEMORY.md'), '- [Alpha](alpha.md)\n- [Beta](beta.md)\n');
  await writeFile(join(raw, 'alpha.md'), '# Alpha\nSee [[beta]]'); await writeFile(join(raw, 'beta.md'), '# Beta\nReference');
  await importDir(raw, { ...base.options, from: 'claude-code' });
  const agentBase = await tracker(t); const agentRaw = join(agentBase.root, 'raw'); await cp(raw, agentRaw, { recursive: true });
  await rm(join(agentRaw, 'MEMORY.md'));
  await writeFile(join(agentRaw, 'AGENTS.md'), `# Agent guidance\n${await readFile(join(raw, 'alpha.md'), 'utf8')}\n${await readFile(join(raw, 'beta.md'), 'utf8')}\n`);
  await importDir(agentRaw, { ...agentBase.options, from: 'agents-md' });
  const templates = await Promise.all([{ source: base, raw, to: 'claude-code' as const }, { source: agentBase, raw: agentRaw, to: 'agents-md' as const }].map(async template => {
    const initial = (await template.source.client.listAllComplete({ includeBody: true })).items;
    return { ...template, alpha: initial.find(row => row.memory_slug === 'alpha')!, beta: initial.find(row => row.memory_slug === 'beta')! };
  }));
  const discovery = { PATH: base.root, GIT_CEILING_DIRECTORIES: dirname(base.root) };
  for (const [key, value] of Object.entries(discovery)) {
    const saved = process.env[key]; process.env[key] = value;
    t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  }
  for (let sequence = START; sequence < START + COUNT; sequence++) {
    const seed = (MASTER + Math.imul(sequence, 0x9e3779b9)) >>> 0; let state = seed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    const label = `MASTER_SEED=${MASTER} SEQUENCE=${sequence} SEED=${seed}`;
    const root = join(base.root, `case-${sequence}`); const workspace = join(root, 'source'); const fresh = join(root, 'fresh');
    try {
      const template = templates[sequence % 2]; const { alpha, beta, to } = template;
      await mkdir(root); await copyTracker(template.source.workspace, workspace); await copyTracker(empty.workspace, fresh);
      const client = new PmClient({ pmRoot: workspace, author: 'memory-test', noExtensions: true });
      const options = { workspace, author: 'memory-test' }; const scenario = Math.floor(sequence / 2) % 8;
      if (scenario === 0) {
        await client.update(alpha.id, { depRemove: [`id=${beta.id},kind=related`], dep: [`id=${beta.id},kind=supersedes`] });
        const changed = join(root, 'raw'); await cp(template.raw, changed, { recursive: true });
        await writeFile(join(changed, 'alpha.md'), '# Alpha\nText link removed');
        await importDir(changed, { ...options, from: to });
        const retained = (await client.get(alpha.id, { full: true })).item.dependencies!;
        assert.equal(retained.length, 1, label); assert.equal(retained[0].kind, 'supersedes', label);
      }
      if (scenario === 1) await client.run('update', { id: alpha.id, options: { memorySlug: `renamed-${seed}` } });
      if (scenario === 2) {
        const fields = [{ title: `Title ${seed}` }, { description: `Hook ${seed}` }, { body: `\nBody ${seed}\r\n` }, { memoryKind: 'feedback' }, { memoryWhy: `Why ${seed}` }, { memoryHow: `How ${seed}` }, { memoryPinned: true }, { tags: `native-${seed},edited` }];
        const first = random() % fields.length;
        for (let i = 0, count = 1 + random() % fields.length; i < count; i++) await client.run('update', { id: alpha.id, options: fields[(first + i) % fields.length] });
      }
      if (scenario === 3) await client.update(alpha.id, { dep: [`id=${beta.id},kind=supersedes,author=peer-${seed},source_kind=portable-evidence,created_at=2026-01-01T00:00:00.000Z`] });
      if (scenario === 4) await client.update(beta.id, { status: 'canceled', closeReason: 'Fidelity scenario' });
      if (scenario === 5) await client.update(alpha.id, { clearDeps: true });
      if (scenario === 7) { const native = await client.create({ title: 'Native Task' }); await client.update(alpha.id, { dep: [`id=${native.item.id},kind=related`] }); }
      const output = join(root, 'export');
      const receipt = await exportDir(output, { ...options, to });
      const expected = (await client.listAllComplete({ includeBody: true })).items;
      await importDir(output, { workspace: fresh, author: 'memory-test', from: to });
      const destination = new PmClient({ pmRoot: fresh, author: 'memory-test', noExtensions: true });
      assert.deepEqual(semantic((await destination.listAllComplete({ includeBody: true })).items, receipt), semantic(expected, receipt), label);
      // A post-export native rename and identical replacement must never change the selected origin.
      const original = expected.find(row => row.id === alpha.id)!; const alias = String(original.memory_slug);
      await client.run('update', { id: alpha.id, options: { memorySlug: `origin-${seed}`, memorySource: 'native:item', memoryOriginal: 'Native-only bookkeeping', memoryPath: 'native-only.md', memoryEdited: true } });
      await client.run('create', { options: { title: original.title, description: original.description, body: original.body, tags: original.tags.join(','), type: 'Knowledge', allowDuplicate: true, memorySlug: alias, memorySource: 'native:item', memoryKind: original.memory_kind, memoryWhy: original.memory_why, memoryHow: original.memory_how, memoryPinned: original.memory_pinned, memoryRecalls: 0, memoryVerdict: 'unknown', memoryEdited: false, memoryArtifact: false, ...itemDocumentToMutationOptions(JSON.stringify({ dependencies: original.dependencies ?? [] }), 'create') } });
      const replacementId = (await client.listAllComplete()).items.find(row => row.memory_slug === alias)!.id;
      const replacement = (await client.get(replacementId, { full: true })).item;
      const desired = `Harness revision ${random()}`;
      let bodyFile: string; let prefix = '';
      try {
        const manifest = JSON.parse(await readFile(join(output, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
        const row = manifest.guidance.find(row => row.slug === alias)!; bodyFile = join(output, row.path);
        const bytes = await readFile(bodyFile, 'utf8'); prefix = bytes.slice(0, bytes.indexOf('\n') + 1);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bodyFile = join(output, 'alpha.md'); }
      await writeFile(bodyFile, prefix + desired);
      const imported = await importDir(output, { ...options, from: to });
      if ('skipped' in imported) assert.equal(imported.skipped.some(row => row.reason.includes('Independently edited')), false, label);
      const after = (await client.get(alpha.id, { full: true })).item;
      assert.equal(after.body, desired, label); assert.equal(after.memory_source, 'native:item');
      assert.equal(after.memory_original, 'Native-only bookkeeping'); assert.equal(after.memory_path, 'native-only.md'); assert.equal(after.memory_edited, true);
      assert.deepEqual((await client.get(replacement.id, { full: true })).item, replacement, label);
    } catch (cause) { t.diagnostic(label); throw new Error(label, { cause }); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
  t.diagnostic(`FIDELITY start=${START} count=${COUNT} MASTER_SEED=${MASTER}`);
});
