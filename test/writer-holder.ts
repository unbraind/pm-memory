import { Store } from '../src/store.ts';

/** Hold a real package critical section until the parent releases or kills this process. */
const store = new Store({ workspace: process.argv[2], author: 'writer-test' });
await store.write(async () => {
  process.send!('holding');
  await new Promise<void>(resolve => { process.once('message', () => resolve()); });
});
process.disconnect!();
