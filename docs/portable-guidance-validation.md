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
document. The SDK pre-write mutation hook checks the proposed creation before
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


## Current grammar transitions

Canonical legacy imports and their export baselines now use the shared source parser
regardless of whether the original source had frontmatter. New `type`/`metadata.type`
and `description` fields become native semantic edits; unknown fields and exact
source bytes remain in the document snapshot. An empty outer mapping frames literal
SDK-native YAML bodies, including malformed literal YAML, so parsing current source
syntax does not rewrite native body text on an unchanged round trip. Exact body
caches are written only when needed to preserve bytes or an existing cache; ordinary
SDK-canonical body edits add no redundant native metadata.

The current-grammar reference model uses seed `0x1363f005` (`325316613`) and 500
sequences across raw, companion, canonical AGENTS/Claude, and Cursor-source exports.
Every sequence introduces frontmatter into plain source, changes one unknown value,
removes the frontmatter, exports/imports unchanged after each transition, and imports
the final export into a fresh tracker. Independent SDK updates on a cloned reference
tracker define the complete expected native state; generated field values and full
source bytes are not derived with the importer. Native priorities, utility metadata
and links to a Task are retained. Bounded batches reuse initialized schema fixtures
through independent native copies to limit host resource usage. The earlier partial
instrumented run was canceled and contributes no sequence count.

Earlier exact SDK assertions now include the newly required complete source snapshot
or source bytes explicitly, retaining their original native metadata, clock, alias,
reference and retry checks. The full release thresholds remain 100/100/100/100.

Current-grammar local results: 200 complete sequences (eight batches of 25, starts
0 through 175) passed with master seed `325316613`. Each batch ran
`PM_MEMORY_GRAMMAR_START=<start> PM_MEMORY_GRAMMAR_COUNT=25 node --test --test-concurrency=1 test/portable-grammar.worker.ts`.
The unfinished next batch was stopped when host saturation made full-model execution
unsuitable locally; it contributes no passing count. The committed law still requires
500 sequences, and the complete npm/Bun release gates run in CI. No model assertions,
sequence counts or coverage thresholds were reduced.

The pinned pm source-context runner passed 10/10 focused roots, including current
grammar, refusal and released-record compatibility. Six disposable behavioral
reverts failed as expected; commands, counterexamples and positive controls are
recorded on `pm-memory-1363`. Typecheck, lint, identity/privacy, documentation
(39 files / 153 declarations), and duplication (0% / 102 sources) pass.

Fresh public validation on 2026-10-28 retained 17 items, 6 nonempty bodies and
232,693 SDK input bytes. Each harness exported 19 files, retained 17 guidance
records and 34 renewals, and reported 17 unchanged retries. Edited bodies became
`needs-renewal`; bounds/evidence and the read-only source fingerprint were retained.
Final-head release results are reported in the PR, separately from these local counts.

## Exact native write ownership

Portable node creation, data updates, publication and rollback use the public SDK
`commitWorkspaceTransaction` workspace coordinator. Each invocation reserves a
unique attempt in the durable intent; interrupted SDK attempts resume their own
journal, including committed sub-batches of an unpublished invocation. Replacing
that identity early would orphan publication provenance and falsely classify the
next harness edit as native. `inspect` re-reads current native state. Actual SDK
writes retain canonical hashes and immutable history positions. These fingerprints
are evidence of a particular write, never mutual exclusion against ordinary native
writers. Author, copied transaction prefix and timestamp do not authorize rollback.
The former forced deletion/restoration implementation is superseded by cancellation
and field-local restoration described below; its earlier measurements are historical.
Creation admission still requires the independent complete SDK birth document.

The package-wide audit covers raw, companion and canonical adapters, the SDK and
CLI, JSON/TOON receipts, installed Node/native Bun consumers, non-git trackers and
all compensation paths. Disposable previews retain the same compiled SDK mutation
options and captured read-set validation; public SDK preview executes its native
lifecycle without publishing source changes. Hooks also verify the exact tracker
root/path, so an identical id in a different tracker cannot lend ownership evidence.

`portable-critical.test.ts` keeps a real native writer in a second OS process. At
every observed creation, update and rollback boundary it writes the same tracker
using the import's author and copied prefix. The independent oracle is that peer's
complete SDK read-back, including priority and metadata; it must survive refusal
and retry without a dangling graph. Fixed cases cover the reported CAS-refusal
rollback, copied provenance and compensation markers, and cross-tracker hook scope.
All earlier model, foreign-birth and crash-boundary assertions remain enabled.

