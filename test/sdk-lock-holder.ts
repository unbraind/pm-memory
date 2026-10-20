import { acquireLock } from '@unbrained/pm-cli/sdk';

/** Minimal SDK-only crashed-owner fixture, with no pm-memory lock wrapper. */
await acquireLock(process.argv[2], 'sdk-repro', 3600, 'killed-writer', false, true, 0);
process.send!('holding');
await new Promise<void>(resolve => { process.once('message', () => resolve()); });
