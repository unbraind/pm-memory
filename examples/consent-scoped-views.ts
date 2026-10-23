import { createView, grantConsent, inspectView, remember, withdrawConsent } from '../index.ts';
import type { MemoryOptions } from '../index.ts';

/** Grant only the release heading, then withdraw and identify the affected output. */
export async function consentScopedExample(options: MemoryOptions) {
  await remember('Run both release gates', { ...options, kind: 'project', slug: 'release-policy', why: 'Internal rationale stays out of this view' });
  await grantConsent('release-policy', { ...options, purpose: 'release-review', fields: ['title'] });
  const packet = await createView('release', { ...options, purpose: 'release-review', fields: ['title'], budget: 800 });
  const withdrawal = await withdrawConsent('release-policy', { ...options, purpose: 'release-review' });
  const impact = await inspectView(packet.manifest.packet, options);
  return { packet, withdrawal, impact };
}
