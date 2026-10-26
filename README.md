# pm-memory

Agents manage their own memory. Project management is context management: facts, feedback, standing preferences and references belong in shared, typed pm items instead of isolated harness files. A Knowledge item written by one agent is available through the same tracker to people, other agents, pm-web, MCP and pm-gpt. This package uses the pm SDK; a host must load the extension to expose its commands. Hosted deployment is outside this package's acceptance evidence.

This is an unreleased package under local review. Publication and scheduled releases remain held until the maintainer approves.

## Install

After publication, choose your usual package manager:

```sh
pm package install pm-memory

npm install --save-dev @unbrained/pm-cli@2026.10.23 pm-memory
npx pm package install pm-memory

bun add --dev @unbrained/pm-cli@2026.10.23 pm-memory
bunx --bun pm package install pm-memory

npx --package=@unbrained/pm-cli pm package install pm-memory
bunx --bun --package @unbrained/pm-cli pm package install pm-memory
```

Initialize a tracker first with `pm init`. For a nested project, set `PM_PATH` explicitly to its own `.agents/pm`. All SDK calls require an explicit initialized tracker directory; they never discover an ancestor. The peer host minimum and pinned development host are 2026.10.23. Node 22.18 or later is required.


## Consent-scoped recall views

Use `memory grant`, `view`, `withdraw` and `manifest` when recall requires explicit
source consent for a declared purpose. The caller must be authorized to grant
consent for that source. Purpose identifiers are opaque lowercase identifiers,
1–64 letters, digits or hyphens; avoid personal names or source text in them.
Every source starts unauthorized for views, including existing memories.

```bash
pm memory remember "Run both release gates" --kind project --slug release-policy
pm memory grant release-policy --purpose release-review --fields title,body
pm memory view release --purpose release-review --fields title --budget 800
pm memory withdraw release-policy --purpose release-review
pm memory manifest <packet>
```

`grant` authorizes the current semantic revision and source provenance for one
purpose. `view` requires an explicit subset of `title,description,body,why,how`;
missing consent, withdrawn consent, changed source content, insufficient fields
and noncurrent standing guidance exclude the source. It ranks using only the
requested content fields, and emits complete selected fields within the entire
JSON/TOON token budget. A large highest-ranked row can leave the packet empty;
request fewer fields or increase the budget. `excluded` counts ineligible active
sources; `omitted` counts eligible sources that did not fit. No embeddings or
external providers are invoked on this path.

The SDK exports `grantConsent`, `createView`, `withdrawConsent`, `inspectView`,
`ViewOptions`, `ViewPacket`, `ViewManifest`, `ViewField` and `ConsentLedger`.
See [the typed lifecycle example](examples/consent-scoped-views.ts) and
[public-copy validation helper](examples/validate-consent.ts). All operations
reuse the complete native SDK read, schema, mutation/history and shared writer
lock boundaries. Refusals are `MemoryError` instances with `code` and `remedy`;
the CLI emits the same safe remedy and exits 2 for invalid consent or manifests.
The normal host selects compact TOON or `--json`; `estimated_tokens` includes
both the minimized rows and the full manifest in either format.

Each nonempty packet records text-free lineage on its source items: random
packet ID, purpose ID, consent revision and disclosed field names. The returned
manifest also names native source IDs. It retains no source title, slug, query,
excerpt or original bytes. Withdrawal returns affected packet IDs; `manifest`
reports affected source IDs after withdrawal, regrant, source edits or archive.
Old outputs remain affected after a regrant. Empty packets have a portable empty
manifest but no retained source record, so `manifest` refuses them. Keep portable
manifests for reconciliation if sources are later deleted; hard deletion also
removes their local lineage. Previously delivered content cannot be recalled
from a consumer: consumers must discard affected outputs when consent changes.

Once a source has consent metadata, ordinary `recall` (lexical or semantic) and
`index` exclude it, even after withdrawal or malformed metadata. Native `get`
and tracker reads remain administrative access to the retained source; consent
withdrawal does not erase the source or its append-only history. Portable export
refuses active consent-managed sources because harness formats cannot preserve
the policy. Consolidation refuses merges involving them, preserving identities
and preventing text from moving into an unscoped source. Existing input privacy
checks still apply independently. This feature authorizes long-term-memory
recall; pm-brief continues to own disclosure rendering.

### Without git

Consent grants, minimized views, withdrawals and manifest inspection work in a
plain initialized tracker without Git or a Git executable on `PATH`. These
operations need no repository. Repository-related workflows in the pm host,
such as GitHub synchronization, still need their own Git prerequisites.

## Commands

Every command returns native host TOON by default and accepts `--json`. Expected refusals include a typed category and a remedy. Source export writes files and returns a small receipt.

| Command | Example | Result |
| --- | --- | --- |
| remember | `pm memory remember "Run the build before review" --kind project --slug build --why "Catch regressions" --how "Run npm test" --pin` | Create Knowledge or revise an exact slug |
| recall | `pm memory recall "release workflow" --budget 800 --kind project` | Compact ranked rows, then excerpts; counts emitted memories |
| observe | `pm memory observe build --recall <receipt> --task task-id --feedback helpful --outcome improved --attribution isolated --evidence "Same gate and fixture; fewer failures"` | Immutable explicit feedback linked to recalled content and a native task |
| utility | `pm memory utility build` | Compact lifetime/current-content counts, including excluded evidence |
| get | `pm memory get build` | Full selected memory, including its complete body |
| index | `pm memory index --budget 1500` | MEMORY.md-style markdown in `text`, ending with an omission receipt |
| import | `pm memory import ./memory-copy --from claude-code` | Idempotent import; native links from `[[slug]]` |
| export | `pm memory export ./memory-output --to claude-code` | Exact imported bytes or generated portable files |
| verify | `pm memory verify --slug build --root .` | Evidence verdict, timestamp and failing claims |
| consolidate | `pm memory consolidate` | Read-only duplicate, supersession and archive proposals |

