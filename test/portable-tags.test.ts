import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { itemDocumentToMutationOptions } from '@unbrained/pm-cli/sdk';
import { remember, exportDir, importDir } from '../index.ts';
import { tracker } from './helpers.ts';

/** Let the native SDK normalize the oracle, then read its authoritative tag values. */
async function nativeTags(target: Awaited<ReturnType<typeof tracker>>, id: string, tags: readonly string[]) {
  await target.client.run('update', { id, options: itemDocumentToMutationOptions(JSON.stringify({ tags }), 'update') });
  return (await target.client.get(id, { full: true })).item.tags;
}

test('all native tag writes use the SDK codec across remember and portable create update paths', async t => {
  for (const tags of [['one,two', 'quote"tag'], [' spaced tag ', 'é.tag', '[bracket]']]) {
    const source = await tracker(t); const item = await remember('Tag codec guidance', { ...source.options, slug: 'codec', kind: 'reference' });
    const expected = await nativeTags(source, item.id, tags);
    const native = await tracker(t); const created = await remember('Tag codec guidance', { ...native.options, slug: 'codec', kind: 'reference', tags });
    assert.deepEqual((await native.client.get(created.id, { full: true })).item.tags, expected, 'Remember creation must match the native SDK oracle');
    for (const to of ['agents-md', 'claude-code'] as const) {
      const first = join(source.root, `${to}-first`); await exportDir(first, { ...source.options, to });
      const target = await tracker(t); await importDir(first, { ...target.options, from: to });
      const imported = (await target.client.listAllComplete({ includeBody: true })).items.find(row => row.memory_slug === 'codec')!;
      assert.deepEqual(imported.tags, expected, 'Portable creation must match the native SDK oracle');
      const next = [...tags, 'next,tag'];
      const updated = await nativeTags(source, item.id, next);
      await remember('Updated tag codec guidance', { ...native.options, slug: 'codec', kind: 'reference', tags: next });
      assert.deepEqual((await native.client.get(created.id, { full: true })).item.tags, updated, 'Remember updates must match the native SDK oracle');
      const second = join(source.root, `${to}-second`); await exportDir(second, { ...source.options, to });
      await importDir(second, { ...target.options, from: to });
      assert.deepEqual((await target.client.get(imported.id, { full: true })).item.tags, updated, 'Portable updates must match the native SDK oracle');
      await nativeTags(source, item.id, tags);
    }
  }
});