Relationship validation is pure and precedes schema, origin and workspace history
writes. Both current and baseline edges validate target/kind plus `created_at`,
`author`, `source_kind` and `author_source`. The refusal corpus covers objects,
arrays, nulls, booleans, numbers and invalid enum/timestamp strings. The allow corpus
includes missing legacy provenance and SDK-supported timestamp literals. SDK and
JSON/TOON CLI consumers return typed `relationship` with a remedy; they retain the
entire pre-import durable tracker snapshot on this validation refusal.

Final shared-path cross-process measurements: **142** schedules, comprising **80**
creation, **55** update and **7** rollback boundaries. The complete critical file
passes **11/11** roots with no failures or cancellations. Every schedule uses a second OS process
with the same author and copied prefix; the peer's complete SDK state survives
refusal and retry. The first-pass provenance corpus passes **48** malformed
current/baseline cases plus its legacy/missing-field allow corpus.

Nine disposable behavioral reverts reproduce the rejected designs: rollback prefix
ownership; provenance prefix filtering; deletion-marker inference; late relationship
validation; unscoped native hooks; missing compensated-deletion publication; foreign
identity errors converted before skip handling; replacing an unpublished invocation
after data commit; and losing the original typed item-hook interruption. The latter
two cases additionally check a later portable edit plus an older replay after both
readback/data-commit interruptions, and recovery after creation/update/rollback
pre-write guard interruptions. Exact commands and counterexamples are recorded on
`pm-memory-1363`; the source checkout was never mutated for a revert.

The current SDK journal crash control passed all **21** transitions, retaining two
bounded items and their renewal evidence. The original complete-document update
control passed all **34** observed import steps. The linked pinned pm runner passed
**2/2** recovery roots, including both post-data-commit interruptions and native
pre-write interruptions in all three write phases.

The stateful model observer now accepts both SDK step-id spellings (item id at the
end, or followed by a legacy suffix), and requires exactly one immutable target.
No expected state, field, relationship or sequence-count assertion changed. Its
isolated observer-only revert fails at master `0x1363cafe`, sequence **2**, seed
**1339211376**, step **34**. The current source completes sequences 0–3 with seeds
`325307134`, `2979742903`, `1339211376`, `3993647145`. Sequence 4
(`2353115618`) was canceled by the existing **600-second** batch timeout on the
saturated host. That is **four complete sequences**, not a passing five-sequence
batch or a current 500-sequence claim. The committed 500-sequence contracts and
timeouts remain unchanged; complete current-head evidence belongs to CI.
An unfinished optional instrumented critical repeat was also stopped without a
result and contributes no passing count.

Transition observers use the same guarded path as ordinary CLI imports. Each data
mutation and ownership publication validates its read set before applying; commits
revalidate it. Read-only journal events do not add observer-dependent global scans.
All actual SDK transition and native write boundaries remain in the interleaving
probe. The optional `PM_MEMORY_CRITICAL_PROGRESS=1` test flag prints per-boundary
progress without changing assertions or execution guards. The earlier plain repeat
passed ten roots and timed out only its creation matrix at the existing 20-minute
limit; that is not a complete-file pass. Final counts are measured again against
the shared path and reported separately.

The packed critical consumer passes **1/1** root from one captured archive: actual
Node and Bun runtimes, two same-author second-process peer writes, and four native
CLI refusals across JSON/TOON. Every malformed-provenance refusal preserves its
complete durable tracker snapshot. Archive integrity:
`sha512-WWrFkmfa0X/FzaZqNIATBAKKJfyYNZB/nYr8zRYZeILPwAEnaqJOVUP5dn3AoAPppA1txRtxhmDZ5clqqAiRyg==`.
Snapshot oracles record symbolic-link targets verbatim rather than following
foreign links; regular files still compare their complete bytes. This handles the
SDK-installed extension tree without ignoring its entries or failing on a dangling
foreign bin link.

The isolated consumer-oracle revert restores only symlink dereferencing and fails
the same captured-consumer test with `ENOENT` on the foreign SDK bin link. The
corrected oracle passes both runtimes and all four CLI refusals. In total the pm
item records **nine production-design** and **two test-oracle** behavioral revert
proofs. Final full npm/Bun gate outcomes are reported on the exact pushed head.