`remember` requires `--kind user|feedback|project|reference`. Omit `--slug` for a stable content-derived key. An exact slug updates the same item and appends native history. Use `--update build` to require that the key already exists. Near duplicates at or above 0.82 normalized title-plus-body token Jaccard similarity refuse with the existing key and two remedies: `--update <slug>` or `--force-new --slug <distinct-key>`. `--why`, `--how`, `--pin` and repeatable `--link` add retrieval context and relationships. SDK clients may also supply tags.

The privacy gate examines facts, rationale, application instructions, tags and imported source bytes before mutations. It refuses recognizable API/token prefixes, JWTs, private keys, password/key/secret assignments, authenticated URLs and credential-shaped token assignments. Variable references and short plain `token:` accounting prose are references rather than literal credentials. Emails require explicit `--allow-email`, also supported by import. Import reports every offending relative file and line together with its matched class before writing anything; edit the listed files or permit email explicitly. This heuristic is an input guard, not a proof that arbitrary prose contains no private information. Do not store credentials in memory.

Recall defaults to 800 estimated tokens; index defaults to 1500. The entire packet, including the estimated-token field and omission receipt, is measured in both pretty JSON and native TOON with the host's UTF-8 byte estimator. An impossibly small budget refuses before counter writes. Recall packs compact rows first (slug, kind, pinned, description, score), in rank order; it then spends spare space on query-centered excerpts. A top result is never replaced by a smaller lower-ranked result. At 200 tokens a maximum-length slug retains its top row with the recall receipt; smaller budgets may refuse. Truncated excerpts carry an explicit marker pointing to `pm memory get <slug>`. Index entries may be omitted when oversized. All truncation is Unicode-safe. An index orders pinned guidance first, then kind, then recency.

Import supports `--from claude-code|agents-md|cursor`, directories or individual regular UTF-8 files. Claude Code frontmatter recognizes `name`, `description`, `metadata.type` and legacy top-level `type`; optional `**Why:**` and `**How to apply:**` lines become fields. Unknown memory kinds and malformed YAML refuse. Plain unquoted `name`/`description` values containing a colon are accepted without altering their original bytes. A valid frontmatter `name` is the canonical kebab-case key. The original file stem remains a link alias; canonical names take precedence, and ambiguous aliases stay unresolved. Frontmatter descriptions populate the native description field and participate in ranking and compact recall. Claude Code MEMORY.md indexes are retained as export artifacts and excluded from retrieval. Import deliberately retains source duplicates for review instead of discarding source files. Re-importing unchanged bytes and links performs no durable writes. Source revisions preserve native lifecycle, verification, utility and other native-only metadata, including archived status. Independently revised items refuse source replacement.

Export supports `--to claude-code|agents-md`. Unchanged imported facts of the same harness whose wiki references still resolve retain byte-identical content, frontmatter, BOM, line endings, ordering and final newline. Recall and verification metadata do not invalidate that preservation. If an index, body or wiki reference would need regeneration, export uses the policy format and raw SDK bodies instead. This prevents generated projections from becoming native edits on re-import. A complete current legacy index and all unchanged files retain their original bytes. Omitted references are reported without granting deletion authority. Destination symlinks, user-owned ancestor symlinks, unsafe relative names and conflicting destination files refuse; POSIX root-owned system links are allowed in ancestors; identical existing files are accepted. Use a dedicated empty output directory. Export plans before creating directories, writes to a sibling temporary directory, then publishes with one rename. Failed staging is removed. The destination must be absent, empty or already contain identical output. Export creates missing destination parents after preflight.

Verification extracts delimited paths, `fn()` calls, `--flags`, exact `package@version` claims and HTTP(S) URLs. Repeat `--root` to search multiple trees, including nested Git repositories: `pm memory verify --root . --root ../shared`. The bounded inventory includes hidden files and ignores Git ignore rules while excluding node_modules, .git, dist and coverage at every depth. Tracker file names remain resolvable for explicit path-existence claims; tracker contents never count as symbol or flag evidence. A bare basename, or a relative path whose suffix matches an indexed path, resolves under a root. A requested relative path that is missing stays unknown when only a different path shares its basename (`basename found elsewhere: <relative match>`); that match does not verify it. Known runtime globals are skipped. Absolute paths outside home, unmatched home references, excluded-tree and escaping paths remain unknown, as do symlink escapes. Home-relative and home-absolute paths can resolve when their portable suffix matches an indexed path under a declared root. Flags check the SDK command registry and source text; a flag absent from both has unknown context and is never stale. Absent symbols are stale only with explicit source-file context. Every stale claim includes an absence reason with the path or number of files searched. A bounded search failure remains unknown or refuses rather than claiming absence.

`--network` enables `npm view` version checks and URL HEAD checks. Without it, network claims remain unknown. One confidently absent claim makes a memory stale; all claims must verify for a verified verdict; no claims or incomplete evidence yields unknown. Textual presence does not establish runtime correctness. Network outages and denied endpoints remain unknown. Verification reports changed or archived snapshots in `skipped` without overwriting their verdicts.

