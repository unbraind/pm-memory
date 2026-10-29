import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { TestContext } from 'node:test';

/** Keep one real native writer in another OS process; IPC separates dispatch from completion; it does not certify lock isolation. */
export async function peerWriter(t: TestContext, root: string) {
  const child = fork(fileURLToPath(new URL('./portable-peer.worker.ts', import.meta.url)), [], { env: { PATH: root, HOME: root, GIT_CEILING_DIRECTORIES: dirname(root), ...(process.env.NODE_V8_COVERAGE === undefined ? {} : { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.connected) child.disconnect(); child.kill(); });
  let stderr = ''; child.stderr!.on('data', bytes => { stderr += String(bytes); });
  await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', (code, signal) => { reject(new Error(`Peer exited before readiness (${code ?? signal}): ${stderr}`)); }); });
  let token = 0;
  return (workspace: string, id: string, author: string, prefix: string, operation?: 'delete' | 'exact' | 'comment', options?: Record<string, unknown>) => {
    const current = ++token;
    let entered!: () => void; let entryFailed!: (error: Error) => void; let finish!: (item: unknown) => void; let fail!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { entered = resolve; entryFailed = reject; });
    const done = new Promise<unknown>((resolve, reject) => { finish = resolve; fail = reject; });
    void done.catch(() => {});
    /** A lost native worker is a test failure, never a silently pending promise. */
    const exited = (code: number | null, signal: string | null) => { const error = new Error(`Peer exited during request (${code ?? signal}): ${stderr}`); entryFailed(error); fail(error); child.off('message', receive); };
    child.once('exit', exited);
    /** Match this exact request without mixing two independent native transitions. */
    const receive = (value: { token?: number; state: string; item?: unknown; message?: string }) => {
      if (value.token !== current) return;
      if (value.state === 'started') entered();
      else { child.off('message', receive); child.off('exit', exited); if (value.state === 'done') finish(value.item); else { const error = new Error(value.message); entryFailed(error); fail(error); } }
    };
    child.on('message', receive); child.send({ workspace, id, author, prefix, token: current, operation, options }); return { started, done };
  };
}