## Cancellation and field-local rollback (review correction)

Rollback never deletes a native item. Creations with positively verified SDK birth
evidence are canceled using the current registry role and an import-run reason;
relationships remain intact. A peer status or assignee which cancellation would
erase causes the item to remain untouched with a receipt. Update rollback restores
only SDK-read field values still equal to this invocation's exact historical write;
other fields and relationships are preserved and named in the rollback receipt.

The SDK workspace transaction coordinator serializes transactions only. Plain SDK
and CLI writers can commit between its inspect/apply callbacks. The final native
hook re-reads the complete hash and history immediately before mutation, but the
remaining re-read-to-write window is a known limitation, not proven isolation:
[pm-cli#1576](https://github.com/unbraind/pm-cli/issues/1576),
[pm-cli#1620](https://github.com/unbraind/pm-cli/issues/1620). Tests inject real OS
peers at observed boundaries; they do not certify an atomic expected-hash API.

`portable-cancellation.test.ts` covers incoming Task dependencies at every observed
rollback boundary, an independent seeded field/relationship/comment/assignee model,
and the review's exact rollback-apply reproduction. The reference checks SDK
read-back, preserved peer values, no deletion entries and a closed graph.

The cancellation-role audit also covers memory selectors, export inventories and
omission receipts, renewal, consent inspection and consolidation. Store reads retain
the native status id and attach a derived cancellation flag only when the SDK role
differs from the legacy literal. All selectors share that classification. A registry
migration fixture renames the canceled role; SDK read-back, recall, renewal and
export all respect the migrated role. The SDK reserves built-in status names, so
re-registering the old built-in label as an active status is refused by the SDK.

The prior whole-peer-row equality oracle is replaced by comparison of every field
the peer actually changed, derived independently from before/after SDK reads and
excluding only the derived write timestamp. This allows rollback to restore an
untouched import-written description while preserving the peer's body. A separate
fixed regression requires that precise partial restoration and fails on behavioral
revert; the random model also checks all selected peer fields and graph closure.

Final cancellation review evidence (2026-10-29):

| Check | Measured result |
| --- | --- |
| Focused rollback/lifecycle suite | 12 roots passed; no failures or cancellations |
| Random same-author peer edits | 192 schedules: creation 120, update 72; master `0x1363ca77` |
| Incoming Task references | 24 schedules: creation 15, update 9; no dangling edge |
| Broader critical suite | 11 roots passed; 144 schedules (80 create, 55 update, 9 rollback), plus 48 malformed-provenance refusals |
| Birth proposal controls | All nine fresh/interrupted/compensated read/guard boundaries pass with retained canceled identities |
| Behavioral reverts | Six counterexamples: dangling edge, unrestored description, mistaken lifecycle literal, default-schema read, intended rather than written birth graph, and SDK-cleared peer assignee |
| Rebuilt packed artifact | One archive tested in native Node and Bun; four same-author OS peers, two rollback cancellations, four JSON/TOON CLI refusals |
| Public read-only copy | 17 items, six bodies, 232693 input bytes; 17 guidance / 34 renewals / 19 files / 17 unchanged retries per harness; zero lost bounds or evidence |

The final archive integrity is
`sha512-lYlnMdrtq9Pt/AKNXyYGF1fEWfjmJl6RoSrDBSG5ScBzJrfcDamJLCkeLn1diu0CxhgkrqzpXgxatjoIDTJcYQ==`.
It was captured after rebuilding the ignored distribution; prior archives are not
substituted for this shipped-code evidence. Source fingerprint remained
`652fd875763b57b52c1fb7af1a98e8d655511188a9129f5b8c7fa56a73c22fb7`.

The stateful model keeps its unchanged 500-sequence contract. A focused batch of
sequences 50–54 passed 230 SDK read-back comparisons with master `0x1363cafe` and
seeds `4198076704`, `2557545177`, `917013650`, `3571449419`, `1930917892`.
After the final own-key/proposal hardening, a repeat completed sequences 50 and 51
before the unchanged 600-second parent deadline. Cancellation removed fixture files
while sequence 52 was still reading them, producing a secondary missing-file failure;
that repeat is excluded from passing batch totals. No full current-head 500-sequence
or coverage-threshold pass is claimed locally. The two-module focused coverage
probe is likewise not a full-source coverage attestation; npm/Bun release results
belong to exact-head CI and are reported separately in the PR.
