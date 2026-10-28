import { PmClient } from '@unbrained/pm-cli/sdk';

process.on('message', async (value: { workspace: string; id: string; author: string; prefix: string; token: number; operation?: 'delete'; options?: Record<string, unknown> }) => {
  try {
    const client = new PmClient({ pmRoot: value.workspace, noExtensions: true, author: value.author });
    const mutation = value.operation === 'delete' ? client.run('delete', { id: value.id, options: { force: true, message: `bulk-item-transaction ${value.prefix} ${value.id} compensate` } }) : client.update(value.id, { ...value.options, body: 'Peer native C', priority: 1, message: `bulk-item-transaction ${value.prefix} copied-prefix apply` });
    process.send!({ token: value.token, state: 'started' });
    await mutation;
    process.send!({ token: value.token, state: 'done', item: value.operation === 'delete' ? null : (await client.get(value.id, { full: true })).item });
  } catch (error) { process.send!({ token: value.token, state: 'error', message: String(error) }); }
});
process.send!({ state: 'ready' });
