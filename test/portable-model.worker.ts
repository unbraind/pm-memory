import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { canonicalDocument, certifyCompleteListResult, PmClient, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, renew, POLICY_MANIFEST, MemoryError } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { tracker, assertClosedGraph } from './helpers.ts';

const MASTER_SEED = 0x1363cafe;
const START = Number(process.env.PM_MEMORY_MODEL_START);
const SEQUENCES = Number(process.env.PM_MEMORY_MODEL_COUNT);
assert.ok(Number.isInteger(START) && START >= 0 && START < 500 && START % 5 === 0);
assert.equal(SEQUENCES, 5);
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
  assertClosedGraph(items);
  return { model: modelFrom(items), native: nativeFrom(items), items };
}
/** Ask the SDK storage normalizer how an input body will be retained. */
function storedBody(body: string): string {
  return canonicalDocument({ metadata: { id: 'model', title: 'Model', description: '', type: 'Task', status: 'open', priority: 2, tags: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }, body }).body;
}
/** Locate the editable alpha body without relying on a harness-specific folder layout. */
async function bodyFile(directory: string, slug = 'alpha'): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
  return join(directory, manifest.guidance.find(row => row.slug === slug)!.path);
}
/** Replace only the body bytes below the retained policy marker. */
async function writeBody(directory: string, body: string, slug = 'alpha'): Promise<void> {
  const file = await bodyFile(directory, slug); const bytes = await readFile(file, 'utf8');
  await writeFile(file, bytes.slice(0, bytes.indexOf('\n') + 1) + body);
}
/** Seeded operation generator whose failing sequence can be replayed without timing dependence. */
function generator(seed: number): () => number { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }; }

