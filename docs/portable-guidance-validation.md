# Portable guidance validation

Imports are forward-only; conflicts are reported, never rolled back. The current
implementation supersedes the historical compensation and cancellation designs.
Successful item writes survive interruption. Recovery retires the owned intent
with an append-only SDK audit reason, then plans against current SDK state.
Legacy frozen requests, including requests without publication receipts, are
never executed or used to restore values.

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

The peer properties complete 518 schedules in total; separate crash-only properties
cover 108 boundaries. The pinned pm rerun passes all five selected roots after the
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
