import { renew } from '../index.ts';
const [workspace, evidence] = process.argv.slice(2);
console.log(JSON.stringify(await renew('policy', { workspace, author: 'memory-test', from: '2026-10-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z', evidence })));
