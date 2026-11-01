import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { importDir } from '../index.ts';
import { nativeState } from '../src/native-revision.ts';
import { pendingImport, savePlan } from '../src/portable-plan.ts';
import type { ImportPlan } from '../src/portable-plan.ts';
import { commitPortableBatch } from '../src/portable-write.ts';
import { tracker, readImportPlan } from './helpers.ts';

/** Capture an actual SDK-validated request and retire its interrupted intent before each independent recovery control. */
export async function capturedPublication(t: Parameters<typeof tracker>[0], aged = false, next = 'Alpha B') {
  const target = await tracker(t); const path = join(target.root, 'input'); await mkdir(path);
  const file = join(path, 'alpha.md'); await writeFile(file, 'Alpha A');
  await importDir(path, { ...target.options, from: 'agents-md' });
  if (aged) {
    const id = (await target.client.listAllComplete()).items[0].id;
    await target.store.fields(id, { changed_at: '2020-01-01T00:00:00.000Z' });
    await target.client.update(id, { unset: ['memory_verified_at', 'memory_reason'] });
  }
  await writeFile(file, next);
  await assert.rejects(importDir(path, { ...target.options, from: 'agents-md', onStep: step => { if (step === 'intent') throw new WorkspaceTransactionInterruptedError(); } }), WorkspaceTransactionInterruptedError);
  const plan = await readImportPlan(target.workspace); const mutation = plan.mutations[0];
  await pendingImport(target.store);
  const before = await nativeState(target.store, mutation.id);
  return { target, plan, mutation, before };
}

/** Publish one admitted update through the real forward coordinator under its package lease. */
export async function applyCaptured(target: Awaited<ReturnType<typeof tracker>>, plan: ImportPlan): Promise<void> {
  await target.store.write(async () => {
    await savePlan(target.store, plan);
    await commitPortableBatch(target.store, plan, plan.transactionId, 'data', plan.mutations, { ...target.options, from: 'agents-md' });
  });
}
