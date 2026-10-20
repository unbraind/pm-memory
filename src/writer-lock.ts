import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock, PmCliError } from '@unbrained/pm-cli/sdk';
import { digest, MemoryError } from './core.ts';

/** Retain a conservative lease; age alone never authorizes forced reclamation. */
export const WRITER_TTL_SECONDS = 3600;
/** Host fingerprint stays in runtime lock metadata, without a literal machine name. */
const HOST = `pm-memory-host:${digest(hostname())}`;
/** Pinned SDK lock payload fields required for conservative recovery and diagnostics. */
interface WriterOwner {
  /** Identity of the package's critical section. */
  id: string;
  /** Operating-system owner, which may have been reused by an unrelated process. */
  pid: number;
  /** Attribution followed by a host fingerprint for new package locks. */
  owner: string;
  /** Creation timestamp used only for diagnostics. */
  created_at: string;
}
/** Match filesystem errors without assuming a particular exception prototype. */
function errno(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
/** Missing or malformed ownership is unverifiable and cannot authorize recovery. */
async function readOwner(path: string): Promise<WriterOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value !== 'object' || value === null || !('id' in value) || value.id !== 'memory-writer' || !('pid' in value) || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !('owner' in value) || typeof value.owner !== 'string' || !('created_at' in value) || typeof value.created_at !== 'string') return null;
    return value as WriterOwner;
  } catch (error) { if (errno(error, 'ENOENT') || error instanceof SyntaxError) return null; throw error; }
}
/** Only ESRCH proves death; EPERM and PID reuse both preserve the current owner. */
function deadLocalOwner(owner: WriterOwner | null): boolean {
  if (owner === null || !owner.owner.endsWith(` [${HOST}]`)) return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return errno(error, 'ESRCH'); }
}
/**
 * Serialize dead-owner unlink with pinned SDK creation, release and stale cleanup.
 * Never delete a gate owned by somebody else; the SDK handles abandoned gates.
 */
async function recoverDeadOwner(path: string): Promise<void> {
  if (!deadLocalOwner(await readOwner(path))) return;
  const gate = `${path}.stale-cleanup`;
  try { await mkdir(gate); } catch (error) { if (errno(error, 'EEXIST')) return; throw error; }
  try {
    // Match the pinned SDK gate protocol; a live PID protects this short section.
    await writeFile(join(gate, 'owner.json'), JSON.stringify({ pid: process.pid, token: randomUUID() }));
    const current = await readOwner(path);
    if (deadLocalOwner(current)) {
      await unlink(path);
      process.emitWarning(`Recovered memory-writer lock from dead local PID ${current!.pid}`, { code: 'PM_MEMORY_LOCK_RECOVERED' });
    }
  } finally { await rm(gate, { recursive: true, force: true }); }
}
/** Mirror SDK wait parsing while capping the entire retry lifecycle at 30 seconds. */
export function writerWaitMs(value = process.env.PM_LOCK_WAIT_MS): number {
  if (value === undefined || !/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) return 30000;
  return Math.min(Number(value), 30000);
}
/** Acquire the native lock with dead-owner recovery and actionable contention errors. */
export async function writerLock(workspace: string, author: string): Promise<() => Promise<void>> {
  const path = join(workspace, 'locks', 'memory-writer.lock');
  const deadline = performance.now() + writerWaitMs();
  for (;;) {
    await recoverDeadOwner(path);
    try { return await acquireLock(workspace, 'memory-writer', WRITER_TTL_SECONDS, `${author} [${HOST}]`, false, true, 0, { maxWaitMs: 0 }); }
    catch (error) {
      if (!(error instanceof PmCliError) || (error.code !== 'lock_conflict' && error.exitCode !== 4)) throw error;
      const owner = await readOwner(path);
      const remaining = deadline - performance.now();
      if (remaining > 0) { await new Promise(resolve => { setTimeout(resolve, Math.min(50, remaining)); }); continue; }
      const age = owner === null ? Number.NaN : Date.now() - Date.parse(owner.created_at);
      const holder = owner === null ? 'unverifiable holder' : `PID ${owner.pid} (${owner.owner.endsWith(` [${HOST}]`) ? 'this host' : 'foreign or unverified host'})`;
      throw new MemoryError('conflict', `Memory writer held by ${holder}; age ${Number.isFinite(age) ? `${Math.max(0, Math.floor(age / 1000))}s` : 'unknown'}`,
        'Retry the same command after the holder finishes. Dead owners recorded on this host are recovered automatically on retry. For a foreign or legacy lock, stop all writers on every host, verify the recorded owner process is dead on its host, then remove only locks/memory-writer.lock under the tracker and retry. Never clear a live or unverified owner; PID reuse must be investigated manually.');
    }
  }
}
