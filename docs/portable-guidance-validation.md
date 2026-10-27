# Portable policy validation

Public source: [pm-memory main](https://github.com/unbraind/pm-memory/tree/fc05dfd0495e15946ca31b6c93250eaf704689c3/.agents/pm), extracted from Git into a non-git directory and made read-only before the SDK read. Only separate disposable trackers received scenario annotations. No original fleet checkout or tracker was modified.

Run the exported `validatePortable(publicTracker, scratchDirectory)` helper in
[examples/validate-portable.ts](../examples/validate-portable.ts), supplying an
extracted public tracker and an empty disposable directory. Set
`GIT_CEILING_DIRECTORIES` to the parent of that directory. Fingerprint every source
file before and after. The source must be read-only: native SDK list reads may
otherwise create disposable runtime metadata caches.

Measured again on 2026-10-27 after immutable-origin and legacy-fidelity fixes (the same public source and fingerprint):

| Measurement | Result |
| --- | ---: |
| Public tracker items read through certified complete SDK list | 17 |
| Nonempty source bodies | 6 |
| Full SDK input projection bytes | 232,693 |
| Derived scenario guidance records | 17 |
| Synthetic review windows per record | 2 |
| Renewal records retained per harness | 34 |
| Files exported per harness | 19 |
| AGENTS import: created / updated / unchanged | 17 / 0 / 0 |
| Claude Code import into that same target: created / updated / unchanged | 0 / 0 / 17 |
| Identical retries, each harness: unchanged | 17 |
| Lost windows or evidence records | 0 |
| Harness body edit, each harness | needs-renewal |
| Source fingerprint changed | no |

Source SHA-256 (sorted relative file names and their SHA-256 digests, encoded as compact JSON pairs):
`652fd875763b57b52c1fb7af1a98e8d655511188a9129f5b8c7fa56a73c22fb7`.
The annotations are validation scenarios over real public titles/bodies, not
claims that those project items were actually reviewed under these windows.

The regression suite exercises both harnesses with reproducible random semantic
sets, refusal before writes, missing manifests, every SDK create/update transaction
transition, every schema/preparation step and staged export publication. It also
checks competing imports and exports on one non-git tracker, independent trackers
publishing the same output, foreign records and ordinary SDK rollback.
