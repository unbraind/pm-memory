# Consent-scoped view validation

Public source: `unbraind/pm-memory`, `origin/main` at
`9638bd74a2b21e05782c3dec1a505ab0a7c0a4fb`.
Only its committed `.agents/pm` tracker was archived into a plain temporary
directory. All source files and directories were made read-only. A certified
complete SDK read supplied public item titles and descriptions to the
[validation helper](../examples/validate-consent.ts); all derived memory writes
used a separate initialized temporary tracker with no Git repository.
No hosted tracker, credentials or private source material was read.

Measured on 2026-10-23:

| Measure | Result |
| --- | ---: |
| Public tracker items read completely | 13 |
| Derived scratch memories | 13 |
| Explicit title-only source grants | 13 |
| Sources emitted before withdrawal | 13 |
| Eligible sources omitted by budget | 0 |
| Sources withdrawn | 13 |
| Sources emitted in a fresh packet after withdrawal | 0 |
| Prior output references returned by withdrawal | 13 |
| Affected source IDs reported for the prior packet | 13 |
| Unapproved content fields in emitted rows | 0 |
| Source-text fields in the manifest | 0 |
| Full packet tokens before / after withdrawal | 908 / 53 |
| Declared packet budget | 1500 |

A durable byte snapshot of the read-only source was identical before and after
the run. The 13 output references refer to the same packet through 13 source
ledgers; they are not 13 distinct packets. Counts measure authorization and
field minimization, not relevance quality, model performance or fleet scale.

To reproduce, archive the public revision's tracker into a non-git temporary
directory, make that copy read-only, initialize a separate scratch tracker using
`PmClient.init`, then call `validatePublicConsent(publicTracker, scratchOptions)`.
Compare source bytes before and after. The helper grants only `title`, emits a
1500-token view, withdraws every derived source, and rechecks both fresh recall
and the previous packet's text-free provenance. Retain only the measured counts.

Local focused commands:

```bash
npm run typecheck
npm run lint
npm run docstring
npm run duplication
node --test --test-concurrency=1 test/consent.test.ts
node --test --test-concurrency=1 --test-name-pattern='child launcher|bounded cache' test/semantic.test.ts
```

The repository's unchanged CI release gates provide the full source coverage,
packed npm/Bun acceptance, dependency audit and changelog evidence. Their exact
run and counts are recorded in the PR and linked pm item.
