import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PmClient } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, POLICY_MANIFEST } from '../index.ts';
import type { Harness, PortablePolicyManifest } from '../index.ts';
import { tracker, withoutGit, cloneTracker, clonedTracker } from './helpers.ts';

const START = Number(process.env.PM_MEMORY_GRAMMAR_START);
const COUNT = Number(process.env.PM_MEMORY_GRAMMAR_COUNT);
const MASTER = 0x1363f005;
assert.ok(Number.isInteger(START) && START >= 0 && START < 500);
assert.ok(Number.isInteger(COUNT) && COUNT > 0 && COUNT <= 25 && START + COUNT <= 500);

/** Reproducible input generation is independent of the importer's parser and projections. */
function grammarRandom(seed: number): () => number { return () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; }; }
/** Locate the actual owned guidance file in either supported emitted inventory. */
async function emittedFile(directory: string, slug: string, fallback: string) {
  let manifest: PortablePolicyManifest;
  try { manifest = JSON.parse(await readFile(join(directory, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const path = join(directory, fallback); return { path, marker: '', text: await readFile(path, 'utf8') }; }
  const path = join(directory, manifest.guidance.find(row => row.slug === slug)!.path); const bytes = await readFile(path, 'utf8');
  const boundary = bytes.indexOf('\n') + 1; return { path, marker: bytes.slice(0, boundary), text: bytes.slice(boundary) };
}
/** Only SDK-managed clocks differ between independent SDK writes and the import transaction. */
function nativeState(rows: Awaited<ReturnType<PmClient['listAllComplete']>>['items'], changed: string) { return rows.map(row => row.id === changed ? { ...row, updated_at: '<SDK modification clock>' } : row).sort((a, b) => a.id.localeCompare(b.id)); }

test(`current grammar law ${START}-${START + COUNT - 1}`, { timeout: 1200000 }, async t => {
  const isolated = await tracker(t); withoutGit(t, isolated.root); await isolated.store.register();
  const templates = new Map<string, Awaited<ReturnType<typeof tracker>>>();
  for (let sequence = START; sequence < START + COUNT; sequence++) {
    const seed = (MASTER + Math.imul(sequence, 0x9e3779b9)) >>> 0; const random = grammarRandom(seed); const mode = sequence % 5;
    const from: Harness = mode === 4 ? 'cursor' : sequence % 2 === 0 ? 'agents-md' : 'claude-code';
    const to = mode === 2 ? 'agents-md' : mode === 3 ? 'claude-code' : from === 'cursor' ? (sequence % 2 === 0 ? 'agents-md' : 'claude-code') : from;
    const label = `GRAMMAR_MASTER=${MASTER} SEQUENCE=${sequence} SEED=${seed} mode=${mode}`;
    try {
      const name = from === 'agents-md' && mode < 2 ? 'AGENTS.md' : 'alpha.md'; const slug = name === 'AGENTS.md' ? 'agents' : 'alpha';
      const indexed = from === 'claude-code' && mode < 2; const key = `${from}/${name}/${indexed}`;
      if (!templates.has(key)) {
        const template = await tracker(t); const input = join(template.root, 'plain'); await mkdir(input);
        await writeFile(join(input, name), 'Plain body'); if (indexed) await writeFile(join(input, 'MEMORY.md'), '- [Alpha](alpha.md)\n');
        await importDir(input, { ...template.options, from }); templates.set(key, template);
      }
      const target = await clonedTracker(t, templates.get(key)!); const source = join(target.root, 'source'); await mkdir(source);
      const body = `Body ${seed}`; await writeFile(join(source, name), 'Plain body');
      if (indexed) await writeFile(join(source, 'MEMORY.md'), '- [Alpha](alpha.md)\n');
      const id = (await target.client.listAllComplete()).items.find(row => row.memory_slug === slug)!.id;
      await target.client.run('update', { id, options: { priority: random() % 4, memoryRecalls: random() % 9 } });
      if (sequence % 3 === 0) { const task = await target.client.create({ title: `Native task ${seed}` }); await target.client.update(id, { dep: [`id=${task.item.id},kind=related`] }); }
      const directory = mode === 0 ? source : join(target.root, 'exported');
      if (mode !== 0) await exportDir(directory, { ...target.options, to });
      const input = mode === 0 ? { path: join(source, name), marker: '', text: 'Plain body' } : await emittedFile(directory, slug, name);
      const newline = random() % 2 === 0 ? '\n' : '\r\n'; const classification = ['feedback', 'project', 'reference'][random() % 3];
      const description = `Hook Ω ${random()}`; const named = random() % 2 === 0;
      const entries = [random() % 2 === 0 ? `type: ${classification}` : `metadata: {type: ${classification}}`, `description: ${JSON.stringify(description)}`, `opaque_${seed}: {changed: old, nested: [null, false, ${random() % 99}]}`];
      if (named) entries.push(`name: ${slug}`); if (random() % 2 === 0) entries.reverse();
      const semanticBody = body + (sequence % 2 === 0 ? `${newline}**Why:** Rationale ${seed}` : '') + (sequence % 3 === 0 ? `${newline}**How to apply:** Application ${seed}` : '');
      const first = `${random() % 2 === 0 ? '\uFEFF' : ''}---${newline}${entries.join(newline)}${newline}---${newline}${semanticBody}${newline}${' '.repeat(random() % 3)}${newline}`;
      const oracle = join(target.root, 'oracle');
      const client = await cloneTracker(target, oracle);
      const phases = [first, first.replace('changed: old', 'changed: new'), `Body after envelope removal ${seed}`];
      let activeDirectory = directory; let activeInput = input;
      for (const [phase, document] of phases.entries()) {
        const documentValue = JSON.stringify({ format: 'legacy', harness: from, original: Buffer.from(document).toString('base64'), path: name, version: 1 });
        const options: Record<string, unknown> = { memoryDocument: documentValue };
        if (phase === 0) Object.assign(options, { body: semanticBody, memoryKind: classification, description, title: named ? slug : body, ...(sequence % 2 === 0 ? { memoryWhy: `Rationale ${seed}` } : {}), ...(sequence % 3 === 0 ? { memoryHow: `Application ${seed}` } : {}) });
        if (phase === 2) Object.assign(options, { body: document, title: document });
        await client.run('update', { id, options });
        await writeFile(activeInput.path, activeInput.marker + document);
        const receipt = await importDir(activeDirectory, { ...target.options, from: phase === 0 && mode === 0 ? from : to });
        assert.equal(receipt.updated, 1, label); assert.equal(receipt.imported, 0, label);
        assert.deepEqual(nativeState((await target.client.listAllComplete({ includeBody: true })).items, id), nativeState((await client.listAllComplete({ includeBody: true })).items, id), `${label} phase=${phase}`);
        const output = join(target.root, `after-${phase}`); await exportDir(output, { ...target.options, to });
        const emitted = await emittedFile(output, slug, name); assert.equal(emitted.text, document, `${label} phase=${phase}`);
        const before = (await target.client.listAllComplete({ includeBody: true })).items;
        assert.equal((await importDir(output, { ...target.options, from: to })).updated, 0, label);
        assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before, label);
        activeDirectory = output; activeInput = emitted;
      }
      const fresh = await clonedTracker(t, isolated); await importDir(activeDirectory, { ...fresh.options, from: to });
      const actual = (await fresh.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === slug)!;
      const expected = (await client.listAllComplete({ includeBody: true })).items.find(row => row.id === id)!;
      for (const key of ['title', 'description', 'body', 'memory_kind', 'memory_why', 'memory_how', 'memory_document']) assert.equal(actual[key], expected[key], `${label} fresh ${key}`);
      await rm(oracle, { recursive: true });
    } catch (cause) { t.diagnostic(label); throw new Error(label, { cause }); }
  }
  t.diagnostic(`GRAMMAR_LAW start=${START} count=${COUNT} MASTER_SEED=${MASTER}`);
});
