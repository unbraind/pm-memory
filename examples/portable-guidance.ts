import { exportDir, importDir, get, renew, guidanceState } from '../index.ts';

/** Export a reviewed policy and import its harness-edited body with bounds and ancestry intact. */
export async function portableGuidance(source: string, destination: string, directory: string) {
  await renew('release-policy', {
    workspace: source, author: 'policy-agent',
    from: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z',
    evidence: 'docs/release-checklist.md: public checklist reviewed',
  });
  const exportReceipt = await exportDir(directory, { workspace: source, to: 'agents-md' });
  // Receipts name any unrepresentable relationship fields in exportReceipt.lossy.
  // Legacy byte-preserved exports instead require pm-memory-origins.json.
  // Keep pm-memory-policy.json and the policy marker. Everything after the marker
  // is editable source, including unknown YAML keys and Markdown sections.
  const receipt = await importDir(directory, { workspace: destination, from: 'agents-md' });
  const imported = await get('release-policy', { workspace: destination });
  return { exportReceipt, receipt, document: imported.document, validity: imported.validity, state: guidanceState(imported, Date.now()) };
}

/** Explicitly recreate a known missing origin; never adopt a same-name native replacement. */
export async function recreatePortableOrigin(workspace: string, directory: string) {
  return importDir(directory, { workspace, from: 'agents-md', createMissingOrigins: true });
}
