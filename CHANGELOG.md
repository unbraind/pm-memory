# Changelog

## Unreleased

### Other

- Keep published dependency updates in the generated changelog ([pm-memory-xgli](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/chores/pm-memory-xgli.toon))

### Closed

- Closed: Release timeout retains an approval warning after CI was successfully approved ([pm-memory-github-f33c4a70a040-44](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-github-f33c4a70a040-44.toon))

### Dependencies

- Bump unbraind/pm-ops/.github/workflows/daily-release.yml from 2026.11.19 to 2026.11.22 ([#102](https://github.com/unbraind/pm-memory/pull/102))
- Bump the codeql-action group with 2 updates ([#93](https://github.com/unbraind/pm-memory/pull/93))
- Bump unbraind/pm-ops/.github/workflows/daily-release.yml from 2026.11.14 to 2026.11.19 ([#95](https://github.com/unbraind/pm-memory/pull/95))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml from 2026.11.15 to 2026.11.18 ([#94](https://github.com/unbraind/pm-memory/pull/94))

## 2026.11.21 - 2026-11-21

### Added

- Recall durable memory by native task ID ([pm-memory-task-recall](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-task-recall.toon))

## 2026.11.14 - 2026-11-18

### Added

- Adopt public SDK transaction inspection and native hash preconditions ([pm-memory-sdk-transaction-reader](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-sdk-transaction-reader.toon))
- Delegate memory credential detection to SDK mutation secret scanner ([pm-memory-sdk-secret-scan](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-sdk-secret-scan.toon))

### Fixed

- Accept additive SDK secret rules without weakening memory privacy ([pm-memory-sdk-rule-1117](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-sdk-rule-1117.toon))

### Other

- Apply Fleet CI v2 and bound release-gate test lifecycles ([pm-memory-higm](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/tasks/pm-memory-higm.toon))

### Closed

- Closed: Release gate intermittently fails while removing a CLI fixture lock directory ([pm-memory-github-f33c4a70a040-75](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-github-f33c4a70a040-75.toon))

### Dependencies

- Bump eslint ([#83](https://github.com/unbraind/pm-memory/pull/83))
- Bump @babel/eslint-parser ([#78](https://github.com/unbraind/pm-memory/pull/78))

## 2026.11.13 - 2026-11-13

### Fixed

- Refuse quoted JSON and YAML credential keys before persistence ([pm-memory-quoted-credential-keys](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-quoted-credential-keys.toon))
- Make portable preparation contention tests independent of writer wait timing ([pm-memory-preparation-boundary-barriers](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-preparation-boundary-barriers.toon))

### Closed

- Closed: Quoted JSON credential keys bypass the secret guard and survive export ([pm-memory-github-f33c4a70a040-52](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-github-f33c4a70a040-52.toon))

### Dependencies

- Bump jscpd ([#60](https://github.com/unbraind/pm-memory/pull/60))
- Bump the pm-toolchain group across 1 directory with 3 updates ([#57](https://github.com/unbraind/pm-memory/pull/57))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#56](https://github.com/unbraind/pm-memory/pull/56))
- Bump the codeql-action group with 2 updates ([#55](https://github.com/unbraind/pm-memory/pull/55))

## 2026.11.7 - 2026-11-07

### Added

- Preserve guidance validity in portable harness round trips ([pm-memory-1363](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-1363.toon))

### Fixed

- Daily release never publishes: npm reads release-artifact/package.tgz as a GitHub repository ([pm-memory-ielg](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-ielg.toon))
- Refuse stale merge receipts after intervening memory edits ([pm-memory-c3gv](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-c3gv.toon))
- Pool-lane stop test assumes the failing batch wins the first worker slot ([pm-memory-x47g](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/issues/pm-memory-x47g.toon))

### Other

- Migrate the November 4 toolchain and verification collision fixtures ([pm-memory-toolchain-1104](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/chores/pm-memory-toolchain-1104.toon))
- Address PR 48 rejection and caller-stop review findings ([pm-memory-review48](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/tasks/pm-memory-review48.toon))
- Run each property-suite release gate in its own CI job ([pm-memory-smuq](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/tasks/pm-memory-smuq.toon))

### Dependencies

- Bump the dependencies group across 1 directory with 2 updates ([#38](https://github.com/unbraind/pm-memory/pull/38))
- Bump the pm-toolchain group across 1 directory with 3 updates ([#35](https://github.com/unbraind/pm-memory/pull/35))

## 2026.11.2 - 2026-11-02

### Added

- SDK revision foundation and native verification ([pm-memory-native-revision-foundation](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/features/pm-memory-native-revision-foundation.toon))

### Dependencies

- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#34](https://github.com/unbraind/pm-memory/pull/34))

## 2026.10.31 - 2026-10-31

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#28](https://github.com/unbraind/pm-memory/pull/28))
- Bump @unbrained/pm-cli ([#27](https://github.com/unbraind/pm-memory/pull/27))

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

### Dependencies

- Bump the pm-toolchain group across 1 directory with 3 updates ([#25](https://github.com/unbraind/pm-memory/pull/25))
- Bump the pm-toolchain group across 1 directory with 3 updates ([#21](https://github.com/unbraind/pm-memory/pull/21))
- Bump jscpd ([#20](https://github.com/unbraind/pm-memory/pull/20))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#18](https://github.com/unbraind/pm-memory/pull/18))
- Bump the codeql-action group with 2 updates ([#17](https://github.com/unbraind/pm-memory/pull/17))
- Bump the pm-toolchain group with 3 updates ([#11](https://github.com/unbraind/pm-memory/pull/11))
- Bump the codeql-action group with 2 updates ([#4](https://github.com/unbraind/pm-memory/pull/4))
- Bump the pm-toolchain group with 2 updates ([#9](https://github.com/unbraind/pm-memory/pull/9))
- Bump the pm-toolchain group across 1 directory with 2 updates ([#2](https://github.com/unbraind/pm-memory/pull/2))
- Bump eslint ([#3](https://github.com/unbraind/pm-memory/pull/3))
