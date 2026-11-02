# PR 15 review dispositions and validation

This is the orchestrator handoff for the 54 unresolved cubic threads fetched on
2026-11-02. GraphQL returned 68 total threads, 54 unresolved, with all comments
(one per unresolved thread), no additional thread page, and no additional comment
page. Prior resolved threads were retained. No replies or resolutions were sent.
Priority totals: **1 P1, 35 P2, 18 P3**. Dispositions: **53 fixed in scope,
1 refuted**. No valid out-of-scope finding remains to create a follow-up for.

`e9c30c0` correctly merges main and changes only the foundation tracker receipt;
main's package version fields remain intact. `50c1b62` supplies the endpoint
certification foundation and the proofless-document refusal. Its inherited
uncommitted changes were reviewed individually. This continuation strengthens
immutable document ABA admission, no-op certification, intent-before-target
publication, timestamp validation and the independent regression oracles.

The evidence column distinguishes behavioral mutations from test-only assertion
or documentation corrections. Reverting a stronger test assertion merely weakens
the oracle, so those rows do not invent a product-code revert failure. Mutations
run only in disposable source copies with genuine SDK trackers and are restored
before their passing controls are rerun. The full release gate is reserved for
CI; focused coverage does not certify all 4000 property sequences.

| Thread id | Priority | Classification | Change or reason | Revert proof or validation |
| --- | --- | --- | --- | --- |
| `PRRT_kwDOVPw2oc6yXN2W` | P1 | fixed | Refuse proofless overwrite and stale source-artifact generations, including ABA. Fresh exports bind the current artifact history and can authorize another edit while retaining unrelated native metadata. (`src/portable-source.ts`) | Proofless overwrite: 1 failure; raw/companion/policy ABA: 6 failures; recurring generation: 5 failures; unreceipted pre-generation export: 1 failure. Eight final ABA controls cover current and older formats. |
| `PRRT_kwDOVPw2oc6yXN2X` | P2 | fixed | Catch only ENOENT while reading an optional intent in portable-critical; propagate malformed JSON and other causes. (`test/portable-critical.test.ts`) | Test harness correction; existing full-boundary peer corpus retained. |
| `PRRT_kwDOVPw2oc6yXN2Y` | P2 | fixed | Companion grammar test edits manifest.guidance[0].path and preserves its policy marker. (`test/portable-grammar.test.ts`) | Oracle correction; checks updated=1, kind, description and complete native body. |
| `PRRT_kwDOVPw2oc6yXN2Z` | P2 | fixed | Observe complete native history only for apply; preview still validates pending merge receipts. (`src/consolidate.ts`) | preview-history mutation; unrelated unreadable native Task history control. |
| `PRRT_kwDOVPw2oc6yXN2b` | P2 | fixed | Rename the export test to state collision namespacing, matching its assertions. (`test/review-r10.test.ts`) | Title-only correction; existing namespaced-file assertions retained. |
| `PRRT_kwDOVPw2oc6yXN2d` | P2 | refuted | package.json:37-39 explicitly configures --status closed,in_progress. CHANGELOG.md:3 labels the section Unreleased; an in-progress entry is not a release assertion. Retain generated output and mandatory open PM state. (`CHANGELOG.md`) | npm run changelog and npm run changelog:check; no product mutation applies. |
| `PRRT_kwDOVPw2oc6yXN2f` | P2 | fixed | Attach a rejection handler to started as well as done in the independent native peer helper. (`test/portable-native-peer.ts`) | Harness lifecycle correction; every peer-boundary schedule still requires a real completion. |
| `PRRT_kwDOVPw2oc6yXN2h` | P2 | fixed | Canceled renewal must return missing, matching the selector; validity is insufficient. (`test/portable-lifecycle.test.ts`) | Oracle strengthening in portable-lifecycle.test.ts; exact code assertion. |
| `PRRT_kwDOVPw2oc6yXN2k` | P2 | fixed | Origin refusal predicates require origin_missing plus the specific message fragment for metadata, missing birth, ambiguity and continuation. (`test/portable-origin.test.ts`) | Oracle strengthening; specific cursor and catalog causes are asserted. |
| `PRRT_kwDOVPw2oc6yXN2l` | P2 | fixed | Snapshot runtime and transactions separately, with directory names retained to prevent key collisions. (`test/portable-locality.test.ts`) | Oracle strengthening in portable-locality.test.ts; full native rows plus both durable evidence trees. |
| `PRRT_kwDOVPw2oc6yXN2n` | P2 | fixed | Exported needs-renewal guidance retains its window and ancestry; reimport into a fresh tracker still needs renewal. (`test/guidance.test.ts`) | Regression in guidance.test.ts checks manifest and fresh guidanceState. |
| `PRRT_kwDOVPw2oc6yXN2o` | P2 | fixed | Capture and assert the second companion import receipt after reconciliation. (`test/portable-companion.test.ts`) | Oracle strengthening; second updated count, foreign skip and unresolved link are checked. |
| `PRRT_kwDOVPw2oc6yXN2p` | P2 | fixed | Use the LCG high bits for grammar choices; retain all 500 seeds. (`test/portable-grammar.worker.ts`) | Independent enumeration: old generator 2/32 boolean combinations; new generator 32/32. Grammar worker smoke retains SDK oracle. |
| `PRRT_kwDOVPw2oc6yXN2r` | P2 | fixed | Validate historical memory_validity using the strict window guard shared with renewals. (`src/portable.ts`) | strict-validity: reverting the validation fails its unchecked-key regression. |
| `PRRT_kwDOVPw2oc6yXN2s` | P2 | fixed | Do not report an applied renamed native origin in skipped; retain its native slug. (`src/portable.ts`) | Companion regression asserts the second skip list contains only the uninventoried foreign file. |
| `PRRT_kwDOVPw2oc6yXN2t` | P2 | fixed | Projection-peer rejection requires the expected conflict code. (`test/portable-preview.test.ts`) | Oracle strengthening in portable-preview.test.ts; peer body retention is also asserted. |
| `PRRT_kwDOVPw2oc6yXN2v` | P2 | fixed | Name copied-birth coverage precisely: intent and item-read; broader boundary coverage remains in the independent sweeps. (`test/portable-admission.test.ts`) | Title correction; all original adapter, recovery, native type and copied-marker cases retained. |
| `PRRT_kwDOVPw2oc6yXN2w` | P2 | fixed | Append a superseding PM correction naming merge-receipt.ts, immutable NativeProof and same-hook endpoint certification. (`.agents/pm/history/pm-memory-c3gv.jsonl`) | Historical history stays append-only; current correction read back on pm-memory-c3gv. |
| `PRRT_kwDOVPw2oc6yXN2x` | P2 | fixed | Validation documentation names the former finalization defect, exact current guard contract and pending full-CI limits. (`docs/portable-guidance-validation.md`) | Docs match the passing merge corpus and per-hook mutation receipts; historical counts explicitly superseded. |
| `PRRT_kwDOVPw2oc6yXN2y` | P2 | fixed | Permission publication test requires EACCES from the revoked directory permission. (`test/portable.test.ts`) | Oracle strengthening in portable.test.ts; rerun after restoration must converge. |
| `PRRT_kwDOVPw2oc6yXN2z` | P2 | fixed | Restrict malformed-policy refusals to explicit format/validity/path/conflict/schema/privacy categories; exclude transaction and origin_missing. (`test/portable.test.ts`) | Oracle strengthening; all malformed input cases remain, with byte-for-byte refusal snapshots. |
| `PRRT_kwDOVPw2oc6yXN20` | P2 | fixed | Assert the complete empty policy-file marker and exactly one trailing newline. (`test/transfer.test.ts`) | Oracle strengthening in transfer.test.ts; zero bytes or a missing marker now fails. |
| `PRRT_kwDOVPw2oc6yXN22` | P2 | fixed | Check memories/review.md and memories/standing.md, where policy bodies are published. (`test/transfer.test.ts`) | Oracle strengthening: exact ENOENT on both excluded body paths, plus index exclusion. |
| `PRRT_kwDOVPw2oc6yXN24` | P2 | fixed | Keep the boolean predicate total across foreign reads and SDK conversion failures, preserving valid provider provenance. (`src/portable-relationships.ts`) | Foreign getter/read failure regression returns false; SDK-supported arbitrary named source kinds remain accepted. No fabricated invalid-source-kind claim remains. |
| `PRRT_kwDOVPw2oc6yXN25` | P2 | fixed | Example explicitly warns createMissingOrigins recreates every missing origin in the supplied export. (`examples/portable-guidance.ts`) | Documentation correction; existing explicit-recreation corpus retained. |
| `PRRT_kwDOVPw2oc6yXN26` | P2 | fixed | Preserve unexpected hard-link errors; only the interrupted ENOENT case gets a retry remedy, while EEXIST accepts the peer publication. (`src/portable-origin.ts`) | origin-link-error mutation; permanent EACCES and interrupted-staging recovery controls. |
| `PRRT_kwDOVPw2oc6yXN28` | P2 | fixed | Unreadable SDK creation entries and malformed recognized-native origins throw origin_missing; decodable foreign or non-memory subjects remain excluded. (`src/portable-origin.ts`) | origin-decode mutation; malformed creation patch and malformed native origin JSON/shape must throw the named typed error; genuinely foreign origins stay excluded. |
| `PRRT_kwDOVPw2oc6yXN29` | P2 | fixed | Assert positive boundary lists and positive completed peer schedules, including the complete expected schedule count. (`test/portable-forward.test.ts`) | Harness correction; every generated crash and peer schedule remains required. |
| `PRRT_kwDOVPw2oc6yXN2_` | P2 | fixed | Find the final dependency guard by the actual presence of both endpoints instead of callback index. (`test/portable-forward.test.ts`) | All four fresh/recovery and native-document/foreign-ownership controls still assert a peer edit and retention. |
| `PRRT_kwDOVPw2oc6yXN3A` | P2 | fixed | Run stale receipt generations through both preview and apply with unchanged durable snapshots. (`test/merge-receipt.test.ts`) | Oracle strengthening; shared refusedUnchanged helper checks both modes. |
| `PRRT_kwDOVPw2oc6yXN3C` | P2 | fixed | Require conflict for malformed or semantically changed pending merge receipts. (`test/merge-receipt.test.ts`) | Oracle strengthening in merge-receipt.test.ts; unrelated MemoryError categories cannot pass. |
| `PRRT_kwDOVPw2oc6yXN3E` | P2 | fixed | Restore the destination body after a native edit and require a conflict plus retained restored body. (`test/merge-receipt.test.ts`) | Admission ABA regression, immutable merge-history ABA corpus and eight admission-hook mutations. |
| `PRRT_kwDOVPw2oc6yXN3F` | P2 | fixed | README now says a conflict skips the whole item; only edits in other items may continue. (`README.md`) | Documentation correction aligned with whole-item and dependent-conflict tests. |
| `PRRT_kwDOVPw2oc6yXN3I` | P2 | fixed | Canonical UTC validation reuses instant(), including rejection of rollover dates and non-string values, before recovery. (`src/merge-receipt.ts`) | Malformed receipt matrix covers changed_at type, malformed text and February 30 in preview/apply. |
| `PRRT_kwDOVPw2oc6yXN3J` | P2 | fixed | Persist source intent before touching target; body and provenance relationship publish together, without an unjournaled preparation write. (`src/merge-receipt.ts`) | intent-order mutation fails the no-mutation control; two consecutive denied intents preserve every byte before successful retry. |
| `PRRT_kwDOVPw2oc6yXN3K` | P2 | fixed | Keep literal legacy canceled terminal even when custom registry roles omit that name. (`src/store.ts`) | Pure custom-registry predicate regression plus real SDK lifecycle/renewal/export controls; legacy-status mutation. |
| `PRRT_kwDOVPw2oc6yXN3M` | P3 | fixed | Consumer environment scrub covers KEY, AUTH and PAT as secret-name components. (`test/consumer-helpers.ts`) | Harness hardening; packed consumers still run with isolated HOME/npm/git settings. |
| `PRRT_kwDOVPw2oc6yXN3O` | P3 | fixed | Grammar helper comment accurately describes reading the target public SDK endpoint. (`test/portable-grammar.test.ts`) | Comment-only correction; SDK read-back assertions retained. |
| `PRRT_kwDOVPw2oc6yXN3P` | P3 | fixed | Separate namespaced reserved index slug success from case-folded legacy export collision refusal. (`test/review-r4.test.ts`) | Both namespaced guidance and real legacy collision assertions retained; root reserved index is regenerated under policy mode. |
| `PRRT_kwDOVPw2oc6yXN3Q` | P3 | fixed | Split artifact-selector refusal from canceled/reopened artifact export behavior. (`test/review-r8.test.ts`) | Both original assertion groups retained as separately named tests using a shared index fixture. |
| `PRRT_kwDOVPw2oc6yXN3S` | P3 | fixed | SDK task description distinguishes closed readers from still-open native-precondition blockers. (`.agents/pm/tasks/pm-memory-sdk-transaction-reader.toon`) | Tracker description and superseding append-only comment agree; no upstream modification. |
| `PRRT_kwDOVPw2oc6yXN3U` | P3 | fixed | Packed diagnostic derives runtime and CLI refusal counts from executed loops; remove unmeasured process/item claims. (`test/critical.acceptance.ts`) | Harness evidence correction; per-runtime and per-format assertions retained. |
| `PRRT_kwDOVPw2oc6yXN3V` | P3 | fixed | Describe 500 SDK-read sequences in concurrent 25-sequence batches, without claiming independence inside a tracker batch. (`test/portable-laws.test.ts`) | Title-only correction; complete 500-sequence budget and exact batch receipts retained. |
| `PRRT_kwDOVPw2oc6yXN3Y` | P3 | fixed | Resolve status registry lazily only when an admitted memory needs projection. (`src/store.ts`) | Performance-only eager-to-lazy change; empty/excluded projection controls retain semantics. No behavioral revert failure is claimed. |
| `PRRT_kwDOVPw2oc6yXN3a` | P3 | fixed | Use withoutGit for lossless scenarios and remove duplicate partial Git-ceiling logic. (`test/portable-lossless.test.ts`) | Harness reuse; all field, relationship, alias and legacy cases retained. |
| `PRRT_kwDOVPw2oc6yXN3b` | P3 | fixed | Assert interrupted owned intent retires to undefined before capturing the publication proof. (`test/portable-publication-helpers.ts`) | Helper postcondition; every publication/recovery control uses the same asserted retirement. |
| `PRRT_kwDOVPw2oc6yXN3d` | P3 | fixed | Run chmod-based unreadability assertion only where mode bits are observable; root bypasses them. (`test/portable-preview.test.ts`) | Permission harness correction; all non-permission symlink/copy controls still execute. |
| `PRRT_kwDOVPw2oc6yXN3f` | P3 | fixed | Detect empty LF/CRLF frontmatter and exclude its delimiters from semantic title/body. (`src/portable-source.ts`) | empty-frontmatter mutation; exact body/title and captured empty metadata regression. |
| `PRRT_kwDOVPw2oc6yXN3h` | P3 | fixed | Require the exact undecodable-source-provenance refusal reason. (`test/portable-scope-controls.test.ts`) | Oracle strengthening in portable-scope-controls.test.ts; whole-tracker snapshot retained. |
| `PRRT_kwDOVPw2oc6yXN3j` | P3 | fixed | Example states pinned release-policy must already exist before renewal. (`examples/portable-guidance.ts`) | Documentation correction; existing missing/canceled/validity renewal controls retained. |
| `PRRT_kwDOVPw2oc6yXN3k` | P3 | fixed | Remove unused liveIds parameter and allocations at every caller; pagination limit remains explicit. (`src/portable-origin.ts`) | Type checking and origin catalog pagination controls; no behavioral change intended. |
| `PRRT_kwDOVPw2oc6yXN3m` | P3 | fixed | HarnessDocument.original explicitly documents base64 encoding. (`src/types.ts`) | Type documentation correction; document byte-envelope round-trip tests retained. |
| `PRRT_kwDOVPw2oc6yXN3p` | P3 | fixed | Packed native oracle removes volatile fields before comparison and independently checks clocks, evidence clearing and every document-envelope field. (`test/install.acceptance.ts`) | Packed acceptance plus exact version/harness/format/path/base64 assertions; no self-derived expected document. |
| `PRRT_kwDOVPw2oc6yXN3s` | P3 | fixed | Incomplete observations and stale generations require conflict explicitly. (`test/merge-receipt.test.ts`) | Oracle strengthening; missing source/target observations and restored native destination are checked. |

