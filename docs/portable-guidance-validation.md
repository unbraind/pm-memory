# Portable policy validation

Public source: [pm-memory main](https://github.com/unbraind/pm-memory/tree/fc05dfd0495e15946ca31b6c93250eaf704689c3/.agents/pm), extracted from Git into a non-git directory and made read-only before the SDK read. Only separate disposable trackers received scenario annotations. No original fleet checkout or tracker was modified.

Run the exported `validatePortable(publicTracker, scratchDirectory)` helper in
[examples/validate-portable.ts](../examples/validate-portable.ts), supplying an
extracted public tracker and an empty disposable directory. Set
`GIT_CEILING_DIRECTORIES` to the parent of that directory. Fingerprint every source
file before and after. The source must be read-only: native SDK list reads may
otherwise create disposable runtime metadata caches.

Measured again on 2026-10-27 after complete birth ownership and legacy namespace fixes (the same public source and fingerprint):

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


## Complete creation ownership

Creation authority now comes from an independent SDK create/read in a private
projection that excludes the planned target ids and histories. The owned intent
retains the complete SDK document and creation message. SDK-generated creation
and update times are normalized through the SDK; native priority, custom fields,
relationships and all other stored values remain part of the comparison. A
missing message in an older intent is regenerated without replacing its frozen
document. The SDK item-lock mutation hook checks the proposed creation before
persistence, including during recovery.

New imports mark their native birth format and carry the document fingerprint in
immutable SDK creation history. Copying the tracker without transaction journals
therefore retains birth evidence. A copied marker with extra metadata fails that
fingerprint and stays foreign on later edited retries. Earlier unsealed nodes
use their committed publication receipts; ordinary legacy records keep their
existing semantic birth checks.

| Regression | Evidence |
| --- | --- |
| Copied node request plus priority, custom metadata or dependencies | 12 cases: both harnesses, fresh and interrupted imports; complete SDK state preserved through unchanged and edited retries |
| Every planned scalar field | 21 fields / 42 foreign creations; SDK read-back is the oracle, including edited retries |
| Namespace initialization after a legacy planning read | Both harnesses apply the first edit and retain immutable fingerprint identity in later policy imports |
| Older intents and changed proposals | SDK-generated old messages, frozen-document migration, and 9 fresh/interrupted/compensated proposal interleavings |
| Native tracker clone without transaction journals | Both harnesses retain two linked records and import their unchanged exports without changing SDK state |
| Crash recovery | Existing 21 create and 14 update journal boundaries pass with the versioned birth evidence |

Behavioral reverts run only in disposable copies. They reproduce peer deletion,
foreign edited-retry adoption, first-import conflict, loss of frozen evidence,
and missing clone evidence. The item comments retain the exact commands and
per-revert failures. No production source is left reverted.


## Complete document ownership

The unknown-frontmatter review exposed a projection error: semantic field equality
does not imply source document equality. All three import adapters now share a
full-byte document envelope and comparison. A canonical policy file carries the
retained frontmatter plus current SDK-native body. The generated marker is derived;
everything after it is source content. SDK-normalized semantic fields and exact
document bytes have separate ownership fingerprints, so unknown keys cannot hide an
edit and a stale byte cache cannot resurrect an older native body.

`test/portable-document-law.test.ts` runs 500 independent sequences with master seed
`0x1363d0c4` (`325308612`). Eight modes cover raw and companion AGENTS/Claude imports,
plain canonical policy bodies, and canonical legacy documents with native semantic
overrides. The independent oracle generates nested unknown values, unusual keys,
ordering, comments, BOM, LF/CRLF, whitespace and unrecognized body sections. It reads
complete native records through the SDK, checks exact exported bytes, then changes a
single unknown value and requires exactly one update followed by an unchanged retry.
Failures print master seed, sequence, derived seed and mode.

Fixed cases also cover journal-free clones, source A/B/A replays, omitted old snapshot
fields, native document conflicts, malformed foreign data, decoded privacy refusal,
index artifacts, policy whitespace, and edits between an interrupted intent and retry.
The raw document update crash test injects interruption at all 33 observed import
steps, then requires convergence without duplicates. Existing SDK birth evidence is
also checked against the current native document and its uninterrupted owned history;
peer edits hidden behind copied transaction markers never authorize compensation.


Final focused results for the complete-document change: 500/500 document-law
sequences; 19/19 linked document, compatibility and compensation roots; 2/2
preparation crash/concurrency roots; 2/2 packed npm/native Bun consumers; 33/33
observed raw-update interruption boundaries; and 21 scalar fields / 42 foreign
creations. Typecheck, lint, documentation, identity/privacy and zero duplication
pass at unchanged thresholds. Six valid disposable behavioral reverts reproduce
raw and companion zero-update errors (seeds 325308612 and 1339212854), stale
canonical frontmatter (seed 3367021338), conflated interrupted input, actual peer
deletion and accepted native history drift. One initially invalid recovery fixture
was withdrawn and replaced by the corrected positive/revert pair; pm comments
preserve that correction. Full npm/Bun release evidence belongs to the final-head
CI run linked from the PR; these focused counts do not assert a full-gate pass.
