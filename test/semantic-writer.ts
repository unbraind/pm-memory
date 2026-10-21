import { remember } from '../src/memory.ts';

const [workspace, slug] = process.argv.slice(2);
await remember('Concurrent registry guidance', { workspace, slug, author: 'memory-test', kind: 'reference', forceNew: true });
