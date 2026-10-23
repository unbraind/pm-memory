import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { createView, grantConsent, inspectView, withdrawConsent, remember, recall, index, packetTokens, MemoryError, exportDir, consolidate, renew } from '../index.ts';
import { readConsent, viewFields, viewPurpose } from '../src/consent.ts';
import { consentScopedExample } from '../examples/consent-scoped-views.ts';
import { validatePublicConsent } from '../examples/validate-consent.ts';
import { runCommand } from '../src/commands.ts';
import { tracker, installExtension, gitlessCli, snapshot } from './helpers.ts';

/** Require a typed refusal and a nonblank remedy without depending on rejected text. */
function refused(error: unknown): boolean { assert.ok(error instanceof MemoryError); assert.ok(error.remedy.length > 0); return true; }

test('consent withdrawal prevents fresh packets and text-free manifests identify every affected output', async t => {
  const { options, store } = await tracker(t);
  const first = await remember('Approved release checklist', { ...options, kind: 'project', slug: 'approved', why: 'FORBIDDEN rationale', how: 'FORBIDDEN instructions' });
  await remember('Legacy independent reference', { ...options, kind: 'reference', slug: 'legacy' });
  await grantConsent('approved', { ...options, purpose: 'review', fields: ['title', 'body'] });
  await grantConsent('approved', { ...options, purpose: 'build', fields: ['body'] });
  const viewOptions = { ...options, purpose: 'review', fields: ['title'] as const, budget: 800 };
  const previous = await createView('release', viewOptions);
  assert.equal(previous.rows.length, 1); assert.equal(previous.excluded, 1);
  assert.deepEqual(Object.keys(previous.rows[0].fields), ['title']);
  assert.ok(!JSON.stringify(previous).includes('FORBIDDEN'));
  assert.ok(!JSON.stringify(previous.manifest).includes('Approved'));
  assert.equal((await inspectView(previous.manifest.packet, options)).affected.length, 0);
  const second = await createView('release', viewOptions);
  const withdrawal = await withdrawConsent('approved', { ...options, purpose: 'review' });
  assert.deepEqual(withdrawal.affected, [previous.manifest.packet, second.manifest.packet]);
  assert.deepEqual((await createView('release', viewOptions)).rows, []);
  assert.deepEqual((await inspectView(previous.manifest.packet, options)).affected, [first.id]);
  assert.equal((await createView('release', { ...viewOptions, purpose: 'build', fields: ['body'] })).rows.length, 1);
  assert.deepEqual((await createView('release', { ...viewOptions, fields: ['why'] })).rows, []);
  await grantConsent('approved', { ...options, purpose: 'review', fields: ['title'] });
  assert.equal((await createView('release', viewOptions)).rows.length, 1);
  assert.deepEqual((await inspectView(previous.manifest.packet, options)).affected, [first.id], 'regrant cannot resurrect old manifests');
  const unscoped = await recall('release', { ...options, semantic: 'off' });
  assert.deepEqual(unscoped.memories!.map(row => row.slug), ['legacy']);
  assert.ok(!(await index(options)).text!.includes('Approved'));
  const ledger = readConsent((await store.read()).find(item => item.id === first.id)!.consent);
  assert.ok(!JSON.stringify(ledger).includes('Approved')); assert.ok(!JSON.stringify(ledger).includes('FORBIDDEN'));
});

