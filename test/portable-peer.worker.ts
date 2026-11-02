import { PmClient, runWithActiveExtensions, setActiveExtensionHooks } from '@unbrained/pm-cli/sdk';

process.on('message', async (value: { workspace: string; id: string; author: string; prefix: string; token: number; operation?: 'delete' | 'exact' | 'comment'; options?: Record<string, unknown> }) => {
  try {
    const client = new PmClient({ pmRoot: value.workspace, noExtensions: true, author: value.author });
    const initial = (await client.get(value.id, { full: true })).item; let before: Record<string, unknown> = initial;
    process.send!({ token: value.token, state: 'started' });
    await runWithActiveExtensions({ path: value.workspace, noExtensions: true }, async () => {
      setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onIndex: [], onWrite: [], beforeMutation: [{ layer: 'project', name: 'independent-peer-oracle', run: context => { if (context.before?.metadata.id === value.id) before = { ...initial, ...context.before.metadata, body: context.before.body }; } }] });
      if (value.operation === 'delete') await client.run('delete', { id: value.id, options: { force: true, message: `bulk-item-transaction ${value.prefix} ${value.id} compensate` } });
      else if (value.operation === 'comment') await client.comments(value.id, { add: String(value.options!.comment), message: `bulk-item-transaction ${value.prefix} copied-prefix comment` });
      else await client.update(value.id, { ...value.options, ...(value.operation === 'exact' ? {} : { body: 'Peer native C', priority: 1 }), message: `bulk-item-transaction ${value.prefix} copied-prefix apply` });
    });
    process.send!({ token: value.token, state: 'done', before, item: value.operation === 'delete' ? null : (await client.get(value.id, { full: true })).item });
  } catch (error) { process.send!({ token: value.token, state: 'error', message: String(error) }); }
});
process.send!({ state: 'ready' });