## Finalization proof receipts

The unchanged independent peer oracle inside each forward schedule has SHA-256
`5171674f47f51437043dfba3879d5c2b21178a744314b87fe9eaa814b9ab2900`.
It is byte-identical to `50c1b62` after removing only the old scheduling counter.
Every ordinary edit/ABA admission test requires an actual injection, the exact
conflict, retention of the receipt, and refusal before the next certified write.

| Disposable behavioral mutation | Required failing controls |
| --- | ---: |
| Remove additional-item certification only inside the SDK admission hook | 8/8: edit and ABA at intent, publish, cancel, finish |
| Remove additional-item certification only from SDK no-op read-back | 4/4: default/host, edit/ABA |
| Permit stored-document replacement without a derivable expected hash | 1/1 |
| Restore hash-only document admission after native edit generations | 6/6: raw/companion/policy, before planning/at read |
| Reintroduce an unjournaled target preparation | 1/1 |
| Bypass strict validity-history validation | 1/1 |
| Drop literal legacy cancellation from custom registry interpretation | 1/1 |
| Ignore empty frontmatter | 1/1 |
| Replace permanent link errors with an interrupted-publication retry hint | 1/1 |
| Silently ignore unreadable SDK creation entries | 1/1 |
| Observe unrelated native histories during merge preview | 1/1 |
| Replace immutable artifact generations with a recurring value | 5 failures (plus 2 unchanged controls) |
| Permit unreceipted pre-generation exports to replace existing documents | 1/1 |
| Let foreign relationship getter/conversion exceptions escape the boolean predicate | 1/1 |

