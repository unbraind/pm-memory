import { recall } from '../src/memory.ts';
import { OllamaProvider } from '../src/embeddings.ts';
const [workspace, endpoint] = process.argv.slice(2);
console.log(JSON.stringify(await recall('how do we ship a release', { workspace, author: 'memory-test', semantic: 'on', provider: new OllamaProvider('test:local', endpoint), budget: 200 })));
