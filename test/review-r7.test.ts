import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Store } from '../src/store.ts';
import { MemoryError, privacy } from '../src/core.ts';
import { importDir, remember, verify } from '../index.ts';
import { snapshot, tracker } from './helpers.ts';

test('import refuses multiline credentials before any durable writes in every harness', async t => {
  const { root, options } = await tracker(t);
  await remember('Keep existing safe guidance', { ...options, kind: 'reference' });
  const before = await snapshot(options.workspace);
  const source = join(root, 'source'); await mkdir(source);
  const secret = 'synthetic-credential-value';
  for (const from of ['claude-code', 'agents-md', 'cursor'] as const) {
    for (const newline of ['\n', '\r\n']) {
      for (const credential of [`api_key:${newline}  ${secret}`, `Authorization:${newline}  Bearer ${secret}`]) {
        const content = `---${newline}name: synthetic-guide${newline}${credential}${newline}---${newline}Portable guidance${newline}`;
        assert.throws(() => privacy(content), /Credential-shaped/);
        await writeFile(join(source, 'guide.md'), content);
        await assert.rejects(importDir(source, { ...options, from, allowEmail: true }), (error: unknown) => {
          assert.ok(error instanceof MemoryError);
          assert.equal(error.code, 'privacy');
          assert.match(error.message, /guide\.md:multiline \(Credential-shaped memory refused\)/);
          assert.ok(!error.message.includes(secret));
          return true;
        });
        assert.deepEqual(await snapshot(options.workspace), before);
      }
    }
  }
});

test('whole-file privacy refusals retain safe line diagnostics across the full import batch', async t => {
  const { root, options } = await tracker(t);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'line.md'), 'Safe guidance\npassword=synthetic-credential-value\n');
  await writeFile(join(source, 'multiline.md'), 'api_key:\n  synthetic-credential-value\n');
  const before = await snapshot(options.workspace);
  await assert.rejects(importDir(source, { ...options, from: 'claude-code' }), (error: unknown) => {
    assert.ok(error instanceof MemoryError);
    assert.match(error.message, /line\.md:line 2/);
    assert.match(error.message, /multiline\.md:multiline/);
    assert.ok(!error.message.includes('synthetic-credential-value'));
    return true;
  });
  assert.deepEqual(await snapshot(options.workspace), before);
});

test('verification excludes custom tracker text through resolved and real workspace paths', async t => {
  const fixture = await tracker(t);
  const workspace = join(fixture.root, 'tracker'); await rename(fixture.workspace, workspace);
  const alias = join(fixture.root, 'tracker-alias'); await symlink(workspace, alias);
  const source = join(fixture.root, 'src'); await mkdir(source);
  await writeFile(join(source, 'entry.ts'), 'export const presentSymbol = "--present-option";\n');
  // A sibling sharing the tracker prefix remains valid source evidence.
  const sibling = join(fixture.root, 'tracker-source'); await mkdir(sibling);
  await writeFile(join(sibling, 'entry.ts'), 'export const siblingSymbol = true;\n');
  const options = { ...fixture.options, workspace };
  await remember('Use `src/entry.ts` absentSymbol() --absent-option', { ...options, kind: 'project', slug: 'absent' });
  await remember('Use `src/entry.ts` presentSymbol() --present-option', { ...options, kind: 'project', slug: 'present' });
  await remember('Use siblingSymbol()', { ...options, kind: 'project', slug: 'sibling' });
  for (const location of [workspace, relative(process.cwd(), workspace), alias]) {
    const result = await verify({ ...options, workspace: location, root: fixture.root });
    assert.equal(result.checked, 3);
    assert.equal(result.stale, 1);
    const absent = result.results.find(row => row.slug === 'absent')!;
    assert.equal(absent.verdict, 'stale');
    assert.equal(absent.claims.find(claim => claim.type === 'symbol')!.verdict, 'stale');
    assert.equal(absent.claims.find(claim => claim.type === 'flag')!.verdict, 'unknown');
    for (const slug of ['present', 'sibling']) assert.equal(result.results.find(row => row.slug === slug)!.verdict, 'verified');
    assert.equal((await new Store({ ...options, workspace: location }).read()).find(row => row.slug === 'absent')!.verdict, 'stale');
  }
  // A root inside the tracker must also contribute no textual evidence.
  const nested = await verify({ ...options, root: join(workspace, 'knowledge'), slug: 'sibling' });
  assert.equal(nested.results[0].verdict, 'unknown');
});