The eager-to-lazy registry change preserves semantics, so it has no behavioral
revert-failure claim. Test-only assertions and documentation corrections use the
evidence stated in their table rows. All mutations were confined to disposable
source copies; the package worktree was never behaviorally reverted.

## Duration controls

Forward sweeps reuse prepared source/destination fixtures and clone all writable
state. Independent schedules execute in fresh batches of at most five, with two
worker processes per suite; each child runs its slice serially. Workers discover
the same complete schedule count, enforce the assigned range, and return an
exact completion receipt. The parent checks the sum of assigned schedules and
requires every receipt. Property suites retain all 500 seeds per law and their
original SDK assertions, with two worker batches active at a time. No coverage
threshold, duplication threshold, operation alphabet or property budget changed.

The historical Node 22 job hit its six-hour limit. The historical Node 26 job
instead passed 830 unit tests and strict coverage, then failed packed Bun
acceptance on empty-string versus absent cleared verification fields. The
consumer now rejects retained evidence while accepting either native empty
representation and checks each document-envelope field independently.

Full 500-sequence after timings and complete release certification belong to CI
on the pushed head. The local property timings below are explicitly small batch
measurements, not whole-suite speedup claims.


Measured forward-suite durations (seconds): the before column is the historical
Node 22 CI job with coverage; local after is Node 26 on a shared host, without
coverage. These establish completed budgets and observed cost, not a controlled
runtime speedup ratio. In particular, the final update-peer measurement preceded
the last shared-template handoff optimization; that optimization retains its
unchanged inner oracle and complete 200-schedule budget.

