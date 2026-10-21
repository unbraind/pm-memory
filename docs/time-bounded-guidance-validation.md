# Time-bounded guidance validation

This feature builds on semantic-recall PR #5 and must merge after it.

## Overlap audit

The current pm CLI 2026.10.21 SDK exposes deadline scheduling and deadline pressure in context relevance. The package-pinned 2026.10.19 SDK has the same relevant contracts. Core deadlines schedule work. The inspected pm-context deadline rendering, pm-ops lifecycle policy and pm-review sources do not implement standing-memory truth validity or renewal evidence. pm-memory already owns pins, recency, claim verification, bounded retrieval, registered fields and the shared process writer lock; this feature reuses those boundaries.

## Read-only public corpus

Source: public `unbraind/pm-memory`, `feat/semantic-recall`, commit `72636194fc18e4c79a0a253e47a3d6c60cf27f69`.

A git archive of the committed tracker was extracted into a non-git temporary directory. Files and directories were made read-only; Git was absent from PATH, and ancestor discovery was blocked. A certified complete SDK read returned **10 items**, **2 nonempty bodies**, and **133,150 UTF-8 bytes** in the complete item JSON. All **26 source file hashes** remained unchanged after validation.

The source has planning records rather than authored validity windows. `test/validate-guidance.ts` projects their real titles, descriptions, bodies and tags into in-memory guidance rows. It assigns explicitly synthetic current/expired/scheduled/content-changed windows in a deterministic rotation, freezes Date at `2026-10-21T12:00:00.000Z`, and exercises production eligibility, ranking and packet packing. It never writes the copied tracker. This validates real-text handling, not the factual correctness of policy or an existing deployment of bounded memories.

| State | Rows |
| --- | ---: |
| Current | 3 |
| Expired | 3 |
| Scheduled | 2 |
| Needs renewal | 2 |

| Policy | Eligible | Emitted | Budget omissions | Estimated tokens, max JSON/TOON |
| --- | ---: | ---: | ---: | ---: |
| exclude | 3 | 3 | 0 | 209 |
| label | 10 | 10 | 0 | 800 |

All excluded-policy results were current; label policy retained every state and both bounds. Both complete packets fit the declared 800-token budget.

Reproduce against a read-only extracted tracker with `node test/validate-guidance.ts <tracker-directory>`. The separate `test/guidance.test.ts` regressions exercise actual SDK mutations, independent processes, native history, frozen boundary instants, semantic expiry and real CLI JSON/TOON output in non-git trackers with no Git executable. The fixture's assigned windows are not written into source records.

## Boundaries

Renewal is an attributable assertion with evidence, not automatic proof of truth. Native history retains prior windows; the latest serialized revision wins. Direct tracker writers bypass the package lock. Portable export refuses active bounded guidance because the existing harness formats cannot preserve its metadata; follow-up `pm-memory-1363` tracks a safe round-trip contract. Applying consolidation merges involving bounded guidance also refuses before writes, preventing expired content from becoming unbounded advice. Hosted Postgres/MCP deployment is not established by file-backend validation.


## CI release evidence

Implementation commit `a410421a48bce2116027bf663ab9447f745a0a60` passed [CI run 39684481942](https://github.com/unbraind/pm-memory/actions/runs/39684481942).

| Gate context | Suite passed | Failed / skipped | Coverage sources | Statements / branches / functions / lines | Packed install acceptance |
| --- | ---: | --- | ---: | --- | ---: |
| npm release steps, Node 22 | 207 | 0 / 0 | 23 | 100 / 100 / 100 / 100 | 2 passed |
| npm release steps, Node 26 | 207 | 0 / 0 | 23 | 100 / 100 / 100 / 100 | 2 passed |
| `bun run release:check`, Node 26 | 207 | 0 / 0 | 23 | 100 / 100 / 100 / 100 | 2 passed |

The npm workflow executes the release script's constituent gates, including identity, typecheck, lint, zero duplication, build, docstrings, coverage, production audit, package contents, changelog, publish attestation and packed npm/Bun acceptance. The Bun job invokes the full release script. Thresholds and source scope are unchanged. Full gates ran in CI because the shared host was saturated. The final PR head receives another CI run after committing this tracker/evidence receipt; that exact-head run is linked in the PR body.

Local commands: `npm run typecheck`, `npm run lint`, `npm run duplication`, `npm run docstring`, `npm run changelog:check`; combined `node --test test/guidance.test.ts test/commands.test.ts` passed 10 before adding the consolidation safeguard; its additional targeted regression passed 1. `pm test pm-memory-wvy5 --run --progress` passed the then-current 6 validity regressions. All 7 current feature regressions are included in each 207-test CI suite. Targeted c8 measurement covered the new guidance module at 100/100/100/100. Behavioral removal of eligibility, renewal persistence and consolidation preflight each caused one intended regression failure; all changes were restored.

No completed automated reviewer approval was available: skipped, quota-limited and neutral results are not approval. The PR remains ready for review and dependent on #5. The tracker item remains in progress for orchestrator verification; no PR merge or release was performed.


Final SDK review also bound the retrieval description to renewal evidence. A native description edit now excludes the guidance until renewed. Its targeted regression passed; reverting only the digest to omit description caused one expected failure, then the fix was restored. Typecheck, lint and zero duplication passed again. The earlier full CI table identifies its exact implementation commit; the final PR-head CI link accounts for this additional correction.