Consolidation changes nothing without `--apply`. Applied duplicate merges retain old content in the surviving item, link the originals and cancel the duplicate with a reason. Supersession recognizes overlapping headings/slug tokens with explicit opposite guidance (`enable/disable`, `always/never`, `required/forbidden`); it normalizes toggle negations and requires exclusive opposing signals with matching subjects. Always/never requires the same remaining guidance. It adds a native `supersedes` edge and a comment. It is a lexical proposal, so review the dry run before applying. Archive proposals require stale status with a persisted confident reason, zero recalls, no pin, and `memory_changed_at` content age of at least 30 days. Use `--min-age-days 60` to change the threshold. Recall and verify leave content age unchanged. Legacy memories fall back to creation time. Merge targets remain active; durable merge receipts let retries finish without appending content twice. All original items and history remain available.

## Outcome-linked utility

Recall now returns a `recall` receipt, counted within its token budget. Each emitted memory retains that receipt, its content hash and exposure time in native audited metadata. Counter-only legacy recalls remain visible as `legacy_exposures`; they cannot receive retrospective feedback without a receipt. Receipts are not proof that the agent used the guidance.

After assessing a task, record **explicit** `helpful` or `unhelpful` feedback with `observe`. Supply the receipt, native task ID, outcome (`improved`, `unchanged`, `worsened`, `unknown`), attribution (`isolated`, `confounded`, `unknown`) and 1-1000 characters of evidence describing the baseline and any confounders. A task contributes once per memory, even across different recalls and content revisions. Identical retries return `recorded: false` without history writes; conflicting retries refuse with a remedy. Keep corrections or contrary evidence in the task's audited comments rather than inventing another task to inflate the sample. Record the observation once the assessment is ready: observations are immutable, including unknown outcomes.

Only isolated, known outcomes on a native terminal task with an explicit `completed_at` (or legacy `closed_at`) at or after recall and no later than observation are scored. An `updated_at` fallback never proves later completion. Confounded evidence is always unscored, regardless of helpfulness or claimed improvement. Unknown evidence and unfinished/pre-recall outcomes also stay unscored. The native lifecycle snapshot is retained at observation time; reopening a task later does not rewrite that historical assessment. Attribution and outcome direction are caller judgments, not an automated causal experiment.

`utility <slug>` reports one selected memory, including archived guidance. `recalls` is the lifetime native exposure denominator. `legacy_exposures` plus `lifetime.exposures` reconciles to that total. Each cohort includes observed/unobserved exposure counts, unique-task observations, helpful/unhelpful counts, complete attribution/outcome partitions, scored counts, disjoint unscored reasons, and scored outcome counts grouped by feedback. `observations` is the denominator for helpfulness and exclusion counts; each `by_feedback` row supplies its own `scored` denominator for outcome direction. Several tasks may assess one exposure, so task and exposure denominators differ. Confounded takes precedence over unknown, then unproven later completion, when assigning an exclusion reason. No percentages are fabricated for an empty cohort.

The `current` cohort selects only exposures of the exact current guidance hash; lifetime counts retain earlier versions. Neither report omits unobserved exposures nor promotes old feedback into a revised memory's score. `utility` makes no durable writes. Feedback never changes ranking, trains a policy, cancels, consolidates or deletes memories. Evidence remains on its original memory through consolidation; it is not transferred to a merged survivor. Native item history contains the individual receipt and observation records for audit; the compact report deliberately returns aggregates.

```ts
import { recall, observe, utility } from 'pm-memory';

const context = await recall('release checks', options);
// Apply the guidance, complete the native task, and compare with a stated baseline.
await observe('build', {
  ...options, recall: context.recall!, task: completedTaskId,
  feedback: 'helpful', outcome: 'improved', attribution: 'isolated',
  evidence: 'Same fixture and release gate; fewer failures after applying the checklist',
});
const evidence = await utility('build', options);
// Compare evidence.current.by_feedback.helpful.improved with its scored denominator.
```

[The public-tracker replay example](examples/outcome-utility.ts) copies an extracted public tracker into a disposable non-git directory, fingerprints the source before/after, and applies clearly labeled scripted annotations to six real historical tasks. It verifies idempotent retries and reports zero scored outcomes because those tasks predate recall or are confounded. Run `node examples/outcome-utility.ts <read-only-public-tracker-directory>`. This exercises real tracker data and refuses to claim measured task improvement from retrospective annotations.

## Harness usage

Claude Code can import and export its memory directory. Codex and pi can import AGENTS.md sections as files and consume recall/index directly. Cursor can import its rules directory. Commands always use the selected tracker, so shared visibility follows the host's tracker access and extension configuration.

