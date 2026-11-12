# Changelog

## Unreleased

### Added

- Adopt public SDK transaction inspection and native hash preconditions ([pm-memory-sdk-transaction-reader](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-sdk-transaction-reader.toon))
- Delegate memory credential detection to SDK mutation secret scanner ([pm-memory-sdk-secret-scan](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-sdk-secret-scan.toon))

### Fixed

- Make portable preparation contention tests independent of writer wait timing ([pm-memory-preparation-boundary-barriers](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-preparation-boundary-barriers.toon))
- Refuse quoted JSON and YAML credential keys before persistence ([pm-memory-quoted-credential-keys](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-quoted-credential-keys.toon))

## 2026.11.7 - 2026-11-07

### Added

- Preserve guidance validity in portable harness round trips ([pm-memory-1363](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-1363.toon))

### Fixed

- Pool-lane stop test assumes the failing batch wins the first worker slot ([pm-memory-x47g](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-x47g.toon))
- Daily release never publishes: npm reads release-artifact/package.tgz as a GitHub repository ([pm-memory-ielg](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-ielg.toon))
- Refuse stale merge receipts after intervening memory edits ([pm-memory-c3gv](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-c3gv.toon))

### Other

- Migrate the November 4 toolchain and verification collision fixtures ([pm-memory-toolchain-1104](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/chores/pm-memory-toolchain-1104.toon))
- Address PR 48 rejection and caller-stop review findings ([pm-memory-review48](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/tasks/pm-memory-review48.toon))
- Run each property-suite release gate in its own CI job ([pm-memory-smuq](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/tasks/pm-memory-smuq.toon))

## 2026.11.2 - 2026-11-02

### Added

- SDK revision foundation and native verification ([pm-memory-native-revision-foundation](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-native-revision-foundation.toon))

## 2026.10.28 - 2026-10-28

### Added

- Recall and index ([pm-memory-lc64](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-lc64.toon))
- Outcome-linked memory utility with source denominators ([pm-memory-kkxg](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-kkxg.toon))
- Time-bounded standing guidance with renewal evidence ([pm-memory-wvy5](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-wvy5.toon))
- Consent-scoped memory views ([pm-memory-x5nv](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-x5nv.toon))
- Remember and deduplicate ([pm-memory-ne0p](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-ne0p.toon))
- Import and export ([pm-memory-rt3s](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-rt3s.toon))
- Refuse private credentials ([pm-memory-6tl1](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-6tl1.toon))
- Consolidate memory ([pm-memory-bj84](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-bj84.toon))
- Verify checkable claims ([pm-memory-4tbo](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-4tbo.toon))

### Fixed

- Refuse stale merge receipts after intervening memory edits ([pm-memory-c3gv](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-c3gv.toon))

### Other

- Release readiness behind PM_RELEASE_APPROVED ([pm-memory-release-gate](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/chores/pm-memory-release-gate.toon))
- Recover process-reused writers and fence expired memory leases ([pm-memory-sdk-lock-protocol](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/tasks/pm-memory-sdk-lock-protocol.toon))
- Reconcile stale in-progress tracker records (2026-10-23) ([pm-memory-reconcile-1023](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/chores/pm-memory-reconcile-1023.toon))
