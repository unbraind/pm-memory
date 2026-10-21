# Outcome-linked memory utility validation

This change builds on semantic recall PR #5 and must merge after it. The utility layer records explicit observations, not autonomous training or a causal-benefit guarantee. No source memories or tasks are deleted.

## Overlap recheck

The current CLI workspace-memory SDK rolls up completed tracker context, while pm-context usage receipts track exposure and affinity. pm-memory recall counters already measure exposure; PR #5 adds semantic retrieval. pm-rl owns learning/evaluation/policy and merge-outcome evidence. None of those surfaces attaches explicit helpful/unhelpful observations to a specific recalled memory revision and native later task with the denominators used here.

## Public-data replay

Source: the public [pm-context tracker](https://github.com/unbraind/pm-context/tree/7d156cd179b1a02a4023d0c8690dcba7d8594c81/.agents/pm), commit `7d156cd179b1a02a4023d0c8690dcba7d8594c81`. Repository visibility was verified public. Only committed tracker files were extracted into a non-git directory and made read-only. The example copied those bytes into a disposable scratch tracker; it never wrote the source. No hosted data was read.

Command: `node examples/outcome-utility.ts <read-only-public-tracker-directory>` with ancestor Git discovery blocked. The example does not invoke Git.

| Measurement | Result |
| --- | ---: |
| Source files fingerprinted before and after | 167 |
| Source items in certified complete read | 80 |
| Completed source items with explicit completion timestamps | 56 |
| Guidance memories added to disposable copy | 1 |
| Receipt-backed recall exposures of that memory | 1 |
| Explicit scripted annotations on distinct real tasks | 6 |
| Helpful / unhelpful annotation labels | 3 / 3 |
| Identical retries, all returning recorded=false | 6 |
| Confounded observations excluded | 3 |
| Pre-recall completions excluded | 3 |
| Scored outcomes | 0 / 6 |
| Recall packet estimated tokens | 107 |
| Selected-memory report estimated tokens (max JSON/TOON) | 412 |
| Source files changed | 0 |

Source SHA-256 over stable relative file names and bytes: `93bc45f8b2f7a2a577b9d2d360b6990dc77095dbcb66c806ab47e2ff9d9cec8f`.

These annotations deliberately exercise the API with known labels against real historical tasks; they are **scripted validation inputs**, not measured human feedback or an experiment showing benefit. All six claim improved performance as an input, yet zero become scored improvements: three are confounded, and three tasks completed before recall. This is a denominator/exclusion validation, not a claim that guidance improved six tasks.

## Local validation scope

Targeted memory/command compatibility: 13 tests passed. Utility scenarios cover idempotent byte-stable retries, native task aliases, revision cohorts, unobserved and legacy exposure denominators, confounded/unknown/unfinished/pre-recall outcomes, malformed ledgers, privacy refusals, archived evidence, and native TOON/JSON with Git absent from PATH. Typecheck, lint, docstring and duplication gates run locally; unchanged full coverage and packed npm/Bun gates run in CI to avoid duplicating the full suite on the saturated host.

## Behavioral revert proofs

Each mutation changed only the relevant production behavior and left its regression intact. Each produced one failing regression; all implementations were restored immediately afterward.

| Behavior removed | Targeted regression command | Mutated result |
| --- | --- | --- |
| Idempotent duplicate receipt | `node --test --test-name-pattern "utility keeps honest" test/utility.test.ts` | 1 failure |
| Confounded-outcome exclusion | `node --test --test-name-pattern "confounded and unknown" test/utility.test.ts` | 1 failure |
| Preflight all ledgers before counters | `node --test --test-name-pattern "recall preflights" test/utility.test.ts` | 1 failure |

The first linked utility run exceeded the default 120-second limit after four passing scenarios under host contention. Its recorded timeout was raised to 300 seconds; this changes no correctness or coverage thresholds. Full release gates remain CI evidence.
