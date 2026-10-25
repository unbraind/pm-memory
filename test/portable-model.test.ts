import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { canonicalDocument, certifyCompleteListResult, PmClient } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, renew, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { tracker } from './helpers.ts';

const MASTER_SEED = 0x1363cafe;
const SEQUENCES = 500;
/** Reference semantics, intentionally independent of package Memory projections and hashes. */
interface NodeModel {
  slug: string;
  title: string;
  description: string;
  body: string;
  why: string;
  how: string;
  kind: string;
  pinned: boolean;
  tags: string[];
  validity: unknown;
  relationships: { slug: string; kind: string }[];
}
/** Immutable prior export and the model state it represents. */
interface SavedModel {
  path: string;
  snapshot: NodeModel[];
  desired: NodeModel[];
  native: Map<string, unknown>;
}
/** Complete certified SDK rows shared by the independent content and provenance projections. */
type SdkRows = Awaited<ReturnType<PmClient["listAllComplete"]>>["items"];
/** Project the reference content/graph comparison independently of production Memory helpers. */
function modelFrom(items: SdkRows): NodeModel[] {
  return items.filter(item => item.memory_slug !== undefined).map(item => ({
    slug: String(item.memory_slug), title: item.title, description: item.description, body: String(item.body),
    why: String(item.memory_why), how: String(item.memory_how), kind: String(item.memory_kind), pinned: item.memory_pinned === true,
    tags: item.tags, validity: item.memory_validity === undefined ? null : JSON.parse(String(item.memory_validity)),
    relationships: (item.dependencies ?? []).map(edge => ({ slug: String(items.find(target => target.id === edge.id)!.memory_slug), kind: edge.kind })).sort((a, b) => a.slug.localeCompare(b.slug) || a.kind.localeCompare(b.kind)),
  })).sort((a, b) => a.slug.localeCompare(b.slug));
}
/** SDK-normalized provenance from the same authoritative read, without another scan. */
function nativeFrom(items: SdkRows): Map<string, unknown> {
  return new Map(items.filter(item => item.memory_slug !== undefined).map(item => [String(item.memory_slug), {
    title: item.title, description: item.description, body: item.body, tags: item.tags, why: item.memory_why,
    how: item.memory_how, kind: item.memory_kind, pinned: item.memory_pinned, dependencies: item.dependencies ?? [],
  }]));
}
/** Read the complete tracker once after a step, then use it for both independent assertions. */
async function readState(client: PmClient) {
  const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
  return { model: modelFrom(items), native: nativeFrom(items), items };
}
/** Ask the SDK storage normalizer how an input body will be retained. */
function storedBody(body: string): string {
  return canonicalDocument({ metadata: { id: 'model', title: 'Model', description: '', type: 'Task', status: 'open', priority: 2, tags: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }, body }).body;
}
/** Locate the editable alpha body without relying on a harness-specific folder layout. */
async function bodyFile(directory: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  return join(directory, manifest.guidance.find(row => row.slug === 'alpha')!.path);
}
/** Replace only the body bytes below the retained policy marker. */
async function writeBody(directory: string, body: string): Promise<void> {
  const file = await bodyFile(directory); const bytes = await readFile(file, 'utf8');
  await writeFile(file, bytes.slice(0, bytes.indexOf('\n') + 1) + body);
}
/** Seeded operation generator whose failing sequence can be replayed without timing dependence. */
function generator(seed: number): () => number { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }; }

