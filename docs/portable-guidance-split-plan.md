# Portable guidance: identity blocker and split plan

PR #15 remains blocked. No code from this review round is pushed. The supplied
portable-planning overwrite and verification documentation findings have local
candidate fixes, but the whole package identity class is still open in native
merge recovery. The release thresholds and existing tests remain unchanged.

## Remaining blocker

`test/merge-revision-blocker.test.ts` captures a receipt from a real successful
consolidation, restores its endpoints as a pending operation, then edits the
survivor to another body and back after the frozen intent exists. The clock is
fixed. Its complete SDK document hash returns to the saved value while native
history grows by two entries. Current replay writes the old merged payload over
the restored native body and cancels the source.

`src/consolidate.ts` hashes semantic fields plus `updated` in its persisted
`source_revision`, `target_before` and `target_after`. Those receipts contain no
immutable generation for either endpoint. A body restored under a colliding
clock can therefore satisfy the old receipt again. The existing regression in
`test/review-r5.test.ts` covers differing native values, but also permits replay
after restoring the old body and content timestamp. A compatible receipt protocol
and an explicit fresh-request policy must settle that boundary together.

This is a package recovery-protocol deficiency. No missing SDK capability is
asserted. Existing receipt serialization and append-only native history must be
preserved; changing the digest input alone would invalidate existing receipts
without establishing their historical identity.

## Proposed landing order

1. **SDK revision foundation and native verification.** Extract SDK-only native
   document hashing, history proofs, frozen corpus capture and guarded native
   publication into `src/native-revision.ts`, rather than importing portable
   planning modules from verification. Include only the necessary schema/lease
   helpers from Store and lifecycle code. Bind verification to complete SDK
   content plus immutable history, recheck in the SDK pre-write hook, and validate
   SDK no-ops. Carry the native collision, independent-peer, ABA, permission and
   unchanged-snapshot controls. This is the first independently reviewable
   candidate; it does not require portable manifest or merge-receipt migration.

2. **Native merge recovery protocol.** Version new receipts with immutable source
   and target generations and a unique attempt identity. Persist intent before
   body publication, then record or reconcile the exact successful publication
   before canceling the source. Advance expected generations only for positively
   proven writes from the current attempt. Refuse native mismatches and ABA before
   item writes, preserving completed writes and refusal history. Ship explicit
   previous-release read/evaluate/export fixtures and a legacy apply policy:
   unprovable frozen receipts need a non-mutating conflict and a clear fresh-plan
   remedy. Preserve the old serialized records and all history. Cover every crash
   boundary, already-published bodies, same-author/copied-marker peers and the
   failing regression retained here.

3. **Portable guidance and source lifecycle.** Rebase the portable feature on the
   revision foundation and the settled recovery contract. Keep raw, companion and
   policy planners on one frozen SDK snapshot path. Carry all seven harness/adapter
   collision controls, complete source-byte fidelity, validity windows and
   forward-only publication recovery. Keep source verification invalidation and
   its README correction together with the adapter behavior. Parser/CodeQL fixes
   remain with the source-format code they validate.

Each candidate requires its own complete npm and Bun `release:check`, unchanged
100/100/100/100 coverage and 0% duplication, at most two workers, plus green CI and
CodeQL on its pushed head. None is certified for landing by focused tests alone.

## Current evidence

- Fixed candidate controls: **36/36 passed**, no failures, cancellations or skips.
- Timestamp-adoption behavioral revert, changing only `expectedTargets` and
  adapting its old behavior to the frozen-map argument: **8 failed / 1 passed**.
- Original `verify` function restored alone: **12 failed / 6 passed**, including
  semantic/source timestamp collisions and native ABA. Restored implementation
  passes the complete focused controls.
- README-only revert: **1 failed / 0 passed**; restoration passes.
- Remaining native merge regression: **0/1 passed**, with an actual body overwrite.
- Full local release gates completed in this round: **0/2**. npm attempts were
  superseded during the expanding identity audit; Bun was not started after the
  stop condition. No final coverage percentage or release-readiness claim.
- An initial 180-second collision-harness timeout under shared load passed on
  retry without changing assertions.

Tracking: `pm-memory-1363`; reopened `pm-memory-c3gv`. Their latest receipts and
candidate code remain local under the explicit no-partial-push instruction.