test('source revisions, provenance, archive and purpose changes invalidate prior disclosure without leaking content', async t => {
  const { root, options, store, client } = await tracker(t);
  const item = await remember('Original source text', { ...options, kind: 'project', slug: 'source', pin: true });
  const settings = { ...options, purpose: 'review', fields: ['body'] as const };
  await grantConsent('source', settings); const before = await createView('source', settings);
  await remember('Changed source text', { ...options, kind: 'project', update: 'source' });
  assert.equal((await createView('source', settings)).rows.length, 0);
  assert.deepEqual((await inspectView(before.manifest.packet, options)).affected, [item.id]);
  await grantConsent('source', settings); const changed = await createView('source', settings);
  await store.fields(item.id, { source: 'claude-code:memory.md' });
  assert.equal((await createView('source', settings)).rows.length, 0);
  assert.equal((await inspectView(changed.manifest.packet, options)).affected.length, 1);
  await grantConsent('source', settings); const imported = await createView('source', settings);
  await client.update(item.id, { status: 'canceled', message: 'Archive source' });
  assert.equal((await createView('source', settings)).rows.length, 0);
  assert.equal((await inspectView(imported.manifest.packet, options)).affected.length, 1);
  assert.deepEqual((await withdrawConsent('source', { ...options, purpose: 'new-purpose' })).affected, []);
  await store.fields(item.id, { artifact: true });
  await assert.rejects(grantConsent('source', settings), refused);
  await assert.rejects(withdrawConsent('missing', settings), refused);
  assert.equal((await exportDir(root + '/archived-export', { ...options, to: 'claude-code' })).exported, 1);
  await client.update(item.id, { status: 'open', message: 'Keep artifact separate' });
  assert.equal((await exportDir(root + '/artifact-export', { ...options, to: 'claude-code' })).exported, 1);
});

test('view ranking uses requested fields and whole-packet accounting bounds both host formats', async t => {
  const { options } = await tracker(t);
  for (const [key, body] of [['alpha', 'Visible apples'], ['beta', 'Visible oranges'], ['large', 'Huge '.repeat(2000)]]) {
    await remember(body, { ...options, kind: 'project', slug: key, why: key === 'alpha' ? 'Hidden launch instructions' : 'Hidden ranking distraction', forceNew: true });
    await grantConsent(key, { ...options, purpose: 'review', fields: ['body', 'why'] });
  }
  const settings = { ...options, purpose: 'review', fields: ['body'] as const, budget: 800 };
  const visible = await createView('apples', settings);
  assert.equal(visible.rows[0].fields.body, 'Visible apples'); assert.ok(visible.omitted > 0);
  assert.equal(visible.estimated_tokens, packetTokens(visible)); assert.ok(visible.estimated_tokens <= 800);
  assert.ok(!JSON.stringify(visible).includes('Hidden'));
  const hidden = await createView('launch', settings); const neutral = await createView('nonmatching', settings);
  assert.deepEqual(hidden.rows, neutral.rows);
  const small = await createView('apples', { ...settings, budget: 200 });
  assert.ok(packetTokens(small) <= 200);
  await assert.rejects(createView('apples', { ...settings, purpose: 'p'.repeat(64), budget: 1 }), refused);
  await assert.rejects(createView('apples', { ...settings, budget: 0 }), refused);
  const empty = await createView('unknown', { ...settings, purpose: 'ungranted' });
  assert.deepEqual(empty.rows, []); assert.equal(empty.excluded, 3);
  await assert.rejects(inspectView(empty.manifest.packet, options), refused);
});

