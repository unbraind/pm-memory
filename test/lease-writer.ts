import { writeFile } from 'node:fs/promises';
import { exportDir } from '../index.ts';
import { Store } from '../src/store.ts';

/** Hold a real writer before publication so a successor can take its expired lease. */
const store = new Store({ workspace: process.argv[2], author: 'lease-writer' });
try {
  if (process.argv[3] === 'export') {
    const history = Store.prototype.history;
    /** Pause after real history verification, before portable export publication. */
    Store.prototype.history = async function(id: string): Promise<number> {
      const count = await history.call(this, id);
      process.send!('holding');
      await new Promise<void>(resolve => { process.once('message', () => resolve()); });
      return count;
    };
    await exportDir(process.argv[4], { workspace: process.argv[2], to: 'claude-code' });
  } else {
    await store.write(async () => {
      process.send!('holding');
      await new Promise<void>(resolve => { process.once('message', () => resolve()); });
      if (process.argv[3] === 'file') await store.fence(() => writeFile(process.argv[4], 'stale publication'));
      else await store.client.create({ title: 'Stale writer publication', type: 'Task' });
    });
  }
  process.send!({ published: true });
} catch (error) {
  process.send!({ code: (error as { code: string }).code });
}
process.disconnect!();
