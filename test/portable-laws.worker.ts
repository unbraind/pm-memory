import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PmClient, DEPENDENCY_KIND_VALUES } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, renew, POLICY_MANIFEST } from '../index.ts';
import type { PortableGuidance, PortablePolicyManifest } from '../index.ts';
import { tracker, cloneTracker } from './helpers.ts';

const LAW = process.env.PM_MEMORY_LAW!;
const START = Number(process.env.PM_MEMORY_LAW_START);
const COUNT = Number(process.env.PM_MEMORY_LAW_COUNT);
const LAWS = ['identity', 'locality', 'foreign'];
const MASTER = (0x1363b0a1 + LAWS.indexOf(LAW) * 0x1020304) >>> 0;
assert.ok(LAWS.includes(LAW)); assert.ok(Number.isInteger(START) && START >= 0 && START < 500);
assert.ok(Number.isInteger(COUNT) && COUNT > 0 && COUNT <= 25 && START + COUNT <= 500);
const FIELDS = ['title', 'description', 'body', 'kind', 'why', 'how', 'pinned', 'tags'] as const;
type Field = typeof FIELDS[number];
type Rows = Awaited<ReturnType<PmClient['listAllComplete']>>['items'];

/** A separate seeded generator defines test inputs without importer projections. */
function randomizer(seed: number): () => number { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }; }
/** The reference changes one native field directly through the SDK. */
function fieldAction(field: Field, seed: number, prior: Rows[number]): Record<string, unknown> {
  if (field === 'pinned') return { memoryPinned: prior.memory_pinned !== true };
  if (field === 'tags') return { tags: `portable-${seed},edited` };
  if (field === 'kind') return { memoryKind: prior.memory_kind === 'feedback' ? 'reference' : 'feedback' };
  const value = `${field} portable edit ${seed}`;
  return { [['why', 'how'].includes(field) ? `memory${field[0].toUpperCase()}${field.slice(1)}` : field]: value };
}
/** Edit the wire document independently; the baseline and body marker remain bound. */
async function edit(directory: string, row: PortableGuidance, action: Record<string, unknown>, manifest: PortablePolicyManifest): Promise<void> {
  for (const field of FIELDS) {
    if (field === 'body') continue;
    const key = ['kind', 'why', 'how', 'pinned'].includes(field) ? `memory${field[0].toUpperCase()}${field.slice(1)}` : field;
    if (key in action) Object.assign(row, { [field]: field === 'tags' ? String(action[key]).split(',') : action[key] });
  }
  const file = join(directory, row.path); const previous = await readFile(file, 'utf8');
  const hash = createHash('sha256').update(JSON.stringify([row.validity, row.renewals, row.pinned, row.baseline, row.origin])).digest('hex');
  const body = typeof action.body === 'string' ? action.body : previous.slice(previous.indexOf('\n') + 1);
  await writeFile(file, `<!-- pm-memory-policy:v1 ${row.slug}; policy ${hash}; keep ${POLICY_MANIFEST} -->\n${body}`);
  await writeFile(join(directory, POLICY_MANIFEST), JSON.stringify(manifest));
}
/** Compare every SDK-returned field; only the SDK-managed modification clock is nondeterministic. */
function compare(actual: Rows, expected: Rows, changedId: string | undefined, label: string): void {
  const values = (rows: Rows) => rows.map(row => row.id === changedId ? { ...row, updated_at: '<SDK modification clock>' } : row).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(values(actual), values(expected), label);
}

