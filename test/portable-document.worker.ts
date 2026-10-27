import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalDocument } from '@unbrained/pm-cli/sdk';
import { exportDir, importDir, remember, POLICY_MANIFEST } from '../index.ts';
import type { Harness, PortablePolicyManifest } from '../index.ts';
import { tracker, withoutGit } from './helpers.ts';

const START = Number(process.env.PM_MEMORY_DOCUMENT_START);
const COUNT = Number(process.env.PM_MEMORY_DOCUMENT_COUNT);
const MASTER = 0x1363d0c4;
assert.ok(Number.isInteger(START) && START >= 0 && START < 500);
assert.ok(Number.isInteger(COUNT) && COUNT > 0 && COUNT <= 25 && START + COUNT <= 500);

/** An independent xorshift stream varies document layout, keys and nested values. */
function documentRandom(seed: number): () => number {
  let state = seed;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

test(`complete document law ${START}-${START + COUNT - 1}`, { timeout: 1200000 }, async t => {
  const source = await tracker(t);
  const contexts = new Map<string, { target: Awaited<ReturnType<typeof tracker>>; input: string; name: string }>();
  withoutGit(t, source.root);
  for (let sequence = START; sequence < START + COUNT; sequence++) {
    const seed = (MASTER + Math.imul(sequence, 0x9e3779b9)) >>> 0;
    const random = documentRandom(seed);
    const mode = sequence % 8; const policy = mode >= 4; const fullLegacy = mode >= 6; const nativeBody = mode === 4 || mode === 5; const from: Harness = mode % 2 === 0 ? 'agents-md' : 'claude-code';
    const label = `MASTER_SEED=${MASTER} SEQUENCE=${sequence} SEED=${seed} mode=${mode}`;
    try {
      const key = `${from}/${fullLegacy ? 'full-policy' : policy ? 'policy' : 'legacy'}`;
      if (!contexts.has(key)) {
        const target = await tracker(t); const input = join(target.root, 'input');
        const name = from === 'agents-md' ? 'AGENTS.md' : 'alpha.md';
        if (fullLegacy) {
          const raw = join(target.root, 'raw'); await mkdir(raw);
          await writeFile(join(raw, name), '---\nname: alpha\ncustom: initial\n---\nInitial source body');
          if (from === 'claude-code') await writeFile(join(raw, 'MEMORY.md'), '- [Alpha](alpha.md)\n');
          await importDir(raw, { ...target.options, from });
          const id = (await target.client.listAllComplete()).items.find(row => row.memory_slug === 'alpha')!.id;
          await target.client.run('update', { id, options: { memoryPinned: true } });
          await exportDir(input, { ...target.options, to: from });
        }
        else if (policy) { await remember('Initial policy body', { ...target.options, slug: 'alpha', kind: 'reference' }); await exportDir(input, { ...target.options, to: from }); }
        else { await mkdir(input); if (from === 'claude-code') await writeFile(join(input, 'MEMORY.md'), '- [Alpha](alpha.md)\n'); }
        contexts.set(key, { target, input, name });
      }
      const { target, input, name } = contexts.get(key)!;
      const newline = random() % 2 === 0 ? '\n' : '\r\n';
      const unknown = ['constructor', '__proto__', `custom_${random()}`, 'opaque key with spaces'][random() % 4];
      const values = [null, false, random() % 1000, [' spaced value ', { nested: [random() % 20, true, null] }], { [unknown]: { order: random() % 99, text: 'retain Unicode Ω and spaces ' } }];
      const oldValue = `old-${seed}`; const newValue = `new-${seed}`;
      const entries = [`name: alpha`, `${JSON.stringify(unknown)}: ${JSON.stringify(values[random() % values.length])}`, `changed_${seed}: ${JSON.stringify(oldValue)}`, `nested_${seed}: ${JSON.stringify(values[random() % values.length])}`];
      if (random() % 2 === 0) entries.reverse();
      const prefix = `${random() % 2 === 0 ? '\uFEFF' : ''}---${newline}${entries.join(newline + (random() % 2 === 0 ? '# retained comment' + newline : ''))}${newline}---${newline}`;
      let first = `${prefix}${newline}# Guidance${newline}${newline}## Opaque body section${newline}\tKeep ${seed}.  ${newline}${' '.repeat(random() % 4)}${newline}`;
      let file = join(input, name);
      if (policy) {
        const manifest = JSON.parse(await readFile(join(input, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest;
        file = join(input, manifest.guidance[0].path);
        const marker = (await readFile(file, 'utf8')).split('\n')[0] + '\n'; await writeFile(file, marker + first);
      } else await writeFile(file, first);
      await importDir(input, { ...target.options, from });
      if (fullLegacy) {
        const row = (await target.client.listAllComplete()).items.find(item => item.memory_slug === 'alpha')!;
        await target.client.run('update', { id: row.id, options: { title: `Native title ${seed}`, memoryWhy: `Native rationale ${seed}`, memoryHow: `Native instruction ${seed}`, body: `Native body ${seed}\n**Why:** Body rationale ${seed}\n**How to apply:** Body instruction ${seed}` } });
        const stored = (await target.client.get(row.id, { full: true })).item.body; assert.ok(typeof stored === 'string');
        first = prefix + stored;
      }
      const second = first.replace(oldValue, newValue);
      const exported = join(target.root, `case-${sequence}-a`); await exportDir(exported, { ...target.options, to: from });
      let emitted = name;
      if (policy) emitted = (JSON.parse(await readFile(join(exported, POLICY_MANIFEST), 'utf8')) as PortablePolicyManifest).guidance[0].path;
      const bytes = await readFile(join(exported, emitted), 'utf8');
      assert.equal(policy ? bytes.slice(bytes.indexOf('\n') + 1) : bytes, first, label);
      assert.equal((await importDir(exported, { ...target.options, from })).updated, 0, label);
      const before = (await target.client.listAllComplete({ includeBody: true })).items;
      const edited = mode === 2 || mode === 3 || policy ? exported : input;
      const editedFile = join(edited, policy ? emitted : name);
      const marker = policy ? bytes.slice(0, bytes.indexOf('\n') + 1) : '';
      await writeFile(editedFile, marker + second);
      const receipt = await importDir(edited, { ...target.options, from });
      assert.equal(receipt.updated, 1, label); assert.equal(receipt.imported, 0, label);
      const after = (await target.client.listAllComplete({ includeBody: true })).items;
      for (const original of before) {
        const actual = after.find(row => row.id === original.id)!;
        if (original.memory_slug !== 'alpha') assert.deepEqual(actual, original, label);
        else {
          const snapshot = JSON.parse(String(nativeBody ? actual.memory_policy_body : actual.memory_document)) as { original: string };
          assert.equal(Buffer.from(snapshot.original, 'base64').toString('utf8'), second, label);
          if (nativeBody) { const { body: _body, ...metadata } = original; assert.equal(actual.body, canonicalDocument({ metadata, body: second }).body, label); }
          assert.deepEqual(actual, { ...original, ...(nativeBody ? { body: actual.body, memory_policy_body: actual.memory_policy_body } : { memory_document: actual.memory_document }), updated_at: actual.updated_at }, label);
        }
      }
      const output = join(target.root, `case-${sequence}-b`); await exportDir(output, { ...target.options, to: from });
      const finalBytes = await readFile(join(output, emitted), 'utf8');
      assert.equal(policy ? finalBytes.slice(finalBytes.indexOf('\n') + 1) : finalBytes, second, label);
      assert.equal((await importDir(output, { ...target.options, from })).updated, 0, label);
      assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, after, label);
      await rm(exported, { recursive: true }); await rm(output, { recursive: true });
    } catch (cause) { t.diagnostic(label); throw new Error(label, { cause }); }
  }
  t.diagnostic(`DOCUMENT_LAW start=${START} count=${COUNT} MASTER_SEED=${MASTER}`);
});