Add this guidance to AGENTS.md (or the harness's equivalent instructions):

```md
## Long-term memory

At session start, run `pm memory index --budget 1500`, then
`pm memory recall "<current task>" --budget 800`.
Use `pm memory get <slug>` to read full context, then read linked pm items.
After learning a durable fact, use `pm memory remember "<fact>" --kind project`
with a stable slug, rationale and application guidance. Update existing slugs.
Never store credentials. Review `pm memory verify --root .` and
`pm memory consolidate` periodically; review proposals before applying them.
```

For a local Markdown artifact, extract the SDK packet's `text` field. CLI output remains a structured host receipt rather than writing an untracked MEMORY.md into the repository automatically.

## Time-bounded standing guidance

A pin gives standing guidance ranking priority. An explicit validity window additionally records when the **current content** is supported. Existing memories without windows keep their previous behavior. This is truth validity, independent of task deadlines, content recency and the `verified`/`stale`/`unknown` claim verdict.

```sh
pm memory remember "Run both release gates" --kind project --slug release-policy --pin
pm memory renew release-policy --valid-from 2026-10-21T00:00:00.000Z --valid-until 2026-11-21T00:00:00.000Z --evidence "Public release checklist reviewed and approved"
pm memory recall "release workflow" --budget 800
pm memory recall "release workflow" --validity label --budget 800 --json
pm memory index --validity label
```

Use canonical UTC timestamps with milliseconds. Start is inclusive; end is exclusive. Recall and index default to `--validity exclude`: scheduled, expired and content-changed guidance is excluded even when pinned. `--validity label` explicitly includes it for auditing, carrying `current`, `scheduled`, `expired` or `needs-renewal` plus both bounds. Labels and bounds are included in JSON/TOON token accounting. Label mode returns advice that may no longer apply; agents must honor its status. Semantic recall checks eligibility again after embedding before emitting rows. `get` returns the complete latest window and evidence; SDK callers can evaluate it with `guidanceState(memory, Date.now())`.

Renewals require an existing active pinned memory, explicit bounds and nonblank evidence; privacy checks reject credential-shaped evidence. Each successful renewal increments a revision under the shared process lock and writes the whole window in one native mutation. Earlier evidence remains in append-only native item history, including competing renewals. The last serialized renewal is current; it may deliberately shorten a window. A window describes the latest authored policy, not a historical reconstruction query. A failed native mutation retains its normal SDK refusal and retry contract.

The evidence digest covers title, description, body, kind, rationale, application instructions and tags. Changed content or removal of the pin yields `needs-renewal` until reviewed again. Recall counters and claim verification never renew validity, reset its bounds or refresh content recency. Evidence records an author's assertion; the package does not automatically establish that it is true. Direct tracker writers do not participate in the package lock.

```ts
import { renew, recall, get, guidanceState } from 'pm-memory';

await renew('release-policy', {
  workspace: '.agents/pm', author: 'release-agent',
  from: '2026-10-21T00:00:00.000Z', until: '2026-11-21T00:00:00.000Z',
  evidence: 'Public release checklist reviewed and approved',
});
const current = await recall('release workflow', { workspace: '.agents/pm', budget: 800 });
const audit = await recall('release workflow', { workspace: '.agents/pm', validity: 'label' });
const state = guidanceState(await get('release-policy', { workspace: '.agents/pm' }), Date.now());
```

Invalid bounds or policy, nonstanding targets and exhausted revisions produce `MemoryError` with `code: 'validity'` and a remedy (CLI exit 2); invalid persisted windows refuse with `schema`. Portable harness exports retain the validity contract as described below. Consolidation previews remain available, but applying a merge involving bounded guidance refuses before writes: revise the intended policy and renew its evidence explicitly.

## Portable policy windows

`memory export` writes the version 1 policy format for native/portable guidance,
including entirely unbounded and empty inventories. A purely legacy imported file
inventory keeps its legacy export only when every emitted file can be preserved byte for byte. Otherwise it uses the policy format. Both `--to agents-md` and `--to claude-code` produce `pm-memory-
policy.json`, `memories/<slug>.md` body files and the harness index. Keep this directory
together. The index links to bodies and labels inclusive start/exclusive end bounds; it
never duplicates bounded text as unbounded advice. A standalone exported body or index
refuses import without its manifest.

```sh
pm memory export ./policy-copy --to agents-md
# Edit text below the policy marker in memories/release-policy.md.
pm memory import ./policy-copy --from agents-md --json
pm memory get release-policy --json
```

The exported `PortablePolicyManifest` contains an explicit format/version/harness, a
complete guidance inventory, semantic metadata, typed native relationships with portable
targets, pin state, immutable native identity and per-field baseline hashes and represented baseline edges,
an exported content snapshot hash, the latest `GuidanceWindow`, and
every renewal in revision order. Each renewal retains `from`, `until`, `recordedAt`,
`revision`, `contentHash` and `evidence` verbatim. Evidence may reference reviewed
documents or public tracker items. It remains an author's assertion. Earlier evidence is
retained in native history and the registered `memory_renewals` field after import and
re-export. Unbounded entries explicitly carry `validity: null` and an empty renewal
list.

Body markers bind their manifest policy, pin state and ownership baseline. Body edits preserve the old
evidence digest, so changed guidance becomes `needs-renewal`; import never renews it
implicitly. Changing bounds, removing evidence, skipping/reordering renewals, changing
the policy marker, missing bodies, unknown keys/versions and noncanonical timestamps
refuse with `MemoryError.code === 'validity'` and a restore/renew remedy (CLI exit 2).
Restore the original export before using `memory renew` with fresh evidence to author a
new window. Native edits win field conflicts, with a reason in the receipt; unrelated portable edits
can still apply. A newer
native renewal refuses an older import. Adjacent files outside the inventory are skipped
with reasons. These integrity checks are not signatures: import only trusted exports; a
party that rewrites both the manifest and its markers can author a different policy.

Imports validate the complete manifest, every body, privacy and existing policy ancestry
before registering fields. The SDK previews the complete item batch, then commits it
under the package writer lease using `commitItemMutations`. Each attempt binds the
input digest to a fresh UUID recorded in its checksummed intent. Allocation skips any
existing node/data/provenance/rollback journal; completed attempts start a new generation,
including after every imported memory was deleted. The intent freezes item ids and
SDK batches for crash replay. A/B/A imports therefore apply A again after B.
Interrupted batches resume on the same input only while their expected SDK revisions
and immutable history prefixes still match. Each update uses the SDK item-lock CAS
(`match` on `updated_at`); native edits or ownership
changes refuse with a typed conflict. One shared helper reads expected revisions,
guards the original read set, then applies SDK CAS in fresh, interrupted and compensated
paths. A refusal compensates applied steps before returning, and a durable SDK rollback
across all stages restores import-owned memory documents. Its item-lock mutation guard
preserves newer peer revisions and the transitive reference graph peers have adopted.
The owned intent is removed after rollback; retry needs no manual deletion. Compensation
appends audit history while restoring serialized memory documents. SDK transaction
errors are typed `MemoryError` values with remedies. New graph members are first created without edges, then the full data batch
uses SDK-read CAS revisions; even interrupted creation cannot leave dangling edges. Node rollback deletes only
transaction-owned creations. The SDK reserves deleted identities in history, so retry
allocates fresh identities and remaps edges while retaining the old audit history.
Portable ownership receipts are committed in a second recoverable SDK workspace
transaction, outside native item fields. Their field fingerprints use the SDK storage
normalizer. Immutable history identifies later native changes per field and relationship identity, so an older
manifest can still replay without adopting a native edit as portable state. No input
bookkeeping, verification, utility, unknown fields or other native-only metadata is
rewritten on existing records. An unchanged source round trip performs no item writes.
Legacy adapters share this ownership split and the same recoverable SDK batch; implicit defaults and absent wiki links grant no deletion authority. Native identity and source bookkeeping remain unchanged when portable content is revised. Raw input whitespace is never compared with stored values to classify native edits.
Export reuses original legacy bytes only when their decoded defaults reproduce every portable field, including kind, description, rationale, application, pinning and tags. A native edit to those values or the relationship graph selects the policy format, so a fresh destination retains the current guidance rather than the older legacy defaults.
Older legacy records without ownership receipts use policy output whenever stored edges or source wiki references make graph fidelity unproven.
Legacy source bookkeeping is decoded only when attempting legacy output; policy output reads current SDK semantics directly.
Unrelated tracker readers can observe staged writes until
commit or recovery completes. Schema registration is idempotent and
precedes the item batch. The lease covers the state read, planning, preview and
publication, and releases last. Direct writers outside this package must coordinate
separately. Relationship target ids are remapped to portable slugs and back, including
kinds, source references and author/time provenance; SDK edge authorship is reasserted
by its native mutation path. Import computes selective SDK additions/removals over the
represented relationship identities. An edge can be removed only if the current or a
previous portable document explicitly carried it; omitted targets remain unknown here.
Native Task, canceled, missing, artifact, foreign and otherwise unrepresented links stay
untouched. Native links added or removed after export also survive unchanged imports.
Unrelated native edge edits do not revoke authority over other portable edges. Mixed batches preview creations before updates so the SDK resolves new targets; represented legacy targets outside the input join the guarded read set. Legacy identity and provenance come from immutable creation history. A skipped target closes
transitively over every dependent row with the same reason before selecting mutations.
Unchanged compares current SDK content with incoming values through the SDK canonical
and mutation projections, including SDK-normalized dependency provenance. Saved input
bytes never establish that current content is unchanged. A
local target absent from an imported inventory refuses before writes. Exported links
to canceled, artifact or missing/non-memory targets are omitted from the portable local
graph and reported as `omitted_links: [{slug, target, kind, reason}]` in the typed export
receipt. Neither export nor re-import treats these receipts as deletion instructions. Foreign
records are excluded before decoding package metadata and reported as `skipped` entries.
Ownership and content use one certified SDK snapshot. Exports stage their complete directory and publish with
a rename; matching peer publication succeeds, differing publication refuses without
overwriting it.

The existing CLI commands return compact host TOON or `--json` counts; policy imports
also return `skipped: [{slug, reason}]`. Bodies and renewal histories are kept in files
rather than echoed in the receipt. SDK clients use `importDir`, `exportDir`,
`PortableImportOptions`, `PortableImportResult`, `PortableExportResult`, `PortableGuidance`,
`PortablePolicyManifest`, `PortableBaseline`, `PortableFields` and the pure `parsePolicy` validator. See the [typed
example](examples/portable-guidance.ts) and [public-tracker validation](docs/portable-guidance-validation.md). The state-machine property executes 500 independent seeded
sequences (master seed `0x1363cafe`) with 22,933 SDK-read state checks over both
harnesses, older-manifest replays, native body/field/relationship edits,
whitespace/CRLF, link additions/removals, repeated delete/re-import generations,
peer edits at every shared-helper recovery boundary and mixed bounded/unbounded guidance. Every
journal boundary is sampled across the model, including intent, each mutation and
the node, data and provenance commits. One hundred fresh-tracker branches include
foreign ownership arriving after a creation crash. Newer native edits after crashes, foreign ownership and restoring an
older native body are checked against the independent reference and no-dangling
invariant. Every
failing sequence prints its master seed, sequence seed, operation and step. One hundred
fresh Node workers run five sequences each, bounding Node 22 coverage bookkeeping
without reducing state coverage. The parent verifies each worker and its complete
SDK-read receipt; workers inherit coverage collection.
Three additional ownership laws each run 500 seeded sequences through both harnesses:
identity (`import(export(T))` into T changes no SDK-returned field), locality (only
explicit portable edits change), and foreign preservation (intervening native edits
survive). Their masters are `325300385`, `342209445` and `359118505`, with sequence
seed `(master + imul(index, 0x9e3779b9)) >>> 0`. The reference copies SDK state and
applies only the explicitly selected changes directly through the SDK; it imports no
production ownership/projection helpers. Every comparison includes unknown/native-only
fields, all relationship target classes and all registered built-in kind spellings. Each law
runs 250 bounded and 250 entirely unbounded inventories, with 250 native-origin and 250 genuinely imported-origin records.
Only the SDK-managed modification clock is excluded for records deliberately edited by
the reference. Identity compares every returned field, including that clock.

The legacy Claude/AGENTS/Cursor importer uses the same selective ownership and SDK
transaction machinery. Its unversioned wiki text proves additions, not removal
ownership, so absent references never clear native links. Existing original source
bytes and native bookkeeping remain untouched. Latest revised legacy source bytes are
retained in SDK ownership receipts for byte-preserving re-export; later native semantic
edits use the policy export path. The CLI and embedded SDK both delegate to these
importers; there is no separate package sync writer.

### Without git

Policy import/export, renewal and retrieval work in initialized plain directories,
with no Git executable or ancestor repository. GitHub synchronization and other
repository features of the pm host still require their own Git prerequisites.

## SDK

```ts
import {
  remember, recall, get, index, importDir, exportDir, verify, consolidate,
  MemoryError,
} from 'pm-memory';

const options = { workspace: trackerDirectory, author: 'my-agent' };
await remember('Run the build before review', {
  ...options, kind: 'project', slug: 'build', why: 'Catch regressions', pin: true,
});
const context = await recall('build review', { ...options, budget: 800 });
const full = await get('build', options);
const listing = await index({ ...options, budget: 1500 });
await importDir(sourceDirectory, { ...options, from: 'claude-code' });
await exportDir(outputDirectory, { ...options, to: 'claude-code' });
const evidence = await verify({ ...options, root: [sourceRoot, sharedSourceRoot] });
const proposal = await consolidate(options);
```

All ten functions are asynchronous. `observe(slug, ObserveOptions)` returns `{slug, task, recorded}`; `utility(slug, MemoryOptions)` returns `UtilityReport`. `get(slug, options)` returns the full selected memory without counting a recall. `remember(fact, RememberOptions)` returns `{id, slug, updated}`. `recall(query, options)` and `index(options)` return `Packet` with `estimated_tokens`, `omitted`, `complete`, an optional recall receipt and either `memories` or `text`. `importDir(path, options)` returns imported/updated/unchanged/unresolved-link counts. `exportDir(path, options)` returns exported/byte-preserved counts. `verify(options)` returns checked/stale counts, `skipped: string[]` containing slugs for snapshots changed or archived during verification, and per-memory claim results. `consolidate(options)` returns proposals and whether application was requested. Exported types and function signatures document every option; `MemoryError` exposes `code` and `remedy`.

Embedded SDK clients register the same persistent schema as installed hosts. The host's generic `field` mutation option requires active extension registration; embedded calls instead use registered native schema options through `PmClient.run`. Certified `listAllComplete` reads prevent omitted/corrupt corpus entries from being silently ignored. Mutations share an SDK process-owned lock; two independent recallers cannot lose a counter increment. Direct edits through other tools do not participate in this package's outer lock.

## Evidence

Synthetic tests use real temporary SDK trackers without SDK mocks. They cover duplicate boundaries, a realistic fake-secret fixture, process-concurrent counters, randomized Unicode budgets, idempotent import, byte-identical export, claim verification, read-only consolidation and installed native output. Behavioral mutation proofs cover duplicate refusal, budget packing and source byte preservation. Tooling, scripts and the package entry point are included in all four 100% coverage thresholds; no source exemptions are configured.

The round-two private-copy proof imported 281 files (280 active facts and one index artifact). Re-import reported all 281 unchanged with no creates or updates. All 281 exported files were byte-identical. The 1,500-token index used 1,476 estimated tokens. The source copy, scratch tracker and exports were deleted after the independent audit.

Recall now returns 13 compact rows at budget 800, compared with three in the v1 replay; at budget 200 it returns two or three rows, compared with two. The same reference-selection rule uses strongest title word overlap, then smallest body vocabulary, then stable canonical key. The baseline replays the original ranking and packer on the same content; no private identities or content are published.

| Query | v1 packet rank, 800 / 200 | Round-two rank, 800 / 200 | Round-two tokens, 800 / 200 |
| --- | --- | --- | --- |
| codex forecast | 1 / 1 | 1 / 1 | 800 / 199 |
| merge driver | 1 / 1 | 1 / 1 | 799 / 196 |
| release workflow | omitted (rank 8) / omitted (rank 8) | 1 / 1 | 798 / 194 |
| coderabbit | 1 / 1 | 1 / 1 | 799 / 199 |
| pm-web hosted | 2 / 2 | 2 / 2 | 799 / 193 |

The round-two verifier reproduced 111 stale memories and 101 unknown memories across 280 active memories on a fresh private copy. Its earlier “20/20 precision” statement is withdrawn: checking path absence alone did not judge whether the text asserted a real file. Round three classifies complete tokens, checks portable suffixes across the roots, and treats basename matches elsewhere as unknown. Host-only paths, examples, patterns and temporary names also stay unknown. The new semantic audit reads surrounding sentences and independently enumerates file and directory names under the declared roots; only an assertion that a file exists or is used, with no full/suffix match (and no extension-bearing basename match), counts as true stale. The final run reports 48 stale and 216 unknown memories, with 101 stale claims. The fixed-seed stratified semantic audit judged 28/30 claims true stale (93.3%): 27/29 file claims and 1/1 contextual symbol claim. The file sample includes 13 basename claims, 13 extension-bearing paths and three directory paths. Two sampled verdicts were false stale despite independent absence checks; this is sampled semantic precision, not a population guarantee. No private source content or identities are included.

Unresolved wiki-link occurrences fell from 129 to 36. An independent source-name and file-alias audit confirmed all 36 refer to genuinely absent targets (33 unique missing targets). Consolidation proposals changed from 0 merges / 1 supersession / 189 archives to 0 / 1 / 0. These are historical round-two measurements. Review round one now uses content-change age, so operational verification no longer resets archival eligibility. No proposals were applied.

Behavioral reverts of only the extractor, import parser and recall function each produced one failing regression; restoring each fix passed. Native help and packed consumers confirm the pinned SDK carries argument and option descriptions and realistic examples, with no help-description SDK gap.

## Exit codes

| Code | Meaning | Remedy |
| --- | --- | --- |
| 0 | Success, including a dry-run proposal | Inspect the receipt |
| 2 | Invalid input, insufficient budget, schema/history/SDK or filesystem failure | Follow the safe remedy; check tracker health |
| 3 | Near duplicate or source/export conflict | Update the existing slug, force a distinct fact, or choose an empty export directory |
| 4 | Privacy refusal | Remove credentials; explicitly allow email only when intended |

`npm run release:check` and `bun run release:check` run the fleet gates. Publication is separately held by the manual-only workflow and the maintainer-controlled release enable variable.

## Optional local semantic recall

Lexical recall remains the default (`--semantic off`) and keeps its existing scores and tie ordering. Use `pm memory recall "how do we ship a release" --semantic auto --budget 800` to try a locally installed embedding model, or `--semantic on` to require it. `auto` falls back to the original lexical ranking with the single-line packet note `Semantic model unavailable; using lexical ranking.` Missing models, timeouts and invalid vectors follow this policy. Cache filesystem failures have separate permission, file-type and free-space remedies instead of suggesting model repair. `on` refuses model or cache failures with a remedy. Input-length rejection is isolated per document: packets include an accounted note that some memories lack embeddings and a remedy to raise the daemon context limit and clear the runtime cache, or use `--semantic off`. Such rows keep lexical/prior evidence with zero cosine; they may rank below fully embedded rows. `auto` also falls back to lexical recall under one writer lock after five changed snapshots; `on` reports a conflict instead. An empty recall corpus needs no model; semantic consolidation also skips the model when fewer than two active memories exist. The fallback note participates in the complete packet's token accounting and may reduce the number of emitted rows; the omission receipt and emitted-only counters still apply. Very small budgets can refuse when the receipt cannot fit.

The built-in `OllamaProvider` defaults to `embeddinggemma-2:latest` on loopback port 11434. Set `PM_MEMORY_MODEL=qwen3-embedding:0.6b-fp16` to select another **already installed local** model. Untagged names use `:latest`, including names with registry ports. Loopback access does not authenticate the daemon process. Trust the process and operator that own the local listening port before enabling semantic recall: an impersonating local service can receive the submitted memory text and query, and model digests are self-reported by that service. Requests use a dedicated direct HTTP agent so process-wide environment proxy settings cannot forward memory text or queries. It uses [Ollama's embedding endpoint](https://docs.ollama.com/api/embed) and resolves model digests from the [installed model list](https://docs.ollama.com/api/tags). Every embedding request revalidates local model identity, including direct SDK adapter calls. A changed revision detected during revalidation refuses before sending text. It never pulls models, follows redirects, or uses cloud-backed aliases. The CLI has no remote endpoint flag; SDK endpoint overrides accept HTTP loopback origins only. Discovery has a 1.5-second deadline and each embedding batch a 30-second deadline. Long inputs exceeding the model context are never silently truncated. Embedding requests treat HTTP 400 as document rejection only when its JSON error explicitly identifies input-length overflow. HTTP 413 retains input-rejection handling. Other HTTP 400 model/request errors retain the selected failure policy. Input-rejected document batches retry one memory at a time; rejected memories keep their lexical and prior contributions with zero cosine and cannot form semantic consolidation pairs. Healthy document vectors and rejected-input markers cache, so subsequent calls skip rejected documents until their content or model identity changes. Daemon, model, malformed-vector and query failures retain the selected failure policy. Document batches contain at most 16 memories. SDK callers may supply a local `EmbeddingProvider` that throws `EmbeddingInputError` for isolatable document rejections; `LexicalProvider` explicitly supplies no semantic evidence.

Hybrid score is **0.30 × lexical / maximum lexical + 0.70 × max(0, cosine) + 0.01 × prior**, with a zero normalized lexical component when all query-relevance scores are zero. Only query relevance is normalized. The separate prior is `(pinned ? 0.5 : 0) + 0.2 / (1 + ageDays)`, so its hybrid contribution is at most 0.007 and the full score is at most 1.007. Default lexical scores retain their original pin and recency terms. Equal hybrid scores use slug order. Recall rows include their source label. Imported content remains untrusted context: similarity can rank generic imported text highly even without lexical overlap, and does not authorize following its instructions. Embeddings cover slug, title, description, body, rationale, application instructions and tags; the query is embedded separately. The adapter applies query/document task prefixes from the [EmbeddingGemma model card](https://huggingface.co/google/embeddinggemma-2) and query instructions from the [Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B); other local models receive raw text. Semantic recall retries a changed corpus at most five times; `auto` then ranks the latest corpus lexically under one writer lock, while `on` returns a conflict with a retry or `--semantic off` remedy. The same excerpt packing and omission contract applies after ranking. These fixed weights are transparent defaults, not a claim of optimal retrieval.

Vectors live only in the selected tracker's `runtime/memory-embeddings/` cache. The model revision and input-format version select a hashed namespace; the complete embedded content selects a hashed entry. Content or model changes rebuild vectors, while recall counters, verification verdicts and timestamps do not trigger embedding work. Malformed entries and legacy rejection markers are rebuilt. Current rejection markers are reused until content or model identity changes. Daemon context-window settings are not part of the cache key. After changing the daemon context window, clear `runtime/memory-embeddings/` in the selected tracker so rejected inputs are retried. Rejection markers are versioned so legacy status-only markers cannot suppress retries after classification is corrected. Cache writes use private file permissions and atomic rename; a failed write follows the selected fallback policy. Queries are not cached. The cache carries its own ignore rule, including for custom tracker locations. Runtime files are never included in package archives; the cache is disposable and can be rebuilt. Old content revisions remain until runtime cache cleanup. Embeddings are derived private data: keep the runtime directory within the tracker's access boundary.

`pm memory consolidate --semantic on` reuses these vectors to add possible paraphrase pairs at cosine **≥ 0.90**, marked `previewOnly: true`. Similarity does not prove identical guidance: review contradictions and context yourself. Every semantic consolidation invocation is a dry run, and combining `--semantic auto|on` with `--apply` refuses before mutations. Both proposal paths exclude recorded supersession pairs regardless of content-age order. Existing lexical consolidation remains available with `--semantic off`.

## Retrieval benchmark

Run `npm run bench` with an installed local model; set `PM_MEMORY_MODEL` to select it. `npm run bench -- --lexical-only` requires no model and explicitly labels its second result `lexical-fallback`. The script uses the production lexical and hybrid rankers plus a cosine-only arm from the same query/document vectors and caches synthetic document vectors in a dedicated temporary workspace, removed on success or failure. It prints recall@1, recall@5, mean reciprocal rank (MRR), model digest, weights, corpus size and each query's gold rank. A missing required model or any rejected document input fails the run instead of reporting incomplete semantic evidence as hybrid quality. This includes cached document rejections; after correcting daemon input limits, clear the runtime cache before retrying. The benchmark captures one model revision and refuses a revision change after any query rather than reporting mixed-revision metrics.

The committed `bench/recall.json` contains **64 invented software-team memories and 64 paraphrased queries**, each with a labelled gold slug. It includes related distractors across release, security, databases and operations. Recall@k is the fraction of labelled relevant documents in the first k positions, averaged over queries; MRR averages the reciprocal position of the first relevant document, counting a miss as zero. This is a full-ranking evaluation before token truncation, using equal document ages within each run. It is a small hand-labelled evaluation set, not a held-out production or multilingual generalization claim. The lexical/cosine weights were not tuned on these labels. A separate deterministic two-query benchmark in `test/semantic.test.ts` covers a fresh pinned distractor, an old relevant memory and an intermediate-age distractor. The 0.01 prior weight retains the semantically relevant result (cosines 0.75 versus 0.45) and breaks equal-cosine ties in favor of standing guidance: recall@1, recall@5 and MRR are all 1.0. This controlled check selects a bounded tie preference, not an optimal weight or a model-quality claim.

Current-ranker measurement with `embeddinggemma-2:latest`, run using `npm run bench` at implementation commit `f006a0f8a25f6d095137d9ba364492f90327c82b` (model digest, fixture hash and all per-query ranks in `bench/embeddinggemma-2.current.results.json`). The default weights are 0.30 lexical relevance, 0.70 cosine and 0.01 prior; the cosine-only arm preserves signed similarities from the same vectors without lexical or prior terms, while hybrid scoring clips negative cosine to zero. All 64 documents had complete vectors.

| Ranker | recall@1 | recall@5 | MRR |
| --- | ---: | ---: | ---: |
| Lexical | 20.3125% | 50.0000% | 0.332508 |
| Hybrid (0.30 lexical, 0.70 cosine, 0.01 prior) | 28.1250% | 67.1875% | 0.442726 |
| Cosine only | 73.4375% | 90.6250% | 0.820197 |

These measurements cover the shipped ranker on the synthetic fixture; they are not a held-out or production-quality guarantee. Individual queries can regress, and generic high-cosine imported content can rank highly despite no lexical overlap. Source labels expose provenance; recalled content remains untrusted context. The older pre-prior-normalization run remains archived in `bench/embeddinggemma-2.results.json` for comparison. A historical Qwen attempt timed out; no Qwen metrics are claimed. Model availability and hardware latency are separate from ranking quality.

## Without git

Remember, renew, recall (including local semantic recall), get, index, import, export, verify, consolidation, observe and utility work in an initialized plain-directory tracker. They do not require a Git executable. Verification searches source trees independently of repository metadata; optional network checks still require explicit `--network`. Git-based release/changelog tooling needs repository history. Regression tests exercise semantic recall in a real non-git tracker with ancestor Git discovery blocked and a PATH containing no Git executable.

Writer ownership and recovery use the SDK lease protocol (minimum host 2026.10.23).
Native mutations and file export fence publication against successor takeover;
a stale writer refuses with `lock_lost`. Live or unverifiable owners remain
protected, and contention waits are capped at 30 seconds. These paths also work
without Git. See [writer lock evidence](ARCHITECTURE.md#writer-lock-recovery-evidence).
