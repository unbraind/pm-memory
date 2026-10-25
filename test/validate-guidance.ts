/** Read-only public-corpus validation: project real text with declared scenario windows, never mutate the tracker. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { certifyCompleteListResult, PmClient } from '@unbrained/pm-cli/sdk';
import { eligibleGuidance, guidanceHash, guidanceState } from '../src/guidance.ts';
import { scored, recallPacket } from '../src/memory.ts';
import { packetTokens } from '../src/core.ts';
import type { Memory, RecallRow } from '../src/types.ts';

const workspace = process.argv[2];
const now = Date.parse('2026-10-21T12:00:00.000Z');
mock.timers.enable({ apis: ['Date'], now });
const client = new PmClient({ pmRoot: workspace, noExtensions: true });
const corpus = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
const memories: Memory[] = corpus.items.map((item, position) => {
  const memory: Memory = { id: item.id, slug: item.id, title: item.title, description: item.description, body: String(item.body), kind: 'project', why: '', how: '', pinned: true, source: 'public-tracker:read-only-projection', updated: item.updated_at, merge: '', recalls: 0, verdict: 'unknown', status: 'open', tags: item.tags, path: '', original: '', edited: false, artifact: false, relationships: [], links: [] };
  const state = position % 4;
  memory.validity = { from: state === 2 ? '2026-11-01T00:00:00.000Z' : '2026-10-01T00:00:00.000Z', until: state === 1 ? '2026-10-20T00:00:00.000Z' : '2026-12-01T00:00:00.000Z', evidence: 'Validation scenario over read-only public tracker text', recordedAt: '2026-10-01T00:00:00.000Z', contentHash: state === 3 ? '0'.repeat(64) : guidanceHash(memory), revision: 1 };
  return memory;
});
const states = Object.fromEntries(['current', 'expired', 'scheduled', 'needs-renewal'].map(state => [state, memories.filter(item => guidanceState(item, now) === state).length]));
const visible = eligibleGuidance(memories, 'exclude', now);
assert.equal(visible.length, states.current);
assert.equal(eligibleGuidance(memories, 'label', now).length, memories.length);
const results = (['exclude', 'label'] as const).map(policy => {
  const entries = scored(eligibleGuidance(memories, policy, now), 'memory guidance');
  const rows: RecallRow[] = entries.map(({ item, score }) => ({ slug: item.slug, pinned: item.pinned, validity: guidanceState(item, now), valid_from: item.validity!.from, valid_until: item.validity!.until, score, description: item.description.slice(0, 60) }));
  const packet = recallPacket(rows, entries.map(row => row.item), 'memory guidance', 800);
  assert.ok(packetTokens(packet) <= 800);
  assert.ok(packet.memories!.every(row => policy === 'label' || row.validity === 'current'));
  return { policy, eligible: entries.length, emitted: packet.memories!.length, omitted: packet.omitted, estimated_tokens: packet.estimated_tokens };
});
console.log(JSON.stringify({ items: corpus.items.length, bodies: corpus.items.filter(item => String(item.body).trim().length > 0).length, input_bytes: Buffer.byteLength(JSON.stringify(corpus.items)), states, results }, null, 2));
