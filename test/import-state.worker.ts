import { seedLedger } from './property-seeds.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { exportDir, importDir, recall, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';
import { policyBody } from '../src/portable.ts';
import { clonedTracker, propertyTracker, withoutGit } from './helpers.ts';
import { sourceFixture as fixture } from './import-state-helpers.ts';

const START = Number(process.env.PM_MEMORY_OWNED_START);
const COUNT = Number(process.env.PM_MEMORY_OWNED_COUNT);
assert.ok(Number.isInteger(START) && START >= 0 && START < 500 && START % 5 === 0);
assert.equal(COUNT, 5);

test(`owned state batch ${START}: seeded field add/change/remove and recall`, { timeout: 600000 }, async t => {
  const executed = seedLedger(t, 'OWNED', START, COUNT);
  const master = 0x1363f014; let random = master;
  const base = await fixture(t, 'raw', undefined, propertyTracker); withoutGit(t, base.root);
  await writeFile(join(base.path, 'beta.md'), '# Beta\nIndependent target');
  await writeFile(join(base.path, 'MEMORY.md'), '- [Alpha](alpha.md)\n- [Beta](beta.md)\n');
  await writeFile(base.file, '---\nname: alpha\ndescription: Initial hook\ntype: project\n---\n# Alpha\nInitial content [[beta]]\n**Why:** Initial evidence\n**How to apply:** Initial application\n');
  await importDir(base.path, { ...base.options, from: base.from });
  const alpha = (await base.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!;
  const companion = join(base.root, 'companion'); const policy = join(base.root, 'policy');
  await exportDir(companion, { ...base.options, to: 'claude-code' }); await exportDir(policy, { ...base.options, to: 'agents-md' });
  const task = await base.client.create({ title: 'Native Task outside portable ownership' });
  await base.client.update(alpha.id, { priority: 1, dep: [`id=${task.item.id},kind=related`] });
  for (let sequence = 0; sequence < START; sequence++) random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
  let completedCount = 0;
  for (let sequence = START; sequence < START + COUNT; sequence++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0; const seed = random;
    let completed = false;
    await t.test(`master=${master} seed=${seed} sequence=${sequence}`, async context => {
      const target = await clonedTracker(context, base);
      await cp(join(base.workspace, 'transactions'), join(target.workspace, 'transactions'), { recursive: true });
      const mode = sequence % 3; const path = join(target.root, 'source'); await cp(mode === 0 ? base.path : mode === 1 ? companion : policy, path, { recursive: true });
      const from = mode === 2 ? 'agents-md' : 'claude-code';
      let file = join(path, 'alpha.md'); let marker = ''; let manifest: PortablePolicyManifest | undefined;
      if (mode === 2) {
        manifest = JSON.parse(await readFile(join(path, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
        file = join(path, manifest.guidance.find(row => row.slug === 'alpha')!.path);
        const content = await readFile(file, 'utf8'); marker = content.slice(0, content.indexOf('\n') + 1);
      }
      for (let step = 0; step < 3; step++) {
        const has = (offset: number) => (step + (seed >>> offset) % 3) % 3 !== 1;
        const named = has(0); const described = has(2); const classified = has(4); const why = has(6); const how = has(8); const linked = has(10);
        const value = `Value ${seed} ${step}`; const category = (seed & 128) === 0 ? 'feedback' : 'reference'; const application = (seed & 256) === 0 ? `Apply ${value}` : '';
        const body = `# Alpha\n${value}${linked ? ' [[beta]]' : ''}\n${why ? `**Why:** Evidence ${value}\n` : ''}${how ? `**How to apply:** ${application}\n` : ''}`;
        const original = `---\n${named ? 'name: alpha\n' : ''}${described ? `description: Hook ${value}\n` : ''}${classified ? `type: ${category}\n` : ''}custom:\n  evidence: ${value}\n---\n${body}`;
        if (manifest !== undefined) {
          const row = manifest.guidance.find(row => row.slug === 'alpha')!; row.tags = has(12) ? [`tag-${seed}-${step}`] : []; row.pinned = has(14); marker = policyBody(row, '').toString('utf8');
          await writeFile(join(path, POLICY_MANIFEST), JSON.stringify(manifest));
        }
        await writeFile(file, marker + original);
        const result = await importDir(path, { ...target.options, from });
        assert.equal(result.updated, 1, `seed=${seed} step=${step} ${JSON.stringify(result)}`);
        const actual = (await target.client.get(alpha.id, { full: true })).item;
        assert.equal(actual.body, body.trim()); assert.equal(actual.title, named ? 'alpha' : 'Alpha');
        assert.equal(actual.description, described ? `Hook ${value}` : '');
        if (classified) assert.equal(actual.memory_kind ?? 'reference', category); else assert.equal(actual.memory_kind, undefined);
        assert.equal(actual.memory_why, why ? `Evidence ${value}` : undefined);
        if (how) assert.equal(actual.memory_how ?? '', application); else assert.equal(actual.memory_how, undefined);
        assert.equal(actual.priority, 1); assert.equal(actual.dependencies?.some(edge => edge.id === task.item.id), true);
        const beta = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'beta')!;
        assert.equal(actual.dependencies?.some(edge => edge.id === beta.id) ?? false, linked);
        assert.deepEqual(actual.tags, mode === 2 && has(12) ? [`tag-${seed}-${step}`] : []); assert.equal(actual.memory_pinned, mode === 2 && has(14));
        assert.equal(Buffer.from(JSON.parse(String(actual.memory_document)).original, 'base64').toString('utf8'), original);
        const packet = await recall('Alpha', { ...target.options, semantic: 'off', budget: 2000 });
        const recalled = packet.memories!.find(row => row.slug === 'alpha')!;
        assert.ok(recalled.text?.includes(value)); assert.equal(recalled.text?.includes('Apply Value'), how && application !== '');
        const output = join(target.root, `round-trip-${step}`); await exportDir(output, { ...target.options, to: from });
        assert.equal((await importDir(output, { ...target.options, from })).updated, 0);
      }
      await rm(target.root, { recursive: true, force: true }); completed = true;
    });
    assert.equal(completed, true, `Seed ${seed} failed before completing its sequence`);
    completedCount++; executed.push({ sequence, seed });
  }
  assert.equal(completedCount, COUNT);
  t.diagnostic(`OWNED_STATE_BATCH start=${START} count=${COUNT} STEPS=${COUNT * 3} MASTER_SEED=0x${master.toString(16)}`);
});
