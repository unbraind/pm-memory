import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { PmClient, certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import { remember, renew, exportDir, importDir, get, guidanceState, parsePolicy, POLICY_MANIFEST } from '../index.ts';
import type { PortablePolicyManifest } from '../index.ts';

/** Replay public tracker text in fresh non-git trackers with explicitly synthetic review windows. */
export async function validatePortable(publicWorkspace: string, scratch: string) {
  const corpus = certifyCompleteListResult(await new PmClient({ pmRoot: publicWorkspace, noExtensions: true }).listAllComplete({ includeBody: true }));
  const workspace = join(scratch, 'source'); const target = join(scratch, 'target');
  for (const pmRoot of [workspace, target]) await new PmClient({ pmRoot, noExtensions: true }).init('portable-validation', { defaults: true, agentGuidance: 'skip', mergeFence: false });
  const options = { workspace, author: 'portable-validation' };
  for (const [index, item] of corpus.items.entries()) {
    const key = `public-${index}`;
    await remember(`${item.title}\n${String(item.body)}`, { ...options, slug: key, kind: 'project', pin: true, forceNew: true, why: item.description });
    for (let revision = 1; revision <= 2; revision++) await renew(key, { ...options, from: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z', evidence: `Synthetic validation review ${revision}; public source item ${item.id}` });
  }
  const results = [];
  for (const to of ['agents-md', 'claude-code'] as const) {
    const directory = join(scratch, to); await exportDir(directory, { ...options, to });
    const manifest: PortablePolicyManifest = parsePolicy(JSON.parse(await readFile(join(directory, POLICY_MANIFEST), 'utf8')));
    const before = await importDir(directory, { workspace: target, from: to, author: 'portable-validation' });
    const repeated = await importDir(directory, { workspace: target, from: to, author: 'portable-validation' });
    assert.equal(repeated.unchanged, corpus.items.length);
    let renewals = 0;
    for (const row of manifest.guidance) {
      assert.deepEqual((await get(row.slug, { workspace: target })).validity, row.validity);
      renewals += row.renewals.length;
    }
    const first = manifest.guidance[0];
    const bodyPath = join(directory, first.path); const original = await readFile(bodyPath, 'utf8');
    await writeFile(bodyPath, original + '\nHarness validation edit');
    const editedTarget = join(scratch, `edited-${to}`);
    await new PmClient({ pmRoot: editedTarget, noExtensions: true }).init('portable-validation', { defaults: true, agentGuidance: 'skip', mergeFence: false });
    await importDir(directory, { workspace: editedTarget, from: to });
    const changed = guidanceState(await get(first.slug, { workspace: editedTarget }), Date.parse('2026-10-15T00:00:00.000Z'));
    assert.equal(changed, 'needs-renewal');
    results.push({ harness: to, exportedFiles: manifest.guidance.length + 2, firstReceipt: before, unchanged: repeated.unchanged, renewals, editedState: changed });
  }
  return { publicItems: corpus.items.length, bodies: corpus.items.filter(item => String(item.body).trim() !== '').length, inputBytes: Buffer.byteLength(JSON.stringify(corpus.items)), results };
}
