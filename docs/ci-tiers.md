# Fleet CI v2

Required checks remain `test (22)`, `test (26)` and `codeql`. PR checks run on
GitHub-hosted Ubuntu, cancel superseded PR runs, and have 30-minute job limits.
The CI workflow runs on PRs and dispatch, with no push trigger. Docs/tracker-only
PRs run npm installation, strict tracker health and changelog consistency in both
Node jobs. CodeQL is required by branch protection, so its PR/push triggers have
no path exclusions; skipping that workflow would block docs-only PRs.

| Check / contract | PR Node 22 | PR Node 26 | Docs/tracker-only | Deep Node 22/26 × npm/Bun |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers | yes | yes | both | all four |
| Strict pm health / required merge drivers | yes | yes | both | all four |
| Build and test suite | quick | quick via coverage | — | full |
| Commit identity / private-path policy | — | release gate | — | release gate |
| Typecheck and lint | — | release gate | — | release gate |
| Duplication / docstring gates | — | release gate | — | release gate |
| Coverage: 100% statements, branches, functions, lines | — | quick, unchanged scope | — | full, unchanged scope |
| Production dependency audit | — | release gate | — | release gate |
| Pack dry-run / shipped file contracts | — | release gate | — | release gate |
| Changelog consistency | — | release gate | both | release gate |
| Publish attestation verifier | — | release gate | — | release gate |
| Packed npm/npx and Bun/bunx consumer acceptance | — | test:install via gate | — | test:install via gate |
| Bun package graph installation | — | smoke | — | Bun legs |
| CodeQL | separate required workflow | separate required workflow | still runs | main pushes / weekly schedule |

Deep checks have distinct names, `deep (22, npm)`, `deep (22, bun)`,
`deep (26, npm)` and `deep (26, bun)`. Each runs one complete release gate;
this restores Node 22 Bun in addition to the three legs on the previous main.
They run on main pushes, dispatch and daily at 02:53 UTC, separate from release
at 03:23 UTC and weekly CodeQL at 01:47 UTC on Monday. Each has a 120-minute
limit, `PM_TEST_DEPTH=full`, `PM_TEST_TIME_SCALE=3`, and cancellation per ref.
Runner routing uses the fleet's `PM_LOCAL_DEEP` expression: self-hosted `pm-local`
unless the controller sets the variable to `off`, then hosted Ubuntu. Busy local
slots queue. Repository variables and branch protection are unchanged.

`PM_TEST_DEPTH=quick` runs the same deterministic seed prefix at one tenth depth,
with a floor of 25 capped by the original count. The eight SDK model/ownership
suites run 50 rather than 500 completed sequences. Seeded forward-boundary schedules, source normalization/scalar
properties and randomized consolidation use the same rule. Full, unset and
unknown values retain full depth. The independent full seed manifest and its
missing/duplicate/changed-seed guards remain exhaustive in both tiers. Worker
receipts prove the selected complete prefix; seed formulas, batch sizes and
per-sequence assertions are unchanged. Fixed input-size contracts, including the
220-source aggregate round trip, remain complete. The quoted-scanner corpus
uses 52 of 512 enumerated seeds in quick mode, and packet-budget properties
use 30 of 300 generated sets. The scanner has a separately frozen prefix
digest verified against the unchanged full-corpus digest. Coverage thresholds
and source inventory never vary by depth.

The packed-documentation contract lives in `test/shipped-files.acceptance.ts`
and runs through `test:install`, keeping the Node 22 PR leg free of pack commands.

Packed acceptance already installs the captured archive with both npm and Bun,
then executes the installed host through npx and `bunx --bun --no-install` and
runs SDK/CLI round trips. It proves project installs and installed-bin execution;
it does not claim global or network-ephemeral bunx installation. The PR gate
retains this proof once and adds `bun install --no-save` as a package-graph smoke.

## Test lifecycle and slow hardware

Issue #75 failed while removing the diagnostic fixture's `.pm-cli/locks`.
The pinned CLI can spawn detached telemetry flushers. Diagnostic child commands
previously replaced the environment, losing Node test-context suppression;
other children deliberately cleared that context to run nested tests. Child
environments now explicitly disable telemetry and OTel while preserving coverage.
A controlled real-CLI spawn probe proves the isolated environment starts no
flusher and its unsuppressed positive control dispatches one. Owned native peer children are awaited through process/stdio closure before
fixture deletion, with bounded SIGKILL escalation; a controlled child creates
lock files during delayed shutdown to prove the root cannot be recreated. Fixture removal
retries transient directory races with a bounded retry budget and still throws
on persistent cleanup failure. Diagnostic assertions remain intact.

Node's `--test-timeout` alone does not kill an idle file after its final passing
test. An unreferenced per-file watchdog thread now kills the file with failure if it stays
alive (including teardown or a blocked JavaScript event loop). Normal test files exit naturally; successful results
are never forced. The default watchdog is ten minutes in quick mode and thirty
minutes in full mode, multiplied by the slow-host scale; deep therefore permits
ninety minutes per file within its 120-minute job. Model workers load the same
watchdog. Regressions deliberately leave an interval alive or block the JavaScript loop
after a passing test and require nonzero exit. `PM_TEST_FILE_TIMEOUT_MS` is an explicit diagnostic
override used by that controlled fixture. Finite seeded corpora terminate by operation budgets; their old machine-speed
timeouts are replaced by the file watchdog.
Privacy scanner and dead-owner recovery latency bounds, child deadlines and
worker startup waits scale with positive `PM_TEST_TIME_SCALE` (default one).

The canceled hosted run 43616440465 still had coverage/model child processes
when canceled; its last emitted result was test 346, not a final suite summary.
Logs alone do not establish that this run had finished all tests or identify an
idle handle. The watchdog prevents an unbounded wait either way. Do not confuse
that observation with the separately demonstrated detached telemetry writer.

## Measurements

Baseline successful main run [43627397337](https://github.com/unbraind/pm-memory/actions/runs/43627397337)
spent 182m51s in the Node 22 npm gate, 56m33s in Node 26 npm, and 41m08s in
Node 26 Bun. Node 26's slowest measured tests were the 500-sequence model
(1302.75s), forward-only update boundary sweep (544.59s), owned-state sequences
(441.94s), 220-source round trip (395.36s), and grammar law (365.66s).
The baseline full coverage suite itself took 53m28.84s (893 tests), already
beyond the roughly 45-minute local full-depth budget. These are gate-step/test
durations, separate from queue-inclusive PR job time.
Local and hosted measurements for this change are recorded in the linked Task
and PR after validation.

Workflow timeout and cancellation semantics follow the
[GitHub Actions workflow syntax reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

Tracking: [pm-memory-higm](https://github.com/unbraind/pm-memory/blob/main/.agents/pm/tasks/pm-memory-higm.toon),
companion `pm-cli-website-dyhg`.
