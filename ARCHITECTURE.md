# Architecture

## Data and history

Each fact is a native Knowledge item, registered as a custom type in the `knowledge` folder because the host does not ship a built-in Knowledge type. Titles are short headings; bodies retain full facts; tags participate in retrieval. Dependencies are native pm relationships, including `related` and `supersedes`. Comments explain consolidation decisions; all mutation history remains append-only. Export and consolidation verify history chains through the SDK before using them. Export names are compared without regard to case, including nested paths and reserved target index names; collisions refuse before publication. An exact original index can retain its reserved name.

| Registered field | Type | Meaning |
| --- | --- | --- |
| memory_slug | string | Unique key under the package writer lock |
| memory_kind | string | user, feedback, project or reference |
| memory_why / memory_how | string | Rationale and application instructions |
| memory_pinned | boolean | Standing guidance |
| memory_source | string | Harness and relative path class; never an absolute source root |
| memory_verified_at | string | Verification timestamp; empty after semantic revision |
| memory_reason | string | Confident stale claim reasons; cleared by verification when no longer stale |
| memory_verdict | string | verified, stale or unknown |
| memory_changed_at | string | Content-change timestamp, falling back to created_at for legacy facts |
| memory_merge | string | Pending idempotent merge receipt, cleared after completion |
| memory_recalls | number | Nonnegative safe-integer count of emitted recalls |
| memory_path | string | Validated relative original file name for export |
| memory_original | string | Base64 text containing exact imported bytes |
| memory_edited | boolean | Semantic update requires regenerated export |
| memory_artifact | boolean | Source index retained solely for lossless export |

Source bytes are durable item metadata, so shared tracker access includes access to imported files. The package never stages imports inside its own repository. The input privacy gate runs before schema or item mutations; imported emails require explicit opt-in. Unsafe source names, symlinks, non-UTF-8 files, unknown kinds, normalized slug collisions and conflicting semantic edits refuse.