test('native no-git CLI grant/view/withdraw/manifest emits compact TOON and JSON with safe remedies', async t => {
  const { root, workspace, options } = await tracker(t); await installExtension(workspace);
  await remember('Public release advice', { ...options, kind: 'project', slug: 'release' });
  const cli = gitlessCli(root, workspace);
  const granted = cli(['grant', 'release', '--purpose', 'release-review', '--fields', 'title,body', '--json']); assert.equal(granted.status, 0, granted.stderr);
  let packet = '';
  for (const format of [[], ['--json']]) {
    const result = cli(['view', 'release', '--purpose', 'release-review', '--fields', 'title', '--budget', '300', ...format]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = (format.length ? JSON.parse(result.stdout) : decodeToon(result.stdout));
    assert.equal(parsed.rows.length, 1); assert.ok(parsed.estimated_tokens <= 300); packet = parsed.manifest.packet;
  }
  const withdrawal = cli(['withdraw', 'release', '--purpose', 'release-review', '--json']); assert.equal(withdrawal.status, 0, withdrawal.stderr);
  assert.ok(JSON.parse(withdrawal.stdout).affected.includes(packet));
  const manifest = cli(['manifest', packet, '--json']); assert.equal(manifest.status, 0, manifest.stderr); assert.equal(JSON.parse(manifest.stdout).affected.length, 1);
  assert.ok(!manifest.stdout.includes('Public release advice'));
  const invalid = cli(['grant', 'release', '--purpose', 'review', '--fields', 'original', '--json']); assert.equal(invalid.status, 2); assert.match(invalid.stderr, /Remedy:/);
  const ctx = { command: 'memory view', pm_root: workspace, args: ['release'], options: { purpose: 'release-review', fields: 'title' }, global: { author: 'memory-test' } } as CommandHandlerContext;
  assert.deepEqual((await runCommand('view', ctx) as { rows: unknown[] }).rows, []);
});

test('authorization rejects malformed inputs and ledgers fail closed before any durable writes', async t => {
  const { options, workspace, store } = await tracker(t);
  const item = await remember('Source used for validation', { ...options, kind: 'user', slug: 'source' });
  const before = await snapshot(workspace);
  for (const value of [undefined, null, 1, '', 'UPPER', '-start', 'a/b', 'x'.repeat(65)]) assert.throws(() => viewPurpose(value), refused);
  for (const value of [undefined, {}, [], ['body', 'body'], ['original'], [1]]) assert.throws(() => viewFields(value), refused);
  await assert.rejects(grantConsent('source', { ...options, purpose: 'review', fields: [] }), refused);
  await assert.rejects(createView('', { ...options, purpose: 'review', fields: ['body'] }), refused);
  await assert.rejects(inspectView('invalid', options), refused);
  assert.deepEqual(await snapshot(workspace), before);
  const policy = { purpose: 'review', revision: 1, content: 'a'.repeat(64), fields: ['body'] };
  const output = { packet: 'b'.repeat(24), purpose: 'review', revision: 1, fields: ['body'] };
  const valid = { version: 1, policies: [policy], outputs: [output] };
  assert.deepEqual(readConsent(JSON.stringify(valid)), valid);
  for (const malformed of [
    'broken-json', 'null', '[]', '{}',
    ...[{ version: 2 }, { policies: {} }, { outputs: {} }].map(patch => JSON.stringify({ ...valid, ...patch })),
    ...[null, {}, { ...policy, purpose: 'BAD' }, { ...policy, revision: '1' }, { ...policy, revision: 0 }, { ...policy, content: 1 }, { ...policy, content: '' }, { ...policy, fields: ['original'] }].map(value => JSON.stringify({ ...valid, policies: [value] })),
    JSON.stringify({ ...valid, policies: [policy, policy] }),
    ...[null, {}, { ...output, packet: 1 }, { ...output, packet: 'bad' }, { ...output, purpose: 'BAD' }, { ...output, revision: '1' }, { ...output, revision: 0 }, { ...output, fields: ['original'] }, { ...output, fields: [] }, { ...output, purpose: 'other' }, { ...output, revision: 2 }].map(value => JSON.stringify({ ...valid, outputs: [value] })),
    JSON.stringify({ ...valid, outputs: [output, output] }),
  ]) assert.throws(() => readConsent(malformed), refused);
  await store.fields(item.id, { consent: 'invalid' });
  const corrupted = await snapshot(workspace);
  await assert.rejects(createView('source', { ...options, purpose: 'review', fields: ['body'] }), refused);
  assert.deepEqual(await snapshot(workspace), corrupted);
  assert.deepEqual((await recall('source', options)).memories, [], 'malformed consent cannot downgrade to legacy recall');
  await store.fields(item.id, { consent: JSON.stringify({ version: 1, policies: [{ ...policy, revision: Number.MAX_SAFE_INTEGER }], outputs: [] }) });
  await assert.rejects(withdrawConsent('source', { ...options, purpose: 'review' }), refused);
});

test('concurrent grants and withdrawals serialize on a real shared non-git tracker', async t => {
  const { options } = await tracker(t);
  await remember('Shared serialized source', { ...options, kind: 'project', slug: 'source' });
  const settings = { ...options, purpose: 'review', fields: ['body'] as const };
  const grants = await Promise.all([grantConsent('source', settings), grantConsent('source', settings)]);
  assert.deepEqual(grants.map(result => result.revision).sort(), [1, 2]);
  const [packet] = await Promise.all([createView('source', settings), withdrawConsent('source', settings)]);
  assert.deepEqual((await createView('source', settings)).rows, []);
  if (packet.rows.length > 0) assert.equal((await inspectView(packet.manifest.packet, options)).affected.length, 1);
});


test('portable exports and consolidation cannot strip consent from a source', async t => {
  const { root, options, workspace, store } = await tracker(t);
  const first = await remember('Matching consent source advice', { ...options, kind: 'project', slug: 'source' });
  await remember('Matching consent source advice', { ...options, kind: 'project', slug: 'duplicate', forceNew: true });
  await grantConsent('duplicate', { ...options, purpose: 'review', fields: ['body'] });
  const before = await snapshot(workspace);
  await assert.rejects(exportDir(root + '/exported', { ...options, to: 'claude-code' }), refused);
  assert.ok((await consolidate(options)).proposals.some(proposal => proposal.action === 'merge'));
  await assert.rejects(consolidate({ ...options, apply: true }), refused);
  assert.deepEqual(await snapshot(workspace), before);
  await grantConsent('source', { ...options, purpose: 'review', fields: ['body'] });
  await assert.rejects(consolidate({ ...options, apply: true }), refused);
  await store.fields(first.id, { pinned: true });
  await renew('source', { ...options, from: '2020-01-01T00:00:00.000Z', until: '2020-02-01T00:00:00.000Z', evidence: 'Historical review' });
  await grantConsent('source', { ...options, purpose: 'review', fields: ['body'] });
  assert.ok(!(await createView('advice', { ...options, purpose: 'review', fields: ['body'] })).rows.some(row => row.id === first.id), 'consent cannot override expired guidance');
});


test('typed examples exercise the lifecycle and public-copy measurement helper', async t => {
  const { options } = await tracker(t);
  const lifecycle = await consentScopedExample(options);
  assert.equal(lifecycle.impact.affected.length, 1);
  const publicCopy = await tracker(t); const scratch = await tracker(t);
  await publicCopy.client.create({ title: 'Public fleet feature', description: 'Public fleet description' });
  const measured = await validatePublicConsent(publicCopy.workspace, scratch.options);
  assert.equal(measured.sourceItems, 1); assert.equal(measured.emittedBefore, 1);
  assert.equal(measured.emittedAfter, 0); assert.equal(measured.affectedSources, measured.expectedAffectedSources);
  assert.equal(measured.unapprovedFields, 0); assert.equal(measured.manifestTextFields, 0);
});

test('manifest inspection rejects unauthorized fields even in a structurally valid policy with an unchanged revision', async t => {
  const { options, store } = await tracker(t);
  const item = await remember('Policy integrity source', { ...options, kind: 'reference', slug: 'source' });
  await grantConsent('source', { ...options, purpose: 'review', fields: ['body'] });
  const packet = await createView('source', { ...options, purpose: 'review', fields: ['body'] });
  const ledger = readConsent((await store.read())[0].consent); ledger.policies[0].fields = [];
  await store.fields(item.id, { consent: JSON.stringify(ledger) });
  assert.deepEqual((await inspectView(packet.manifest.packet, options)).affected, [item.id]);
});
