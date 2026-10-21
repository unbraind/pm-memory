/** Replay outcome annotations against a disposable copy of a public, read-only tracker. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certifyCompleteListResult, PmClient, readSettings, resolveRuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import type { ObserveOptions } from '../index.ts';
import { observe, packetTokens, recall, remember, utility } from '../index.ts';

/** Fingerprint the bounded source tree and make only the disposable copy writable. */
async function inventory(root: string, writable = false): Promise<{ files: number; digest: string }> {
  const hash = createHash('sha256'); let files = 0;
  /** Visit stable relative names so source immutability can be checked independently of SDK reads. */
  async function walk(relative: string): Promise<void> {
    const directory = join(root, relative);
    if (writable) await chmod(directory, 0o700);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      assert.ok(!entry.isSymbolicLink(), 'Public tracker must not contain symlinks');
      if (entry.isDirectory()) await walk(name);
      else { hash.update(name).update('\0').update(await readFile(join(root, name))).update('\0'); files++; if (writable) await chmod(join(root, name), 0o600); }
    }
  }
  await walk(''); return { files, digest: hash.digest('hex') };
}

const source = process.argv[2];
assert.ok(source, 'Pass the extracted public tracker directory; git is not required');
const before = await inventory(source);
const scratch = await mkdtemp(join(tmpdir(), 'memory-utility-public-'));
try {
  const workspace = join(scratch, 'tracker');
  await cp(source, workspace, { recursive: true }); await inventory(workspace, true);
  const client = new PmClient({ pmRoot: workspace, author: 'utility-validation', noExtensions: true });
  const options = { workspace, author: 'utility-validation' };
  const corpus = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
  const statuses = resolveRuntimeStatusRegistry((await readSettings(workspace)).schema);
  const completed = corpus.items.filter(item => item.type !== 'Knowledge' && statuses.terminal_statuses.has(item.status) && (item.completed_at ?? item.closed_at ?? '') !== '').sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(completed.length >= 6, 'Public tracker needs at least six completed tasks');
  const memory = await remember('Check acceptance evidence before claiming that guidance improved a task', { ...options, kind: 'project', slug: 'outcome-validation-guidance', forceNew: true });
  const packet = await recall('acceptance evidence guidance task', options);
  assert.ok(packet.recall && packet.memories?.some(row => row.slug === memory.slug));
  for (const [index, task] of completed.slice(0, 6).entries()) {
    const observation: ObserveOptions = { ...options, recall: packet.recall, task: task.id, feedback: index % 2 === 0 ? 'helpful' as const : 'unhelpful' as const, outcome: 'improved' as const, attribution: index < 3 ? 'confounded' as const : 'isolated' as const, evidence: 'Scripted retrospective annotation for validation only; the public task completed before recall. No prospective benefit was measured.' };
    assert.equal((await observe(memory.slug, observation)).recorded, true);
    assert.equal((await observe(memory.slug, observation)).recorded, false);
  }
  const report = await utility(memory.slug, options);
  assert.equal(report.lifetime.observations, 6); assert.equal(report.lifetime.scored, 0);
  assert.equal(report.lifetime.unscored.confounded, 3); assert.equal(report.lifetime.unscored.not_later, 3);
  const after = await inventory(source); assert.deepEqual(after, before);
  console.log(JSON.stringify({ source_files: before.files, source_sha256: before.digest, source_items: corpus.items.length, completed_source_items: completed.length, source_unchanged: true, git_required: false, annotations: 'scripted validation labels on real historical tasks; no measured causal benefit', idempotent_retries: 6, recall_tokens: packet.estimated_tokens, report_tokens: packetTokens(report), report }, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