// Each independent sequence uses a real non-git clone of one initialized SDK tracker.
test(`model batch ${START}: seeded stateful replay, SDK provenance and relationships`, { timeout: 600000 }, async t => {
  t.diagnostic(`MASTER_SEED=0x${MASTER_SEED.toString(16)} sequences=${SEQUENCES}`);
  const base = await tracker(t);
  const emptyTemplate = join(base.root, 'empty-sdk');
  await cp(base.workspace, emptyTemplate, { recursive: true, filter: path => !['runtime', 'locks', 'checkpoints'].includes(relative(base.workspace, path).split('/')[0]) });
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
  const baseIds = new Map(seeded.items.map(item => [String(item.memory_slug), item.id]));
  let totalSteps = 0; let freshSteps = 0; let freshCases = 0;
  for (let sequence = START; sequence < START + SEQUENCES; sequence++) {
    const seed = (MASTER_SEED + Math.imul(sequence, 0x9e3779b9)) >>> 0; let completed = false;
    await t.test(`sequence ${sequence} seed ${seed}`, async () => {
      const random = generator(seed);
      const root = join(base.root, `sequence-${sequence}`); const workspace = join(root, 'pm');
      await mkdir(root);
      await cp(base.workspace, workspace, { recursive: true, filter: path => !['runtime', 'locks', 'checkpoints'].includes(relative(base.workspace, path).split('/')[0]) });
      const client = new PmClient({ pmRoot: workspace, noExtensions: true, author: 'memory-test' });
      const ids = new Map(baseIds);
      const options = { workspace, author: 'memory-test' }; const to = sequence % 2 === 0 ? 'agents-md' : 'claude-code';
      let model = structuredClone(initial); const baseline = new Map(initial.map(row => [row.slug, structuredClone(row)])); const nativeEdits = new Map<string, Set<string>>(); const exports: SavedModel[] = [];
      let operation = 'initialize'; let step = 0; let lastNative = seeded.native; const foreign = new Set<string>();
      /** Assert the entire tracker after every operation, with a stable replay coordinate. */
      const check = async () => {
        const actual = await readState(client);
        for (const slug of foreign) assert.equal(actual.items.find(item => item.memory_slug === slug)!.memory_source, 'foreign:model');
        assert.deepEqual(actual.model, model, `master=${MASTER_SEED} seed=${seed} sequence=${sequence} step=${step} operation=${operation}`);
        lastNative = actual.native;

        step++; totalSteps++;
      };
      /** Export the model's current state and remember it independently of the actual manifest. */
      const save = async () => {
        const path = join(root, `export-${exports.length}`); await exportDir(path, { ...options, to });
        const saved = { path, snapshot: structuredClone(model), desired: structuredClone(model), native: lastNative }; exports.push(saved); return saved;
      };
      /** Edit a copied prior export while retaining its policy marker and original snapshot. */
      const variant = async (saved: SavedModel, body: string, slug = 'alpha') => {
        const path = join(root, `export-${exports.length}`); await cp(saved.path, path, { recursive: true });
        await writeBody(path, body, slug);
        const next = { path, snapshot: structuredClone(saved.snapshot), desired: structuredClone(saved.desired), native: saved.native };
        next.desired.find(row => row.slug === slug)!.body = storedBody(body); exports.push(next); return next;
      };
      /** Predict acceptance from native edit history and then compare the SDK-read result. */
      const apply = async (saved: SavedModel) => {
        const skipped = new Set(foreign); const conflicts = new Set<string>(); const changes = new Map<string, NodeModel>();
        for (const row of model) {
          if (foreign.has(row.slug)) continue;
          const wanted = saved.desired.find(item => item.slug === row.slug)!; const exported = saved.snapshot.find(item => item.slug === row.slug)!;
          const owned = baseline.get(row.slug); const dirty = nativeEdits.get(row.slug) ?? new Set<string>(); const next = structuredClone(row); let refused = false;
          for (const key of ['title', 'description', 'body', 'why', 'how', 'kind', 'pinned', 'tags'] as const) {
            if (isDeepStrictEqual(row[key], wanted[key])) continue;
            if ((!dirty.has(key) && owned !== undefined && isDeepStrictEqual(row[key], owned[key])) || (!isDeepStrictEqual(wanted[key], exported[key]) && isDeepStrictEqual(row[key], exported[key]))) Object.assign(next, { [key]: structuredClone(wanted[key]) });
            else refused = true;
          }
          const edgeKey = (edge: NodeModel['relationships'][number]) => `${edge.slug}:${edge.kind}`;
          const relation = new Map(row.relationships.map(edge => [edgeKey(edge), edge]));
          const keys = new Set([...row.relationships, ...wanted.relationships, ...exported.relationships, ...(owned?.relationships ?? [])].map(edgeKey));
          for (const key of keys) {
            const now = relation.has(key); const desired = wanted.relationships.some(edge => edgeKey(edge) === key); const before = exported.relationships.some(edge => edgeKey(edge) === key); const old = owned?.relationships.some(edge => edgeKey(edge) === key);
            if (now === desired) continue;
            if ((!dirty.has(`relationship:${key}`) && owned !== undefined && now === old) || (desired !== before && now === before)) {
              if (desired) relation.set(key, wanted.relationships.find(edge => edgeKey(edge) === key)!); else relation.delete(key);
            } else if (desired !== before) refused = true;
          }
          next.relationships = [...relation.values()].sort((a, b) => a.slug.localeCompare(b.slug) || a.kind.localeCompare(b.kind));
          if (!isDeepStrictEqual(next, row)) changes.set(row.slug, next);
          if (refused) { conflicts.add(row.slug); if (!changes.has(row.slug)) skipped.add(row.slug); }
        }
        // Only refused records close dependencies; a field conflict does not erase unrelated edits.
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of saved.desired) if (!skipped.has(row.slug) && row.relationships.some(edge => skipped.has(edge.slug))) { skipped.add(row.slug); changed = true; }
        }
        model = model.map(row => skipped.has(row.slug) ? row : changes.get(row.slug) ?? row);
        const result = await importDir(saved.path, { ...options, from: to }); assert.ok('skipped' in result);
        assert.deepEqual([...new Set(result.skipped.map(row => row.slug))].sort(), [...new Set([...skipped, ...conflicts])].sort(), `seed=${seed} operation=${operation}: independent-edit classification`);
        for (const row of saved.desired) if (!skipped.has(row.slug) && changes.has(row.slug)) { baseline.set(row.slug, structuredClone(row)); nativeEdits.delete(row.slug); }

      };
      /** Advance the reference only after a no-edit interrupted batch has recovered. */
      const acceptRecovery = (saved: SavedModel): void => { model = structuredClone(saved.desired); for (const row of model) baseline.set(row.slug, structuredClone(row)); nativeEdits.clear(); };
      /** Delete one complete generation, then recreate the same archived input. */
      const recreate = async (saved: SavedModel, label: string) => {
        operation = `delete ${label}`;
        for (const item of (await client.listAllComplete()).items) await client.run('delete', { id: item.id, options: { force: true } });
        model.splice(0); ids.clear(); await check();
        operation = `reimport ${label}`;
        assert.equal((await importDir(saved.path, { ...options, from: to })).imported, 3);
        model.splice(0, model.length, ...structuredClone(saved.desired)); for (const row of model) baseline.set(row.slug, structuredClone(row)); nativeEdits.clear();
        for (const item of (await client.listAllComplete()).items) ids.set(String(item.memory_slug), item.id);
        await check();
      };
      /** Interrupt one of all journal boundaries and predict each durable data mutation. */
      const crash = async (saved: SavedModel, boundary: number, count: number) => {
        let eventIndex = 0;
        await assert.rejects(importDir(saved.path, { ...options, from: to,
          onStep: value => { if ((value === 'intent' && boundary === 0) || (value === 'readback' && boundary === count + 1) || (value === 'published' && boundary === count + 2)) throw new WorkspaceTransactionInterruptedError(); },
          onTransition: event => {
            if (!event.transactionId.endsWith('-snapshot') && event.transition === 'step_applied') {
              const key = [...ids].find(([, id]) => event.stepId!.includes(`-${id}-`))![0];
              model = model.map(row => row.slug === key ? structuredClone(saved.desired.find(item => item.slug === key)!) : row);
            }
            if (++eventIndex === boundary) throw new WorkspaceTransactionInterruptedError();
          },
        }), WorkspaceTransactionInterruptedError);
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
          if (choice === 2) { const body = `\n native ${random()} \r\n`; await client.update(ids.get(key)!, { body }); node.body = storedBody(body); nativeEdits.set(key, new Set([...(nativeEdits.get(key) ?? []), 'body'])); }
          if (choice === 3) { const description = ` Native hook ${random()} \r\n`; await client.update(ids.get(key)!, { description }); node.description = description; nativeEdits.set(key, new Set([...(nativeEdits.get(key) ?? []), 'description'])); }
          if (choice === 4) { const target = key === 'alpha' ? 'beta' : 'alpha'; const edited = [...node.relationships.map(edge => `relationship:${edge.slug}:${edge.kind}`), `relationship:${target}:related`]; await client.update(ids.get(key)!, { dep: [`id=${ids.get(target)!},kind=related`], replaceDeps: true }); node.relationships = [{ slug: target, kind: 'related' }]; nativeEdits.set(key, new Set([...(nativeEdits.get(key) ?? []), ...edited])); }
          if (choice === 5) { const edited = node.relationships.map(edge => `relationship:${edge.slug}:${edge.kind}`); await client.update(ids.get(key)!, { clearDeps: true }); node.relationships = []; nativeEdits.set(key, new Set([...(nativeEdits.get(key) ?? []), ...edited])); }
          if (choice === 6) await variant(exports[random() % exports.length], ` \r\n Variant ${random()} \r\n`);
          await check();
        }
        operation = 'export native rebase'; const final = await save(); await check();
        operation = 'import final X'; await apply(final); await check();
        assert.deepEqual(model, final.desired, `seed=${seed}: import(X) must equal X`);
        // Fixed review case: importing B, restoring exported A, and retrying B.
        operation = 'export restore A'; const restore = await save(); await check();
        operation = 'restore variant B'; const restoreB = await variant(restore, `Restore B ${random()}\r\n`); await check();
        operation = 'import restore B'; await apply(restoreB); await check();
        operation = 'restore older native body'; await client.update(ids.get('alpha')!, { body: restore.desired.find(row => row.slug === 'alpha')!.body }); model.find(row => row.slug === 'alpha')!.body = restore.desired.find(row => row.slug === 'alpha')!.body; nativeEdits.set('alpha', new Set(['body'])); await check();
        operation = 'retry restore B'; await apply(restoreB); await check();
        // Deletion must not return the import identity to a completed generation.
        await recreate(restoreB, 'imported memories');
        operation = 'retry recreated generation'; await apply(restoreB); await check();
        await recreate(restoreB, 'recreated generation');
        const midBase = await save(); const midInput = await variant(midBase, `Atomic alpha ${random()}`);
        const midBeta = `Atomic beta ${random()}`; await writeBody(midInput.path, midBeta, 'beta'); midInput.desired.find(row => row.slug === 'beta')!.body = midBeta;
        operation = 'mid-batch precondition refusal leaves memories unchanged';
        const midPeer = `Atomic peer policy ${random()}`; let midInjected = false; let midRefusal: unknown;
        try { await importDir(midInput.path, { ...options, from: to, onTransition: async event => {
          if (!midInjected && event.transition === 'step_applied') { midInjected = true; await client.update(ids.get('policy')!, { body: midPeer }); }
        } }); } catch (error) { midRefusal = error; }
        model.find(row => row.slug === 'policy')!.body = midPeer; nativeEdits.set('policy', new Set(['body'])); await check();
        assert.ok(midRefusal instanceof MemoryError && midRefusal.remedy.length > 0);
        operation = 'retry mid-batch refusal'; await apply(midInput); await check();
        // Sample EVERY shared-helper read/guard/apply boundary in all three paths.
        const mode = ['fresh', 'interrupted', 'compensated'][sequence % 3];
        const boundary = Math.floor(sequence / 3) % (mode === 'interrupted' ? 4 : 6);
        const raceBase = await save(); const raceInput = await variant(raceBase, `Recovery boundary ${random()}`);
        operation = 'prepare recovery boundary';
        if (mode === 'interrupted') await assert.rejects(importDir(raceInput.path, { ...options, from: to, onStep: step => { if (step === 'intent') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
        if (mode === 'compensated') await assert.rejects(importDir(raceInput.path, { ...options, from: to, onTransition: event => {
          if (event.transition === 'step_recorded') throw new Error('Begin model compensation');
          if (event.transition === 'compensated') throw new WorkspaceTransactionInterruptedError();
        } }), WorkspaceTransactionInterruptedError);
        await check();
        operation = `peer edit at ${mode} read guard CAS boundary ${boundary}`;
        const peerSlug = sequence % 2 === 0 ? 'policy' : 'alpha'; const peerBody = `Peer recovery C ${random()}`; let casIndex = 0; let injected = false;
        await assert.rejects(importDir(raceInput.path, { ...options, from: to, onStep: async step => {
          if (step.startsWith('cas-') && casIndex++ === boundary) { await client.update(ids.get(peerSlug)!, { body: peerBody }); injected = true; }
        } }), error => error instanceof MemoryError && error.remedy.length > 0);
        assert.equal(injected, true, `seed=${seed} mode=${mode} boundary=${boundary}`);
        model.find(row => row.slug === peerSlug)!.body = peerBody; nativeEdits.set(peerSlug, new Set(['body'])); await check();
        operation = 'retry after compensated refusal'; await apply(raceInput); await check();
        operation = 'export recovery rebase'; const recoveredBase = await save(); await check();
        operation = 'import recovery rebase'; await apply(recoveredBase); await check();
        // Multi-target crash/recovery: every mutation and both commits are sampled.
        operation = 'export crash base'; const crashBase = await save(); await check();
        operation = 'multi-target crash input'; const crashInput = await variant(crashBase, `Crash alpha ${random()}`);
        for (const slug of ['beta', 'policy']) { const body = `Crash ${slug} ${random()}`; await writeBody(crashInput.path, body, slug); crashInput.desired.find(row => row.slug === slug)!.body = body; } await check();
        operation = 'crash every multi-target journal boundary'; await crash(crashInput, sequence % 21, 18); await check();
        operation = 'recover multi-target journal'; await importDir(crashInput.path, { ...options, from: to }); acceptRecovery(crashInput); await check();
        // Fixed foreign-target case, with a dependent that must inherit its refusal.
        operation = 'native dependent edge'; await client.update(ids.get('beta')!, { dep: [`id=${ids.get('alpha')!},kind=related`], replaceDeps: true }); const betaModel = model.find(row => row.slug === 'beta')!; nativeEdits.set('beta', new Set([...betaModel.relationships.map(edge => `relationship:${edge.slug}:${edge.kind}`), 'relationship:alpha:related'])); betaModel.relationships = [{ slug: 'alpha', kind: 'related' }]; await check();
        operation = 'export ownership base'; const owned = await save(); await check();
        operation = 'rebase ownership graph'; await apply(owned); await check();
        operation = 'foreign tool takes ownership'; await client.run('update', { id: ids.get('alpha')!, options: { memorySource: 'foreign:model' } }); foreign.add('alpha'); await check();
        operation = 'skip closure stays retryable'; await apply(owned); await check();
        // Fixed intent/edit/retry case plus every data/provenance boundary. Only
        // policy changes here; unrelated rows already equal this input or skip.
        operation = 'native-race input'; const raced = await variant(owned, `Raced policy ${random()}`, 'policy'); await check();
        operation = 'crash before newer native edit'; await crash(raced, sequence % 13, 10); await check();
        operation = 'newer native edit after crash'; const node = model.find(row => row.slug === 'policy')!;
        const newer = `${node.title}\nNative wins ${random()}`;
        if (sequence % 2 === 0) await remember(newer, { ...options, update: 'policy', kind: 'project' }); else await client.update(ids.get('policy')!, { body: newer });
        node.body = storedBody(newer); nativeEdits.set('policy', new Set(['body'])); await check();
        operation = 'retry preserves newer native edit';
        try { const result = await importDir(raced.path, { ...options, from: to }); assert.ok('skipped' in result); assert.ok(result.skipped.some(row => row.slug === 'policy')); }
        catch (error) { assert.ok(error instanceof MemoryError && error.code === 'conflict' && error.remedy.length > 0); }
        await check();
        if (sequence % 5 === 0) {
          // A second reference branch starts empty and covers the node journal,
          // including foreign ownership arriving after a node-stage crash.
          operation = 'fresh graph branch'; freshCases++;
          const workspace = join(root, 'fresh-pm'); await cp(emptyTemplate, workspace, { recursive: true });
          const client = new PmClient({ pmRoot: workspace, noExtensions: true, author: 'memory-test' });
          const options = { workspace, author: 'memory-test' }; let freshModel: NodeModel[] = [];
          const input = seeds.get(to)!; const inventory = JSON.parse(await readFile(join(input.path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
          const freshIndex = sequence / 5; const boundary = freshIndex % 31; const moved = boundary >= 9 && freshIndex % 2 === 0;
          /** Check native IDs as well as semantic state on the fresh tracker. */
          const freshCheck = async () => {
            const actual = await readState(client);
            assert.deepEqual(actual.model, [...freshModel].sort((a, b) => a.slug.localeCompare(b.slug)), `seed=${seed} fresh boundary=${boundary}`);
            freshSteps++;
          };
          await freshCheck(); let eventIndex = 0;
          await assert.rejects(importDir(input.path, { ...options, from: to,
            onStep: step => { if ((step === 'intent' && boundary === 0) || (step === 'nodes' && boundary === 28) || (step === 'readback' && boundary === 29) || (step === 'published' && boundary === 30)) throw new WorkspaceTransactionInterruptedError(); },
            onTransition: event => {
              if (event.transition === 'step_applied' && !event.transactionId.endsWith('-snapshot')) {
                const slug = inventory.guidance[Number(event.stepId!.split('-')[0]) - 1].slug;
                const desired = structuredClone(input.desired.find(row => row.slug === slug)!);
                if (event.transactionId.endsWith('-nodes')) { desired.relationships = []; freshModel.push(desired); }
                else freshModel = freshModel.map(row => row.slug === slug ? desired : row);
              }
              if (++eventIndex === boundary) throw new WorkspaceTransactionInterruptedError();
            },
          }), WorkspaceTransactionInterruptedError);
          await freshCheck();
          if (moved) {
            operation = 'foreign ownership after node crash';
            const alpha = await remember('Foreign alpha C', { ...options, update: 'alpha', kind: 'project' });
            await client.run('update', { id: alpha.id, options: { memorySource: 'foreign:model' } });
            Object.assign(freshModel.find(row => row.slug === 'alpha')!, { title: 'Foreign alpha C', body: 'Foreign alpha C' });
            await freshCheck();
          }
          /** Complete an untouched plan or retain the foreign component verbatim. */
          const retryFresh = async () => {
            if (moved) {
              // Before the node-stage readback, a moved reserved creation refuses
              // the entire atomic plan; its later fresh retry can admit policy.
              const refusedReservation = boundary === 9 && freshModel.some(row => row.slug === 'beta');
              let completed = false;
              try { const result = await importDir(input.path, { ...options, from: to }); assert.ok('skipped' in result); assert.deepEqual(result.skipped.map(row => row.slug).sort(), refusedReservation ? ['alpha', 'beta', 'policy'] : ['alpha', 'beta']); assert.ok(result.skipped.every(row => row.reason.includes('Foreign'))); completed = !refusedReservation; }
              catch (error) { assert.ok(error instanceof MemoryError && error.code === 'conflict'); }
              // Refusal restores owned creations; a later fresh retry may admit
              // the independent policy while retaining the foreign component.
              const fullyCommitted = boundary === 27 || boundary === 30;
              if (!fullyCommitted) freshModel = completed ? [freshModel.find(row => row.slug === 'alpha')!, structuredClone(input.desired.find(row => row.slug === 'policy')!)] : [freshModel.find(row => row.slug === 'alpha')!];
              const native = (await client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!;
              assert.equal(native.memory_source, 'foreign:model');
            } else {
              const result = await importDir(input.path, { ...options, from: to }); assert.ok('skipped' in result); assert.deepEqual(result.skipped, []);
            }
          };
          operation = 'fresh recovery'; await retryFresh();
          if (!moved) freshModel.splice(0, freshModel.length, ...structuredClone(input.desired));
          await freshCheck();
          operation = 'fresh repeated recovery'; await retryFresh(); await freshCheck();
        }


      } catch (error) { throw new Error(`MASTER_SEED=${MASTER_SEED} SEQUENCE_SEED=${seed} sequence=${sequence} step=${step} operation=${operation}`, { cause: error }); }
      await rm(root, { recursive: true });
      completed = true;
    });
    assert.equal(completed, true, `MASTER_SEED=${MASTER_SEED} SEQUENCE_SEED=${seed}: sequence did not complete`);
  }
  assert.equal(totalSteps, SEQUENCES * 45);
  assert.equal(freshCases, 1);
  t.diagnostic(`MODEL_BATCH start=${START} count=${SEQUENCES} SDK-read steps=${totalSteps + freshSteps} MASTER_SEED=0x${MASTER_SEED.toString(16)} fresh-cases=${freshCases} fresh-steps=${freshSteps}`);
});
