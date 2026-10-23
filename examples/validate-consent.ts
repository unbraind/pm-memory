import { certifyCompleteListResult, PmClient } from '@unbrained/pm-cli/sdk';
import { createView, grantConsent, inspectView, packetTokens, remember, withdrawConsent } from '../index.ts';
import type { MemoryOptions } from '../index.ts';

/** Measure recall authorization using a read-only public tracker and a separate non-git scratch tracker. */
export async function validatePublicConsent(publicWorkspace: string, scratch: MemoryOptions) {
  const reader = new PmClient({ pmRoot: publicWorkspace, noExtensions: true });
  const source = certifyCompleteListResult(await reader.listAllComplete({ includeBody: true }));
  const slugs: string[] = [];
  for (const [position, item] of source.items.entries()) {
    const key = `public-${position}`;
    await remember(item.title, { ...scratch, kind: 'reference', slug: key, why: item.description, forceNew: true });
    slugs.push(key);
    await grantConsent(key, { ...scratch, purpose: 'public-review', fields: ['title'] });
  }
  const settings = { ...scratch, purpose: 'public-review', fields: ['title'] as const, budget: 1500 };
  const before = await createView('memory', settings);
  const ids = new Set(before.rows.map(row => row.id));
  // Withdraw every source, including those previously omitted by the budget.
  let affectedOutputs = 0;
  for (const key of slugs) affectedOutputs += (await withdrawConsent(key, { ...scratch, purpose: 'public-review' })).affected.length;
  const after = await createView('memory', settings);
  const impact = await inspectView(before.manifest.packet, scratch);
  return {
    sourceItems: source.items.length, derivedMemories: slugs.length, grantedSources: slugs.length,
    withdrawnSources: slugs.length, emittedBefore: before.rows.length, omittedBefore: before.omitted,
    emittedAfter: after.rows.length, affectedOutputReferences: affectedOutputs,
    affectedSources: impact.affected.length, expectedAffectedSources: ids.size,
    beforeTokens: packetTokens(before), afterTokens: packetTokens(after), budget: settings.budget,
    unapprovedFields: before.rows.flatMap(row => Object.keys(row.fields).filter(field => field !== 'title')).length,
    manifestTextFields: before.manifest.sources.flatMap(row => Object.keys(row).filter(field => !['id', 'revision', 'fields'].includes(field))).length,
  };
}