test(`ownership law ${LAW} ${START}-${START + COUNT - 1}`, { timeout: 600000 }, async t => {
  const target = await tracker(t);
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES; const oldPath = process.env.PATH;
  process.env.GIT_CEILING_DIRECTORIES = dirname(target.root); process.env.PATH = target.root;
  t.after(() => { if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling; if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const beta = await remember('Active reference beta', { ...target.options, slug: 'beta', kind: 'reference', forceNew: true });
  const gamma = await remember('Available feedback gamma', { ...target.options, slug: 'gamma', kind: 'feedback', forceNew: true });
  const archived = await remember('Archived reference record', { ...target.options, slug: 'archived', kind: 'reference', forceNew: true });
  await target.client.update(archived.id, { status: 'canceled', closeReason: 'Law scenario' });
  const artifact = await remember('Harness index artifact', { ...target.options, slug: 'artifact', kind: 'reference', forceNew: true });
  await target.store.fields(artifact.id, { artifact: true });
  const task = (await target.client.create({ title: 'Native Task' })).item;
  const native = (await target.client.create({ title: 'Native Knowledge without memory metadata', type: 'Knowledge' })).item;
  await target.client.schemaAddField('native_hint', { type: 'string', description: 'Foreign metadata for ownership laws' });
  await target.client.run('create', { options: { title: 'Foreign knowledge', type: 'Knowledge', memorySlug: 'foreign', memorySource: 'foreign:law', memoryKind: 'reference' } });
  const foreign = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'foreign')!;
  const alpha = await remember('Bounded policy alpha', { ...target.options, slug: 'alpha', kind: 'project', pin: true });
  if (Math.floor(START / 25) % 2 === 0) await renew('alpha', { ...target.options, from: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', evidence: 'Independent law model' });
  await target.client.run('update', { id: foreign.id, options: { memoryKind: 'unsupported' } });
  if (Math.floor(START / 25) % 4 >= 2) {
    const bootstrap = join(target.root, 'portable-origin');
    await exportDir(bootstrap, { ...target.options, to: 'agents-md' });
    await target.client.run('delete', { id: alpha.id, options: { force: true } });
    await importDir(bootstrap, { ...target.options, from: 'agents-md', createMissingOrigins: true });
    await rm(bootstrap, { recursive: true });
  }
  const alphaId = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!.id;
  const targets = [beta.id, task.id, native.id, archived.id, artifact.id, `${alphaId}-missing`, foreign.id];
  for (let sequence = START; sequence < START + COUNT; sequence++) {
    const seed = (MASTER + Math.imul(sequence, 0x9e3779b9)) >>> 0; const random = randomizer(seed);
    const label = `LAW=${LAW} MASTER_SEED=${MASTER} SEQUENCE=${sequence} SEED=${seed}`;
    const requestedKind = DEPENDENCY_KIND_VALUES[sequence % DEPENDENCY_KIND_VALUES.length];
    const chosen = sequence % targets.length;
    const dependencies = targets.map((id, index) => `id=${id},kind=${index === chosen ? requestedKind : 'related'},author=law-native,created_at=2026-01-01T00:00:00.000Z`);
    try {
      await target.client.run('update', { id: alphaId, options: { title: `Policy ${seed}`, description: `Hook ${seed}`, body: `Body ${seed}`, tags: `native-${seed}`, priority: random() % 4, memorySlug: 'alpha', memoryOriginal: '', memoryPath: '', memoryEdited: false, memoryKind: 'project', memoryWhy: `Why ${seed}`, memoryHow: `How ${seed}`, memoryPinned: true, memoryRecalls: random() % 5, memoryVerdict: 'verified', memoryVerifiedAt: '2026-01-01T00:00:00.000Z', memoryReason: `Native reason ${seed}`, memoryMerge: `Native merge ${seed}`, nativeHint: `Foreign ${seed}`, dep: dependencies, replaceDeps: true, allowUnresolvedDeps: true, allowMissingParent: true } });
      const directory = join(target.root, `case-${sequence}`); const to = sequence % 2 === 0 ? 'agents-md' : 'claude-code';
      await exportDir(directory, { ...target.options, to });
      const before = (await target.client.listAllComplete({ includeBody: true })).items;
      const manifest = JSON.parse(await readFile(join(directory, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
      const row = manifest.guidance.find(row => row.slug === 'alpha')!;
      let referenceAction: Record<string, unknown> = {}; let inputAction: Record<string, unknown> = {};
      if (LAW === 'locality') {
        const count = 1 + random() % 3; const first = random() % FIELDS.length;
        for (let offset = 0; offset < count; offset++) Object.assign(referenceAction, fieldAction(FIELDS[(first + offset) % FIELDS.length], seed + offset, before.find(row => row.id === alphaId)!));
        inputAction = { ...referenceAction };
        const edge = row.relationships[0];
        if (sequence % 4 === 0 && edge !== undefined) {
          row.relationships.splice(0, 1); referenceAction.depRemove = [`id=${before.find(item => item.memory_slug === edge.slug)!.id},kind=${edge.kind}`];
        } else if (sequence % 2 === 0) {
          row.relationships.push({ slug: 'gamma', kind: 'related', author: 'law-portable', created_at: '2026-01-01T00:00:00.000Z' });
          referenceAction.dep = [`id=${gamma.id},kind=related,author=law-portable,created_at=2026-01-01T00:00:00.000Z`];
        }
      }
      if (LAW === 'foreign') {
        const nativeField = FIELDS[random() % FIELDS.length];
        const nativeAction = fieldAction(nativeField, seed + 1000, before.find(row => row.id === alphaId)!);
        await target.client.run('update', { id: alphaId, options: { ...nativeAction, nativeHint: `New foreign ${seed}`, memorySlug: sequence % 5 === 0 ? `native-${seed}` : 'alpha', memoryOriginal: `native-only-original-${seed}`, memoryPath: `native-${seed}.md`, memoryEdited: true, priority: (Number(before.find(row => row.id === alphaId)!.priority) + 1) % 4, dep: [`id=${task.id},kind=supersedes,author=peer-law`] } });
        const edited = sequence % 3 === 0 ? nativeField : FIELDS[(FIELDS.indexOf(nativeField) + 1) % FIELDS.length];
        inputAction = fieldAction(edited, seed + 2000, before.find(row => row.id === alphaId)!);
        if (edited !== nativeField) referenceAction = { ...inputAction };
        if (sequence % 4 === 0 && row.relationships.length > 0) {
          const edge = row.relationships[0]; const id = before.find(item => item.memory_slug === edge.slug)!.id;
          await target.client.update(alphaId, { depRemove: [`id=${id},kind=${edge.kind}`] });
        }
      }
      if (LAW !== 'identity') await edit(directory, row, inputAction, manifest);
      const current = (await target.client.listAllComplete({ includeBody: true })).items;
      let expected = current;
      const changed = Object.keys(referenceAction).length > 0;
      const oracle = join(target.root, `oracle-${sequence}`);
      if (changed) {
        await mkdir(oracle);
        const client = await cloneTracker(target, oracle);
        await client.run('update', { id: alphaId, options: referenceAction });
        expected = (await client.listAllComplete({ includeBody: true })).items;
      }
      await importDir(directory, { ...target.options, from: to });
      const actual = (await target.client.listAllComplete({ includeBody: true })).items;
      compare(actual, expected, changed ? alphaId : undefined, `${label} kind=${requestedKind} targetClass=${chosen}`);
      if (LAW === 'identity') assert.deepEqual(actual, before, label);
      await rm(directory, { recursive: true }); if (changed) await rm(oracle, { recursive: true });
    } catch (cause) { t.diagnostic(`${label} cause=${cause instanceof Error ? cause.message : String(cause)}`); throw new Error(`${label} kind=${requestedKind} targetClass=${chosen}`, { cause }); }
  }
  t.diagnostic(`OWNERSHIP_LAW law=${LAW} start=${START} count=${COUNT} MASTER_SEED=${MASTER}`);
});