| Forward suite | Before CI | Local prepared/batched after | Completed schedules |
| --- | ---: | ---: | ---: |
| Update peers | 1147.303 | 661.801 | 200 |
| Creation peers | 5034.240 | 508.063 | 240 |
| Linked creation peers | 1610.827 | 73.624 | 31 |
| Update crashes | 2188.622 | 80.292 | every discovered boundary |
| Creation crashes | 3079.424 | 101.631 | every discovered boundary |
| Linked creation crashes | 2283.526 | 78.737 | every discovered boundary |
| Schema/origin bootstrap | not separately extracted | 114.917 | every discovered boundary |
| Resumed recovery | not separately extracted | 131.643 | every discovered boundary |

A same-host three-control comparison before/after prepared fixtures completed
3/3 each: total 64.060 / 46.006 s. Individual exact-peer, native-ABA and foreign-alias
costs were respectively 19.530 / 25.030, 25.273 / 4.092 and 16.454 / 14.812 s.
Warm-cache and shared-host load vary, so the slower exact-peer result is retained.
The independently completed final forward runs cover all original 21 test names.

The eight full 500-sequence property suites remain in CI. The before timings are
historical Node 26 CI with coverage; local after samples measure only the stated
batch size, not an extrapolated full-suite duration.

| Property suite | Before full 500 (s) | Local after sample (s) | Sample sequences |
| --- | ---: | ---: | ---: |
| Owned scopes | 1192.674 | 131.614 | 5 |
| Complete documents | 462.530 | 67.811 | 5 |
| Provenance fidelity | 619.711 | 120.359 | 5 |
| Harness grammar | 860.325 | 114.279 | 25 |
| Identity law | 160.012 | 21.890 | 5 |
| Locality law | 326.383 | 48.918 | 5 |
| Foreign isolation law | 323.305 | 39.981 | 5 |
| Stateful model | 2702.279 | 176.607 | 5 |

All 60 sampled sequences (18 reported test nodes) passed. Full-suite after timing
and the npm/Bun release result remain explicit pushed-head CI evidence; local
samples cannot establish that the complete matrix is below six hours.

The new document-generation token is tracker-local admission evidence, like the
native baseline id. Fresh-tracker semantic comparisons normalize both tokens,
while explicitly asserting a valid new generation and a distinct native history.
The source-document, metadata, body, relationship, renewal and origin assertions
are retained in full. Old unreceipted companions cannot replace already-stored
artifact bytes without history proof; creating a first artifact and replaying
proven owned scopes remain supported.
