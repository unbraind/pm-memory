/** Isolate adversarial scanning behind an operating-system process deadline. */
import { performance } from 'node:perf_hooks';
import { privacy } from '../src/core.ts';
process.stdout.write('ready\n');
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += String(chunk);
const start = performance.now();
privacy(input);
process.stdout.write(String(performance.now() - start) + '\n');
