# Scheduled GitHub issue sync diagnosis, 2026-11-16

[Failed workflow run](https://github.com/unbraind/pm-memory/actions/runs/43706726398).

Observed failure:

```text
pm github gate: import plan is not idempotent — 3 duplicate provenance tag(s) in the existing corpus, 0 new entr(y/ies) without a provenance tag, 1 conflicting target(s).
```

The failed run resolved pm-github 2026.11.4. Main now contains [PR #77](https://github.com/unbraind/pm-memory/pull/77), pinning both callers to 2026.11.15. That release separates shared references from exclusive import ownership. The complete corpus has distinct work items, rather than duplicate import owners. Closing them would erase that distinction.

| Reference | Preserved items |
| --- | --- |
| #15 | pm-memory-c3gv (stale merge receipts), pm-memory-1363 (portable guidance) |
| #51 | pm-memory-sdk-transaction-reader (transaction inspection), pm-memory-sdk-secret-scan (credential detection) |
| #52 | pm-memory-quoted-credential-keys (quoted keys), pm-memory-sdk-secret-scan (SDK adoption) |

No items were merged or closed. The old conflicting target arose from using references on one item for multiple issues; the new ownership resolver does not use those references as import claims.

## Import gate evidence

9 planned, 0 skipped, 0 matched by provenance, 0 adopted, 9 new.

For non-blocked importers the read-only command is:

```sh
pm github import unbraind/pm-memory --state all --atomic --gate --dry-run --with-comments --json
```

Command output (exit 0):

```text
pm github gate: plan verified — 9 planned, 0 skipped, 0 matched by provenance, 0 adopted, 9 new.
[dry-run] Atomic plan would import 9, update 0, skip 0. Adopt 0.
```

A passing plan proves completeness and identity planning, not successful writes or a new scheduled CI run. Shared reference tags remain references; new mirror items in a plan are not applied by this investigation.

## Validation

Typecheck and lint pass. The pinned tracker validation returns `ok: true` with existing advisories. The seeded tracker validation and gated import preview also pass through `pm test --run --progress`. The initial quick package run hit the 600-second file watchdog in commands.test.ts and compound-credentials.test.ts under heavy host load; a longer-deadline compound test rerun is running. Package quick tests are still running at the initial draft; no full passing package suite is claimed. Remaining results are recorded in the linked sync repair item. CI is not dispatched manually, and no successful scheduled rerun is claimed.