The Store reads settings and registers fields through SDK schema operations. It certifies every full-corpus read using `certifyCompleteListResult`. Duplicate slugs, invalid counters, invalid verdicts and damaged history refuse. It uses `acquireLock` with a process-owned `memory-writer` lock, a 3600-second TTL and a 30-second capped wait. Same-host owners proven dead by ESRCH are reclaimed under the SDK cleanup gate with a warning. Live, foreign and unverifiable owners are never reclaimed, even after TTL expiry; contention returns an actionable `conflict` error. PID reuse fails closed when an unrelated live process holds the recorded PID. See [writer lock evidence](#writer-lock-recovery-evidence) for the pinned SDK protocol, measurements and manual recovery procedure. The lock encloses full-corpus read, slug validation and every counter update across independent processes. Native item/schema writers retain their own locks. Recall tests release two independent Node processes concurrently, each recalling three times, then assert exactly six increments.

The outer lock coordinates pm-memory clients. Independent native pm updates can bypass it; operators should use the package APIs for slug and counter changes. A multi-item operation is a sequence of audited SDK writes, so a process failure may leave a partial import/verify/consolidation. Retrying idempotent source imports completes missing files and links. Existing history is never repaired or rewritten by this package.

Embedding requests run outside the writer lock. Consolidation captures the certified corpus and lexical proposals under the lock, then embeds that snapshot for its advisory preview. Semantic recall captures a corpus under the lock, ranks outside it, and reacquires the lock to validate the corpus and increment the latest emitted-row counters. Content or membership changes trigger a fresh ranking pass; counter-only changes do not invalidate the snapshot. Five conflicting snapshots terminate semantic recall with a conflict and a retry or lexical-mode remedy. Default lexical recall reads, ranks, packs and increments counters within one critical section and one corpus read; it does not compare revisions or retry. Lexical consolidation applies retain the lock across planning and mutations.

## Similarity and ranking

Duplicate refusal computes Jaccard overlap of normalized distinct word tokens over title plus body. The threshold is inclusive at 0.82. The SDK supplies text normalization and Jaccard scoring. Unchanged remember calls compare trimmed bodies, retain verification and imported-source state, and preserve content age even when adding links. CRLF headings use the same first-line boundary as LF headings. Exact-slug updates keep one identity; explicit update requires an existing key; force-new permits a distinct identity. Import retains source duplicates to preserve every source file and lets consolidation propose merges.

Recall uses normalized query terms across slug, title, native description, body, rationale, application guidance and tags. Matching terms receive inverse-document-frequency weight `log(1 + N / (1 + df))`, normalized by `1 + log(1 + document_words) / 10`. Field weights are title 5, description 2, slug 1.5 and other text 1; the highest applicable weight wins for a term. This retains title specificity while including descriptive hooks. Lexical evidence is multiplied by 10, pinned guidance adds 0.5, and recency adds at most 0.2 with a one-day decay scale. Recency uses memory_changed_at, falling back to created_at; operational writes never refresh it. Each ranking pass captures one clock value for all recency priors and computes document frequency once per query term, keeping query membership work linear in the corpus size. Ties resolve by slug. The index orders pinned first, kind alphabetically, newest update first, then slug.

## Budget packing

The SDK exports `estimatePmOutputTokens`, whose estimator is `ceil(utf8_bytes / 4)`. The package uses the host's TOON encoder and pretty JSON representation and takes the larger byte count, including the final newline. Each proposed packet includes its omission receipt and a stabilized self-accounting token count. Only a fully measured candidate that fits is accepted. The index may skip oversized rows. Recall first packs compact rows in rank order, stopping when the next row cannot fit. Each complete prefix or excerpt candidate is accounted once; accepted packets retain that stabilized receipt instead of repacking all earlier rows. It trims the top description if necessary and refuses rather than skipping the top result; a 200-token budget can hold every supported top row. Remaining space is spent on top-result excerpts with explicit truncation markers. The packet is never oversized. A budget too small for the empty envelope refuses without counter updates. Randomized tests cover real SDK-created memory sets, multiple budgets, Unicode and omissions. Recall increments only rows accepted by the packer, after checking all emitted counters for exhaustion before any increment.

Recall excerpts center near the first matching query term and retain a bounded prefix around that location. Unicode normalization at truncation boundaries prevents lone surrogate output. Index rows use a short rationale/body hook and always end with an omitted-memory count. Full source text remains in the item for explicit follow-up reads.

## Import and export

Import first enumerates only regular files, validates all paths/content/privacy and parses metadata; only then does it enter the writer boundary. YAML handles quoted/block scalars and nested metadata. A narrow compatibility transformation quotes plain name/description values containing a colon for parsing only; original bytes never change. A valid kebab-case frontmatter name maps to the canonical slug; otherwise the normalized file stem is used, with a digest fallback for empty or long stems. Retained filenames supply legacy link aliases and byte-identical export names. Canonical names take precedence over aliases. The native description retains the frontmatter hook; semantic edits to it invalidate original-byte preservation. Privacy preflight scans each complete decoded file before any mutation, including credentials split across lines. It aggregates offending relative files with safe line numbers and matched classes, or a multiline location when no individual line matches; matched values are never echoed. A changed original source revises the item through SDK updates. An unchanged source and already-existing wiki links produce no durable writes. Unresolved wiki-link counts are explicit.

Every original file, including MEMORY.md, is a Knowledge item. MEMORY.md is marked as an artifact and omitted from active recall/index/verify. Export of unchanged same-harness imports decodes original bytes rather than formatting YAML or Markdown again. Semantic edits generate portable content. Semantic fields are compared against the parsed original before preserving bytes, so edits through other pm surfaces cannot silently export an obsolete source. Empty files retain source identity through their relative name. Before writing, export checks histories, relative paths and destination conflicts. It inspects parents without writes, creates missing destination parents after preflight, stages exclusive files in a sibling temporary directory, applies the normal directory mode masked by the process umask, then renames the complete directory into place. Failed staging is removed; the destination stays intact. Identical existing exports are accepted. Current imported indexes retain original bytes only when their links exactly match all emitted facts; stale indexes are regenerated with sanitized titles and relative destinations; names requiring encoding are percent-encoded and angle-delimited. Both plain and angle-delimited current links are recognized for byte preservation. AGENTS.md includes added native facts and removes every retained original component occurrence when that component is archived or revised, preserving standalone content and unchanged bytes. Canceled imports are omitted before byte preservation. Export permits POSIX root-owned system links in ancestor directories while refusing user-owned links and destination links.

## Claim verification

The extractor classifies complete tokens before inspecting paths. File candidates have a recognized filename extension, an explicit relative/home/absolute prefix, or multiple segments including a source directory such as src, scripts, test, docs, .github or .agents. Repository owner/name pairs are repo claims; scoped npm names and package-qualified subpaths are package claims. URLs, slash-joined flags, member expressions and known runtime calls cannot leak file substrings. Repeated claims retain their uncertainty context.

Candidate syntax alone does not establish current file use. Temporary names, glob/brace/placeholder patterns, abbreviated paths, joined filenames, undelimited directory pairs, process-search patterns, ignore rules, dependency exports, fenced examples and explicitly historical or hypothetical sentences stay unknown. These conservative heuristics can miss real stale references; they do not attempt general natural-language entailment. File extensions use a documented implementation vocabulary to distinguish filenames from member access.

File evidence uses repeatable explicit roots and a shared suffix index, including hidden files, nested Git repositories, empty directories and symlink names. Parent roots subsume nested requests. Inventories ignore gitignore and prune node_modules, .git, dist and coverage at every depth. To resolve explicitly requested tracker-runtime references, .agents path names contribute to the path index; their contents remain excluded from symbol/flag text searches. Inventory uses an in-process directory walk and the same suffix index for path resolution. Queued directories are checked again with lstat before descent; a non-regular root refuses instead of producing an incomplete inventory. Text reads resolve confinement under the declared root and open with O_NOFOLLOW before streaming indexed regular files once with a 64 MiB run cap and 8 MiB per-file cap, retaining overlap across chunks. All Markdown and Cursor rule files and tracker contents are excluded from source text evidence; the explicit workspace is excluded by both resolved and real paths even outside .agents or through a workspace symlink. Tracker file names remain in the suffix index for explicit path-existence claims; only their contents are excluded from textual evidence. Source code in memories directories and siblings sharing the tracker name prefix remains searchable. File/directory/symlink enumeration is capped at 100,000 entries per root and the suffix index at 1,000,000 keys. Failed inventories refuse; incomplete text searches cannot establish absence.

Every root-relative and home-relative path suffix is indexed once, including the roots themselves. This resolves nested basenames and truncated home paths. Home anchors are stripped before claims are returned or reasons persisted. Absolute paths outside home, excluded/escaping paths, symlink escapes, raced-away indexed paths and unmatched home references outside the declared roots remain unknown. A missing extension-bearing path with a basename elsewhere is unknown with `basename found elsewhere: <relative match>`. Only asserted file candidates with neither a full/suffix match nor an extension-bearing basename match are stale, with `Path <p> not found under the given roots (add --root if it lives elsewhere)`.

Core CLI flags consult exported SDK contracts and source presence; an unknown-context flag is unknown. Symbols search enumerated source files in batches; absence requires a same-line nonambiguous filename context whose normalized indexed path belongs to the searched source files, rather than an excluded document, tracker file or directory context, and carries `symbol absent in <n> files searched`. All lexical claims are searched together. These checks establish textual evidence only.

No network calls occur without `network: true` / `--network`. Repositories stay unknown offline; opt-in checks invoke `gh repo view` with an argument array, and unsuccessful checks remain unknown. Package subpaths remain unknown; exact npm versions can be checked with bounded `npm view` calls. Registry-not-found versions are stale, transport failures unknown. URL HEAD returns verified for success, stale for 404/410 and unknown for other responses or transport errors.

One stale claim makes the memory stale. Verified requires at least one claim and every extracted claim verified. Any unknown evidence, or no claims, produces unknown. Claim checks run before taking the memory writer lock, and network subprocesses run asynchronously. Under the lock, verification rereads active memories and persists only snapshots whose content-change timestamp, title, body, rationale and application guidance still match. Changed or archived memories are skipped and excluded from the checked count. Each persisted result records a timestamp, verdict and confident stale reasons through native SDK updates and returns the failing claim alongside its type.

## Consolidation

A certified snapshot produces deterministic proposals. Near duplicates use the same threshold as remember. A newer memory with at least 0.5 heading or slug-token overlap and explicit opposite guidance produces a supersedes proposal. Enable/disable negations are normalized first. Each side must have an exclusive opposite toggle or requirement signal with the same remaining subject at the duplicate threshold; ambiguous mixtures are refused. Always/never requires matching remaining guidance at the duplicate threshold. This remains a conservative lexical proposal rather than general semantic inference. An unused stale memory can be archived only when unpinned, its recall count is zero, it retains a confident stale reason and its memory_changed_at age meets minAgeDays (default 30). Verify and recall do not alter content age. Each memory occupies at most one action role per plan, including both endpoints of merge and supersession actions and archive sources. Selection reserves endpoints for link-only supersessions first, then eligible merges, then remaining archives, preserving deterministic snapshot order in the returned plan. Memories participating in proposed or existing supersession relationships cannot be merged away. Supersession sources and merge targets cannot also be archived in the same plan. A deterministic randomized invariant exercises all action classes and checks every endpoint. Supersession proposals to archive-bound targets are omitted, and an existing native supersedes edge suppresses a repeated proposal while leaving both memories active. A receipt records the target and exact resulting body before publication. Retries resume it even if similarity changed, set the same body and semantic metadata, cancel the source, then clear the receipt. Pending receipts reserve their endpoints before fresh proposals are selected; overlapping or self-referential pending receipts refuse before writes and require audited reconciliation.

Without apply, no schema, comments, metadata or history changes occur. With apply, duplicate merges copy older context into the surviving body, add native links/comments and cancel the older item with a reason. Supersession adds a newer-to-older native supersedes link and a comment. Archives cancel the item with a reason. All originals and verified native history remain readable. Review dry-run proposals before authorizing application.

Interrupted merge receipts bind source and destination semantic revisions. Replay accepts only the original or already-published destination state; intervening edits, missing destinations and legacy receipts refuse before any planned writes, preserving the receipt for reconciliation. Existing and proposed supersession endpoints remain active during merge selection. Verification returns skipped snapshot slugs alongside checked results.

Export resolves every wiki reference against emitted facts and their actual re-imported canonical slugs before building aggregate indexes. Canceled, artifact, absent and ambiguous targets become plain text, preserving their visible reference text. Generated relationships omit canceled and artifact targets. Original bytes count as preserved only when reference reconciliation leaves them unchanged.

## Writer lock recovery evidence

The pinned `@unbrained/pm-cli` 2026.10.19 package implements its main lock in
`dist/core/lock/lock.js`. `buildLockPayload` records `id`, `pid`, `owner`, `token`,
`created_at` and `ttl_seconds`, but no host. `isStaleLock` compares only
`Date.now() - Date.parse(created_at)` with the caller's TTL. The PID is used for
release ownership, not main-lock stale detection. `acquireLock` emits
`lock_conflict` after its bounded wait; with force-required stale handling it
refuses old locks rather than deleting them. The SDK's separate
`.stale-cleanup/owner.json` gate does check process liveness.

`test/sdk-lock-holder.ts` reproduces the main-lock gap without package code:
acquire `sdk-repro` with a 3600-second TTL, signal readiness, then SIGKILL the
child. A second `acquireLock` with zero wait throws `lock_conflict` even though
the first PID is dead. `test/review-r11.test.ts` executes this reproduction.
No upstream report was filed.

Package locks now append a host fingerprint to their runtime owner string.
Recovery requires that exact local fingerprint, a valid positive PID, and
`process.kill(pid, 0)` failing specifically with ESRCH. Permission errors,
unknown ownership, legacy locks and foreign hosts fail closed. A live process
is never reclaimed, including after TTL expiry. The fingerprint assumes host
names uniquely identify hosts sharing the tracker and that writers share the
host PID namespace; do not share a tracker between distinct PID namespaces
presenting the same host name.

Before unlinking, recovery exclusively creates the SDK's `.stale-cleanup`
gate, writes its own live PID and token using the pinned gate protocol, then
reads and checks the current main lock again. SDK acquisition, release and
stale removal all acquire that same gate. Competing recoverers therefore
cannot delete a replacement owner's lock. The package never removes another
process's gate. If killed while holding the gate, the SDK's abandoned-gate
recovery applies; retry after its 10-second stale-gate interval. Native item
and schema locks remain SDK-owned. No other package SDK lock/claim call exists.

Successful recovery emits `PM_MEMORY_LOCK_RECOVERED` with the dead PID.
Contention is `MemoryError('conflict', ...)`, with PID, host class, age, retry
advice and a conservative manual procedure for foreign/legacy owners. Default
wait is 30 seconds, capped at 30 seconds even with a larger environment override;
`PM_LOCK_WAIT_MS=0` remains fail-fast. Recovery runs before every fail-fast SDK
attempt, including retries during the wait. The package bounds the complete retry lifecycle with a monotonic deadline.
This also retries transient SDK stale conflicts while another process is
initializing the main lock under the cleanup gate.

PID reuse is deliberately conservative: the main SDK payload has no process
start identity. If its PID now belongs to an unrelated live process, recovery
cannot distinguish it from the original owner and refuses. The adversarial
test substitutes an unrelated live PID to model that case. Stop all writers
and investigate before manually removing such a lock. Host identity is also
unavailable for pre-change SDK locks, so those require manual verification.

The TTL remains 3600 seconds, with force-required stale handling: expiration
never authorizes removing a live or foreign main lock. A measured non-git
tracker workload covers a 12-file import, remember, recall, verify, export and
applied consolidation. The first measured maximum was 5875.34 ms across six
critical sections; a second run under contention measured 32020.08 ms
(32.021 seconds). Subsequent gate-run measurements are recorded in the review
tracker. These measurements are observations, not an upper bound for arbitrary corpus sizes or slow storage; keeping the existing
one-hour TTL avoids shortening the lease below a possible long operation.
Even longer live critical sections remain protected by force-required policy.

## Optional semantic retrieval

`src/embeddings.ts` defines an async installed-model identity and batch embedding interface. The loopback-only Ollama adapter rejects cloud aliases during model discovery and refuses redirects and oversized inputs. A dedicated HTTP agent bypasses global environment proxies, and untagged model names canonicalize to `:latest` before discovery and embedding. The lexical adapter returns no semantic evidence. New providers must preserve local-only execution and change identity whenever weights or preprocessing change.

The retrieval cache is disposable tracker runtime, separate from Knowledge items and append-only history. Namespace keys hash model identity (including its installed digest and format version); entries hash every embedded retrieval field. Batches fill cache misses with private atomic files. Explicit HTTP 400/413 document rejections retry individually; only rejected rows lack vectors, retain zero cosine in recall and are omitted from semantic pairs. Model, transport, protocol and query failures remain strict in on mode. Rejected inputs cache private rejection markers in the same model/content namespace, so repeated reads do not resubmit them; content or model changes permit a fresh attempt. Operational metadata does not invalidate embeddings. Query vectors remain transient. Reads validate finite nonzero vectors with consistent dimensions before cosine calculation. Invalid evidence cannot participate in ranking. Recall and consolidation normalize each vector once per ranking pass and compare clamped dot products; the recall query norm is also reused.

Recall blends normalized query relevance at 0.30 with nonnegative cosine at 0.70 and adds 0.01 times the separate pin/age prior, then sends the resulting order through the existing packet builder. The builder counts fallback notes, omission receipts and both output encodings before writing recall counters. Only query relevance contributes to the normalization maximum; zero query matches yield a zero lexical share. The prior is `(pinned ? 0.5 : 0) + 0.2 / (1 + ageDays)`, contributing at most 0.007. Off mode bypasses embeddings and retains exact lexical output in one read/lock section. Auto handles provider/cache failures with one safe note; on fails explicitly. The process-safe writer lock protects snapshot capture and emitted-only counter updates. For semantic recall, ranking and embedding requests run between these critical sections; a changed corpus retries, and increments always use current counters. Each model request is bounded, while total corpus work depends on the number of uncached batches and retries.

Semantic pairs sort by ascending content age with slug ties, preserving the older source convention. Pin-only updates preserve content age and verification; retrieval-content edits refresh age and reset verification. Consolidation skips embeddings for fewer than two active memories; otherwise it shares the cache but only previews semantic candidates at cosine 0.90 or higher. It refuses semantic apply before opening the mutation path. Existing lexical proposals remain intact; semantic evidence is advisory and cannot establish equivalence or absence of contradiction. The benchmark uses production ranking code and a versioned synthetic corpus in a temporary workspace cleaned on success and failure, with full per-query evidence kept as text. A controlled pin/age benchmark verifies that the 0.01 prior coefficient preserves relevance while resolving semantic ties; see README for the measurements and historical-model result boundary.
