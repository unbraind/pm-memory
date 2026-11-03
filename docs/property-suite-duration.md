# Property-suite duration evidence (2026-11-03)

Task: `pm-memory-smuq`. All eight property budgets remain 500 seeds: model,
owned fields, grammar, fidelity, complete documents, and the three ownership laws.
The model still performs 22,933 SDK-read checks. No production implementation,
coverage threshold, seed, assertion, runtime gate or timeout was removed or relaxed.

## Direct one-sequence profile

The same sequence coordinate (0, including its original initialization and all
assertions) was measured before and after, alternating variants on one busy host.
Node 26.13.0 and SDK 2026.10.28 were used. These are profiling observations, not
full-suite durations. The parent prepares schema once; its one-time cost is not
charged to every worker. Temporary instrumentation was removed after measurement.

Seconds, before -> after:

| Property | Whole worker | SDK tracker init | Schema registration | SDK dispatches | Import calls | Export calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Model | 27.03 -> 33.67 | 0.85 -> 1.28 | 3.97 -> 0.33 | 14.16 -> 14.98 | 20.33 -> 28.30 | 1.15 -> 1.87 |
| Owned fields | 15.09 -> 13.61 | 0.79 -> 0.35 | 4.79 -> 0.15 | 8.58 -> 5.00 | 4.76 -> 8.68 | 1.58 -> 1.38 |
| Grammar | 12.76 -> 7.01 | 0.90 -> 0.36 | 3.83 -> 0.16 | 7.53 -> 3.07 | 8.51 -> 5.14 | 0.42 -> 0.38 |
| Fidelity | 15.29 -> 12.01 | 0.87 -> 0.67 | 5.68 -> 0.19 | 10.43 -> 6.42 | 12.87 -> 10.63 | 0.14 -> 0.23 |
| Complete documents | 11.05 -> 4.31 | 0.53 -> 0.21 | 3.42 -> 0.03 | 6.88 -> 1.54 | 9.46 -> 3.26 | 0.47 -> 0.45 |
| Ownership locality | 7.49 -> 3.69 | 0.28 -> 0.00 | 3.05 -> 0.10 | 5.47 -> 2.06 | 1.32 -> 0.62 | 0.26 -> 0.24 |

These are inclusive, overlapping boundaries: schema work includes SDK calls;
imports include SDK and filesystem work. They must not be added together.
Tracker initialization is distinct from schema registration and fixture copying.
There are no spawned pm CLI calls in these sequences; the SDK runs in process.

| Property | Async filesystem service seconds (before -> after) | Assertion milliseconds (before -> after) | Memory-field registration writes (before -> after) |
| --- | ---: | ---: | ---: |
| Model | 25.43 -> 36.99 | 4.52 -> 4.36 | 50 -> 0 |
| Owned fields | 13.27 -> 13.13 | 0.25 -> 0.64 | 25 -> 0 |
| Grammar | 10.58 -> 6.12 | 0.57 -> 0.56 | 50 -> 0 |
| Fidelity | 12.55 -> 12.20 | 0.34 -> 0.36 | 75 -> 0 |
| Complete documents | 10.25 -> 3.68 | 0.55 -> 0.35 | 25 -> 0 |
| Ownership locality | 6.34 -> 2.84 | 0.25 -> 1.17 | 25 -> 0 |

Filesystem service time sums asynchronous requests, excluding the enclosing copy
operation to avoid counting its nested filesystem requests twice. Concurrent
requests overlap, so service time can exceed wall time. It includes SDK storage,
fixture copies, filesystem assertions and cleanup, rather than being an additional
independent wall-time bucket. Locality also keeps its native_hint registration.

The dominant cost is real SDK/filesystem import work, not assertions. For example,
the original model sequence used about 60,000 asynchronous filesystem operations;
its import calls consumed 20.33 of 27.03 wall seconds. Assertions took 4.52 ms.
Repeated memory-schema creation was an avoidable 3.97 seconds in that profile.
The model's after wall time regressed in this pair despite eliminating those 50
writes; the loaded host does not establish a universal per-sequence speedup.

