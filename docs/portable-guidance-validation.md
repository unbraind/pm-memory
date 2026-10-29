# Portable guidance validation

Imports are forward-only; conflicts are reported, never rolled back. The current
implementation supersedes the historical compensation and cancellation designs.
Successful item writes survive interruption. Recovery retires the owned intent
with an append-only SDK audit reason, then plans against current SDK state.
Legacy frozen requests, including requests without publication receipts, are
never executed or used to restore values.

Represented dependency revisions are checked both at admission and in the final
SDK hook. A dependency refusal closes over its root and all dependent entries.
Already-satisfied SDK writes also check ownership; foreign source/type changes
cannot be adopted as unchanged when the SDK omits mutation hooks for a no-op.

Each actual SDK mutation compares the fields it changes with SDK-normalized saved
bases in its final pre-write hook. Immutable history also detects intervening
same-field edits that returned to the old value. A typed `import_conflict` reports
the item, field names, base/current fingerprints and remedy; dependent plan entries
receive the same reason. Foreign fields, native links, comments and dependencies
remain native. New nodes precede represented edges so interruption does not create
references to absent nodes. Publication recovery records only a proven history
append; it never mutates an item.

These checks have a remaining re-read-to-write window. SDK transactions serialize
cooperating transactions, not ordinary native writers. See
[pm-cli#1576](https://github.com/unbraind/pm-cli/issues/1576) and
[pm-cli#1620](https://github.com/unbraind/pm-cli/issues/1620). The tests establish
behavior at observed boundaries, not atomic native-writer isolation or an atomic
multi-item import.

## Source state and revision validation

Source ownership includes previously carried fields: removing a directive unsets
its registered native field. Absent unowned metadata and native-only relationships
remain untouched. Raw, companion and canonical payloads share the same projection;
only source-carried wiki edges grant text-based removal authority. Baselines record
the actual exported field presence and wiki references, rather than trusting an older
legacy snapshot after native body edits. Older exports grant only proven removal scope.
Canonical receipts
do not widen a later raw document’s field ownership. Explicit default and empty
values retain removal authority independently of their decoded logical defaults. Ambiguous native
relationship namespaces require an explicit manifest selection.

Every forward content write updates content recency and clears the prior verdict,
verification timestamp and stale reason in that same SDK mutation. Semantic hashes
and utility revision keys derive from the current SDK content. Historical renewal
evidence remains intact and bound to its original digest. Unedited snapshots retain
their timestamps on creation; an edited portable snapshot receives current recency.
Native creation lineage is checked through the SDK birth entry before schema writes.

`test/import-state.test.ts` adds 500 seeded source-edit/import/recall/round-trip
sequences (master `0x1363f014`, 1,500 source edits and round trips) across raw, companion and canonical forms. It checks
owned fields, tags, pinning, explicit links, unknown source evidence, native Task
links and priority through SDK read-back. Fixed controls cover directives acquired
after a plain birth and content aged 0, 29, 30, 31 and 400 days. Freshness tests also
require body and content-derived metadata to appear in the same native history write.
Fresh-target tests also check complete source bytes, including unknown frontmatter,
when deciding whether to retain an exported content timestamp.
Existing companion conflict tests now require whole-item preservation before an
explicitly reconciled retry; all original successful-retry assertions remain. The
complete-document law additionally asserts recency and verification invalidation.

Behavioral reverts reproduce retained obsolete instructions, stale revision evidence,
and missing lineage rejection; restored controls pass. The full local suite runs on
Node 26 with a fresh HOME, isolated Git configuration and two workers before pushing.

## Reproducible tests

- `test/portable-forward.test.ts`: fixed A/B/C publication failure, legacy
  `clearDeps` with a native Task dependency, whole-item conflict closure, peer
  completion counted unchanged, native ABA, and foreign alias creation. Seed
  `0x1363f013` drives independent OS-process peers with the same author and copied
  transaction prefix. SDK read-back checks fields, relationships, comments and
  dependencies at every observed import and recovery boundary. Crashes retain
  successful writes and reruns converge without duplicate identities or dangling
  relationships.
- `test/portable-model.test.ts`: 500 stateful sequences, master seed
  `0x1363cafe`, 22,933 SDK read-back comparisons on completion. Operations include
  old manifest replay, native edits, whitespace/CRLF, mixed bounded/unbounded
  guidance, links, ownership changes, deletion/re-import, interruption and retry.
  The reference model is independent of importer ownership and merge helpers.
- `test/portable-ownership.test.ts`: identity, locality and foreign-preservation
  laws, 500 sequences per law, including native Task and omitted-target links.
- `test/portable-admission.test.ts`: complete SDK birth checks, occupied aliases,
  foreign records and attempt identities. `test/portable-lifecycle.test.ts` checks
  SDK status roles without granting recovery permission to reactivate items.
- `test/critical.acceptance.ts`: one rebuilt archive in native Node and Bun,
  independent same-author processes, retained interrupted identities and compact
  typed JSON/TOON provenance refusals.

Full release gates run in CI at unchanged coverage thresholds. Targeted local
commands, behavioral revert receipts and exact-head CI links are recorded on
[pm-memory-1363](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-1363.toon).
The number of configured model sequences is not a claim that a pending CI run
completed them. Gate receipts distinguish passed, failed and incomplete checks.

## Focused current implementation evidence

| Check | Completed evidence |
| --- | --- |
| Fixed regression controls | 11 roots passed, no failures or cancellations |
| Unchanged dependent skip closure | One additional root passed |
| Stateful model batch 200–204 | Five sequences, 230 SDK read-back comparisons; six test nodes passed |
| Model sequence seeds | 2931483526, 1290951999, 3945387768, 2304856241, 664324714 |
| Bootstrap/recovery peers | 31 bootstrap and 47 recovery boundaries, the latter with both a peer edit and crash |
| Independent create/update peers | 240 creation schedules / 60 boundaries and 200 update schedules / 50 boundaries; master seed `0x1363f013` |
| Creation/update crashes | 58 creation and 50 update boundaries passed with convergent reruns |
| Rebuilt packed artifact | Native Node and Bun, four OS peers, two retained identities, four typed CLI refusals |
| Static checks | Typecheck, lint, zero duplication across 111 sources, 150 documented declarations |

The common-path peer properties complete 518 schedules; the linked extension adds
31 peer write-boundary schedules and 31 crash/rerun boundaries. Totals are 549 peer
schedules and 139 crash boundaries. The linked extension draws seeded edits and
forces foreign ownership at prepared/guard transitions. Four SDK/raw-foreign
fresh/recovery cases pass via pinned pm. A focused five-operation property replay
fails when only the former write functions are restored, then passes with the fix.
Two foreign no-op ownership cases fail with only writeForward reverted and pass
with it restored; legitimate peer completion remains unchanged. The pinned pm rerun passes all five selected roots after the
behavioral reverts, including the 200-schedule update property. Exact-head full CI
receipts are recorded separately on the PR. An incomplete local sweep is excluded from all
passing schedule totals. Behavioral reverts in disposable copies reproduce
missing conflict skips, C being restored to B, and a native dependency erased by
legacy frozen `clearDeps` replay. The fixed source stays in place throughout.

## Public tracker replay

Public source: [pm-memory main](https://github.com/unbraind/pm-memory/tree/fc05dfd0495e15946ca31b6c93250eaf704689c3/.agents/pm),
extracted into a non-git directory and made read-only before the SDK read. Only
separate disposable trackers receive scenario annotations; no fleet checkout or
original tracker is changed.

Run `validatePortable(publicTracker, scratchDirectory)` from
[examples/validate-portable.ts](../examples/validate-portable.ts) against an
extracted read-only public tracker. Set `GIT_CEILING_DIRECTORIES` to the scratch
parent and fingerprint all source files before and after. The source must be
read-only because SDK reads may otherwise create runtime metadata caches.

Measured again on 2026-10-29 against the current forward-only implementation:

| Measurement | Result |
| --- | ---: |
| Certified complete SDK source items | 17 |
| Nonempty source bodies | 6 |
| Full SDK input projection bytes | 232,693 |
| Derived scenario guidance records | 17 |
| Synthetic windows per record | 2 |
| Renewal records retained per harness | 34 |
| Exported files per harness | 19 |
| AGENTS created / updated / unchanged | 17 / 0 / 0 |
| Claude into the same target: created / updated / unchanged | 0 / 0 / 17 |
| Identical retries: unchanged per harness | 17 |
| Lost windows or evidence records | 0 |
| Harness body edit, each harness | needs-renewal |
| Source fingerprint changed | no |

Source SHA-256 over sorted relative paths and file SHA-256 pairs encoded as
compact JSON:
`652fd875763b57b52c1fb7af1a98e8d655511188a9129f5b8c7fa56a73c22fb7`.
Annotations are synthetic review scenarios over public titles/bodies, not claims
that the original project items had those review windows.