// Each independent sequence uses a real non-git clone of one initialized SDK tracker.
test('model: 500 seeded stateful sequences preserve old replays, SDK-normalized provenance and relationships', { timeout: 5400000 }, async t => {
  t.diagnostic(`MASTER_SEED=0x${MASTER_SEED.toString(16)} sequences=${SEQUENCES}`);
  const base = await tracker(t);
  const ceiling = process.env.GIT_CEILING_DIRECTORIES; const commandPath = process.env.PATH;
  process.env.GIT_CEILING_DIRECTORIES = dirname(base.root); process.env.PATH = base.root;
  t.after(() => { if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling; if (commandPath === undefined) delete process.env.PATH; else process.env.PATH = commandPath; });
  // SDK timestamps stay real; the reference oracle reads them from native records.
  const alpha = await remember('Alpha body', { ...base.options, slug: 'alpha', kind: 'project' });
  await remember('Beta body', { ...base.options, slug: 'beta', kind: 'reference', links: [alpha.id] });
  await remember('Unrelated bounded policy', { ...base.options, slug: 'policy', kind: 'project', pin: true });
  await renew('policy', { ...base.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Model scenario review' });
  const beforeSeed = await readState(base.client);
  const initial = structuredClone(beforeSeed.model); const seedBody = '\nA\r\n';
  initial.find(row => row.slug === 'alpha')!.body = storedBody(seedBody);
  const seeds = new Map<'agents-md' | 'claude-code', SavedModel>();
  for (const to of ['agents-md', 'claude-code'] as const) {
    const path = join(base.root, `seed-${to}`); await exportDir(path, { ...base.options, to });
    await writeBody(path, seedBody);
    seeds.set(to, { path, snapshot: beforeSeed.model, desired: initial, native: beforeSeed.native });
  }
  // Seed completed A journals for BOTH harnesses, not just the final item bytes.
  const first = await importDir(seeds.get('agents-md')!.path, { ...base.options, from: 'agents-md' });
  assert.ok('skipped' in first); assert.deepEqual(first.skipped, [], `MASTER_SEED=${MASTER_SEED}: seed import graph`);
  assert.deepEqual((await readState(base.client)).model, initial, `MASTER_SEED=${MASTER_SEED}: seed A SDK read-back`);
  const claude = seeds.get('claude-code')!; const seedFile = await bodyFile(claude.path); const seedBytes = await readFile(seedFile, 'utf8');
  await writeFile(seedFile, seedBytes.slice(0, seedBytes.indexOf('\n') + 1) + 'Seed B');
  const seededB = await importDir(claude.path, { ...base.options, from: 'claude-code' });
  assert.equal(seededB.updated, 1, `MASTER_SEED=${MASTER_SEED}: seed B applied`);
  const expectedB = structuredClone(initial); expectedB.find(row => row.slug === 'alpha')!.body = 'Seed B';
  assert.deepEqual((await readState(base.client)).model, expectedB, `MASTER_SEED=${MASTER_SEED}: seed B SDK read-back`);
  await writeFile(seedFile, seedBytes); const seededA = await importDir(claude.path, { ...base.options, from: 'claude-code' });
  assert.equal(seededA.updated, 1, `MASTER_SEED=${MASTER_SEED}: seed old A applied`);
  const seeded = await readState(base.client);
  assert.deepEqual(seeded.model, initial, `MASTER_SEED=${MASTER_SEED}: SDK-read initial A graph`);
  const ids = new Map(seeded.items.map(item => [String(item.memory_slug), item.id]));
  let totalSteps = 0;
  for (let sequence = 0; sequence < SEQUENCES; sequence++) {
    const seed = (MASTER_SEED + Math.imul(sequence, 0x9e3779b9)) >>> 0; let completed = false;
    await t.test(`sequence ${sequence} seed ${seed}`, async () => {
      const random = generator(seed);
      const root = join(base.root, `sequence-${sequence}`); const workspace = join(root, 'pm');
      await mkdir(root);
      await cp(base.workspace, workspace, { recursive: true, filter: path => !['runtime', 'locks', 'checkpoints'].includes(relative(base.workspace, path).split('/')[0]) });
      const client = new PmClient({ pmRoot: workspace, noExtensions: true, author: 'memory-test' });
      const options = { workspace, author: 'memory-test' }; const to = sequence % 2 === 0 ? 'agents-md' : 'claude-code';
      let model = structuredClone(initial); const baseline = new Map(seeded.native); const exports: SavedModel[] = [];
      let operation = 'initialize'; let step = 0; let lastNative = seeded.native; let accepted: string[] = [];
      /** Assert the entire tracker after every operation, with a stable replay coordinate. */
      const check = async () => {
        const actual = await readState(client);
        assert.deepEqual(actual.model, model, `master=${MASTER_SEED} seed=${seed} sequence=${sequence} step=${step} operation=${operation}`);
        lastNative = actual.native;
        for (const key of accepted) baseline.set(key, lastNative.get(key));
        accepted = []; step++; totalSteps++;
      };
      /** Export the model's current state and remember it independently of the actual manifest. */
      const save = async () => {
        const path = join(root, `export-${exports.length}`); await exportDir(path, { ...options, to });
        const saved = { path, snapshot: structuredClone(model), desired: structuredClone(model), native: lastNative }; exports.push(saved); return saved;
      };
      /** Edit a copied prior export while retaining its policy marker and original snapshot. */
      const variant = async (saved: SavedModel, body: string) => {
        const path = join(root, `export-${exports.length}`); await cp(saved.path, path, { recursive: true });
        await writeBody(path, body);
        const next = { path, snapshot: structuredClone(saved.snapshot), desired: structuredClone(saved.desired), native: saved.native };
        next.desired.find(row => row.slug === 'alpha')!.body = storedBody(body); exports.push(next); return next;
      };
      /** Predict acceptance from native edit history and then compare the SDK-read result. */
      const apply = async (saved: SavedModel) => {
        const skipped: string[] = []; const native = lastNative;
        for (const row of model) {
          if (!isDeepStrictEqual(native.get(row.slug), baseline.get(row.slug)) && !isDeepStrictEqual(native.get(row.slug), saved.native.get(row.slug))) { skipped.push(row.slug); continue; }
          const next = structuredClone(saved.desired.find(item => item.slug === row.slug)!);
          model = model.map(item => item.slug === row.slug ? next : item);
        }
        const result = await importDir(saved.path, { ...options, from: to }); assert.ok('skipped' in result);
        assert.deepEqual(result.skipped.map(row => row.slug).sort(), skipped.sort(), `seed=${seed} operation=${operation}: independent-edit classification`);
        accepted = model.filter(row => !skipped.includes(row.slug)).map(row => row.slug);
      };
      try {
        await check();
        operation = 'export A'; await save(); const original = seeds.get(to)!; await check();
        operation = 'whitespace variant A'; const a = await variant(original, seedBody); await check();
        operation = 'import A'; await apply(a); await check();
        operation = 'whitespace variant B'; const word = `B ${random()}`; const b = await variant(original, [`${word}\n`, `\n${word}\n\n`, ` ${word} \r\n`, `\r\n${word}\r\n`][random() % 4]); await check();
        operation = 'import B'; await apply(b); await check();
        operation = 'replay older A'; await apply(a); await check();
        for (let index = 0; index < 6; index++) {
          const choice = random() % 7; const key = random() % 2 === 0 ? 'alpha' : 'beta'; const node = model.find(row => row.slug === key)!;
          operation = ['export', 'import old export', 'native body edit', 'native field edit', 'add link', 'remove links', 'whitespace variant'][choice];
          if (choice === 0) await save();
          if (choice === 1) await apply(exports[random() % exports.length]);
          if (choice === 2) { const body = `\n native ${random()} \r\n`; await client.update(ids.get(key)!, { body }); node.body = storedBody(body); }
          if (choice === 3) { const description = ` Native hook ${random()} \r\n`; await client.update(ids.get(key)!, { description }); node.description = description; }
          if (choice === 4) { const target = key === 'alpha' ? 'beta' : 'alpha'; await client.update(ids.get(key)!, { dep: [`id=${ids.get(target)!},kind=related`], replaceDeps: true }); node.relationships = [{ slug: target, kind: 'related' }]; }
          if (choice === 5) { await client.update(ids.get(key)!, { clearDeps: true }); node.relationships = []; }
          if (choice === 6) await variant(exports[random() % exports.length], ` \r\n Variant ${random()} \r\n`);
          await check();
        }
        operation = 'export native rebase'; const final = await save(); await check();
        operation = 'import final X'; await apply(final); await check();
        assert.deepEqual(model, final.desired, `seed=${seed}: import(X) must equal X`);
      } catch (error) { throw new Error(`MASTER_SEED=${MASTER_SEED} SEQUENCE_SEED=${seed} sequence=${sequence} step=${step} operation=${operation}`, { cause: error }); }
      await rm(root, { recursive: true });
      completed = true;
    });
    assert.equal(completed, true, `MASTER_SEED=${MASTER_SEED} SEQUENCE_SEED=${seed}: sequence did not complete`);
    if ((sequence + 1) % 50 === 0) t.diagnostic(`seed=${MASTER_SEED} sequences=${sequence + 1}/${SEQUENCES} SDK-read steps=${totalSteps}`);
  }
  t.diagnostic(`MASTER_SEED=0x${MASTER_SEED.toString(16)} sequences=${SEQUENCES} SDK-read steps=${totalSteps}; both harnesses, A/B/A, native body/field/edge edits, whitespace/CRLF, mixed windows`);
});
