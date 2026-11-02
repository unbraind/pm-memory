import { canonicalDocument, serializeItemDocument, readSettings, resolveTransactionSchema, resolveItemTypeRegistry, locateItem, readLocatedItem, getHistoryPath, readHistoryEntries, hashHistoryStream, verifyHistoryEntries, runWithActiveExtensions, setActiveExtensionHooks, update } from '@unbrained/pm-cli/sdk';
import type { ItemDocument } from '@unbrained/pm-cli/sdk';
import type { BeforeMutationHook } from '@unbrained/pm-cli/sdk/authoring';
import type { Store } from './store.ts';
import { digest, MemoryError } from './core.ts';
import { guardedHostUpdate } from './native-host.ts';

/** Hydrated schema inferred from the SDK serializer's public resolver. */
export type TrackerSchema = Awaited<ReturnType<typeof resolveTransactionSchema>>['schema'];
/** Resolve the same hydrated schema used by native SDK mutations. */
export async function trackerSchema(workspace: string): Promise<TrackerSchema> { return (await resolveTransactionSchema(workspace, await readSettings(workspace))).schema; }

/** Complete SDK document and immutable history position; no attribution is an ownership token. */
export interface NativeProof { hash: string | null; history: string; length: number; version: string | null }
/** Compare exact SDK content and monotonic history; diagnostic timestamps never establish identity. */
export function sameNativeProof(current: NativeProof, expected: NativeProof): boolean { return current.hash === expected.hash && current.length === expected.length && current.history === expected.history; }
/** Reject malformed native fingerprints before interpreting recovery or publication data. */
export function validNativeProof(value: unknown): value is NativeProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as NativeProof;
  return (row.hash === null || typeof row.hash === 'string' && /^[a-f0-9]{64}$/.test(row.hash)) && typeof row.history === 'string' && /^[a-f0-9]{64}$/.test(row.history) && Number.isSafeInteger(row.length) && row.length >= 0 && (row.version === null || typeof row.version === 'string');
}
/** Install a single package guard inside a fresh, extension-free SDK mutation scope. */
export function installStandaloneGuard(run: BeforeMutationHook, name: string): void {
  setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onIndex: [], onWrite: [], beforeMutation: [{ layer: 'project', name, run }] });
}
/** Publish native evidence only for the exact saved SDK revision, including the SDK no-op path.
 * Additional certified items are rechecked against their saved immutable history inside the same admission hook,
 * so a receipt step that writes one item cannot certify a stale position of any other item it names. */
export async function commitNativeFields(store: Store, id: string, expected: NativeProof, options: Record<string, unknown>, message = 'Verify unchanged native memory snapshot', certify?: ReadonlyMap<string, NativeProof>): Promise<boolean> {
  /** Preserve the host scope for injected clients; isolate only the default SDK path. */
  const publish = async () => {
    let moved = false;
    /** Read and normalize the native revision through the same path used during capture. */
    const matches = async () => sameNativeProof((await nativeState(store, id)).proof, expected);
    /** Recheck every additionally certified item at its saved immutable history position. */
    const certified = async () => { for (const [item, proof] of certify ?? []) if (!sameNativeProof((await nativeState(store, item)).proof, proof)) return false; return true; };
    /** The actual SDK pre-write hook rejects intervening writers, including identical-content ABA, on every certified item. */
    const guard: BeforeMutationHook = async context => {
      const { proof } = await nativeState(store, id);
      const candidates = [proof, { ...proof, hash: documentHash(context.before, await trackerSchema(store.workspace)) }];
      if (!candidates.every(candidate => sameNativeProof(candidate, expected)) || !await certified()) { moved = true; throw new MemoryError('conflict', 'Native verification revision changed', 'Retry verification against the current native item; existing fields were retained'); }
    };
    if (store.hostClient === undefined) installStandaloneGuard(guard, 'pm-memory-verification-revision');
    if (!await matches() || !await certified()) return false;
    try {
      const fields = { author: store.invocationAuthor, ...options, message };
      const result = store.hostClient !== undefined ? await guardedHostUpdate(store, store.hostClient, id, guard, fields) : await update(id, fields, { pmRoot: store.workspace });
      return result.changed_fields.length > 0 || await matches();
    } catch (error) { if (moved) return false; throw error; }
  };
  return store.hostClient !== undefined ? publish() : store.fence(() => runWithActiveExtensions({ path: store.workspace, noExtensions: true }, publish));
}
/** Hash both native reads and SDK hook documents through the identical SDK canonical serializer. */
export function documentHash(document: ItemDocument | null, schema?: TrackerSchema): string | null { return document === null ? null : digest(serializeItemDocument(canonicalDocument(document, { schema }), { schema })); }
/** Read the actual SDK document, rejecting a history/file disagreement rather than adopting it. */
export async function nativeState(store: Store, id: string): Promise<{ document: ItemDocument | null; proof: NativeProof }> {
  const settings = await readSettings(store.workspace); const schema = await trackerSchema(store.workspace);
  const located = await locateItem(store.workspace, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
  const entries = await readHistoryEntries(getHistoryPath(store.workspace, id), id);
  const document = located === null ? null : (await readLocatedItem(located, { schema })).document;
  if (!verifyHistoryEntries(entries, document ?? undefined).ok) throw new MemoryError('conflict', 'Native document and history disagree', 'Retain the native record and restore a verified history before retrying');
  return { document, proof: { hash: documentHash(document, schema), history: hashHistoryStream(entries), length: entries.length, version: document?.metadata.updated_at ?? null } };
}

/** Bind the exact planning corpus to immutable history before exposing the read boundary. */
export async function observeTargets(store: Store, corpus: Awaited<ReturnType<Store['client']['listAllComplete']>>['items']): Promise<ReadonlyMap<string, Awaited<ReturnType<typeof nativeState>>>> {
  const schema = await trackerSchema(store.workspace);
  const observed = new Map<string, Awaited<ReturnType<typeof nativeState>>>();
  for (const { body, ...metadata } of corpus) {
    const state = await nativeState(store, metadata.id);
    if (documentHash({ metadata, body: String(body ?? '') }, schema) !== state.proof.hash) throw new MemoryError('conflict', 'Observed native corpus changed before history capture', 'Export the current item and retry; no newer base was adopted');
    observed.set(metadata.id, state);
  }
  return observed;
}