Two earlier alternating five-seed trials of schema sharing alone took model
53.02/66.19 seconds before and 57.79/74.90 seconds after, and owned fields
20.23/25.63 seconds before and 19.28/19.12 seconds after. This is why schema sharing
alone was rejected as sufficient evidence for the overall duration target.
An original Node 22.23.4 five-seed model batch with V8 coverage took 246.82 seconds
and passed all six tests, demonstrating why uninstrumented timings cannot certify
Node 22 CI duration.

## Changes and equivalence

- Prepare native SDK schema once per parent property suite, then copy it into
  separately owned directories. The field declarations are unchanged. For model,
  100 batches previously registered 50 fields each (including fresh branches);
  now the parent registers 25 fields once. All native read-back assertions remain.
- Remove the template namespace before any clone. Each logical tracker allocates
  its own immutable origin. Fresh model targets have prepared schema, no items,
  and no inherited namespace; all original crash/recovery coordinates still run.
- Let a pool use up to four available cores. Atomic slots shared by sibling test
  files bound their combined property-worker count, allowing an otherwise idle
  core to serve a long remaining test. Existing batch sizes remain five or 25.
- Fence git discovery in owned-field workers, matching the other SDK-only laws.
- Give every child a parent-owned temporary directory, and await process closure
  before releasing its slot or removing its files. Cleanup runs on success,
  assertion failure, spawn failure and test cancellation.

No read-back assertion was replaced with an assumed or cached result. Shared-memory
storage and an alternative V8 coverage mode were evaluated and rejected. Normal
V8/c8 coverage collection, all four 100% thresholds and zero duplication remain.

## Seed and safety guards

`test/property-seeds.ts` independently declares the exact seed list using the
unchanged masters and generators. Workers record a coordinate and seed only after
the sequence completes. The parent validates each actual receipt and then requires
all 500 unique, correctly valued coordinates. Every successful suite prints its
complete `PROPERTY_SEEDS` JSON list into the test log.

Eight tests prove omissions, duplicate coordinates and changed seeds are refused.
An independent mutation invocation dropping model coordinate 237 exited 1 with
`MODEL: completed seed count` and `499 !== 500`. Two process tests observe the
shared core bound and verify that child temporary directories disappear after
both success and deliberate failure. CI workflow tests also exercise successful,
failed, canceled and skipped upstream gate results.

## CI scheduling and estimate

CI keeps the exact three full release-gate executions: npm with Node 22, npm with
Node 26, and the Bun gate with Node 26. They now occupy separate matrix jobs.
The existing `test (22)` and `test (26)` required-check names are retained as
always-run aggregators; either refuses any non-success matrix result, including
Bun failure or cancellation. No partial suite or reduced coverage report can
satisfy them. See the [GitHub matrix documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymatrixinclude).

The supplied Node 26 run spent about 65 minutes in one test phase and ran both
release gates in a 137-minute job. Splitting those complete gates removes the
doubled job duration independently of any microbenchmark speedup. Planning estimate:
60-75 minutes for each Node 26 runtime job, and 80-90 minutes for Node 22 if the
shared four-core budget removes the long two-worker tail. The Node 22 estimate is
lower confidence: local load and the incomplete original run prevent a certified
bound. The next PR's actual CI durations must confirm the 90-minute target;
this change does not claim that confirmation or wait for CI.

## Final validation

The full local npm release gate passed (exit 0) with 679 tests and 4,000 actual
seeded sequences. The serial local Bun gate did not finish: its run hit the
agent's six-hour limit while still passing tests, so its result and every
per-test duration are pending this PR's CI. Each complete gate requires
4,000 actual seeded sequences (500 in each of eight suites), with their full seed
lists in diagnostics. The recorded local runs were started by an external precheck
that stopped below 20 GB of free disk space on the shared host; `release:check`
itself does not check disk space.
