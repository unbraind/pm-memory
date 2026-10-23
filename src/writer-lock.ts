import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLockLease, PmCliError } from '@unbrained/pm-cli/sdk';
import type { LockLease } from '@unbrained/pm-cli/sdk';
import { MemoryError } from './core.ts';

/** Retain a conservative lease; age alone never authorizes forced reclamation. */
export const WRITER_TTL_SECONDS = 3600;
/** Read-only lock fields used solely for actionable contention diagnostics. */
interface WriterOwner {
  /** Identity of the package's critical section. */
  id: string;
  /** Operating-system owner, which may have been reused by an unrelated process. */
  pid: number;
  /** Attribution supplied to the SDK lock owner. */
  owner: string;
  /** Creation timestamp used only for diagnostics. */
  created_at: string;
}
/** Match filesystem errors without assuming a particular exception prototype. */
function errno(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
/** Missing or malformed ownership provides no diagnostic identity. */
async function readOwner(path: string): Promise<WriterOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value !== 'object' || value === null || !('id' in value) || value.id !== 'memory-writer' || !('pid' in value) || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !('owner' in value) || typeof value.owner !== 'string' || !('created_at' in value) || typeof value.created_at !== 'string') return null;
    return value as WriterOwner;
  } catch (error) { if (errno(error, 'ENOENT') || error instanceof SyntaxError) return null; throw error; }
}
/** Mirror SDK wait parsing while capping the entire retry lifecycle at 30 seconds. */
export function writerWaitMs(value = process.env.PM_LOCK_WAIT_MS): number {
  if (value === undefined || !/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) return 30000;
  return Math.min(Number(value), 30000);
}
/** Delegate recovery and the entire bounded wait lifecycle to the SDK lease protocol. */
export async function writerLock(workspace: string, author: string): Promise<LockLease> {
  try {
    return await acquireLockLease(workspace, 'memory-writer', WRITER_TTL_SECONDS, author, false, true, writerWaitMs(), { maxWaitMs: 30000 });
  } catch (error) {
    if (!(error instanceof PmCliError) || (error.code !== 'lock_conflict' && error.exitCode !== 4)) throw error;
    const owner = await readOwner(join(workspace, 'locks', 'memory-writer.lock'));
    const age = owner === null ? Number.NaN : Date.now() - Date.parse(owner.created_at);
    const holder = owner === null ? 'unverifiable holder' : `PID ${owner.pid}`;
    throw new MemoryError('conflict', `Memory writer held by ${holder}; age ${Number.isFinite(age) ? `${Math.max(0, Math.floor(age / 1000))}s` : 'unknown'}`,
      'Retry the same command after the holder finishes. Dead owners recorded on this host are recovered automatically on retry. For a foreign or legacy lock, stop all writers on every host, verify the recorded owner process is dead on its host, then remove only locks/memory-writer.lock under the tracker and retry. Never clear a live or unverified owner; PID reuse is recovered only with SDK process-start evidence.');
  }
}
