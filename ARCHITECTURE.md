# Architecture

## Data and history

Each fact is a native Knowledge item, registered as a custom type in the `knowledge` folder because the host does not ship a built-in Knowledge type. Titles are short headings; bodies retain full facts; tags participate in retrieval. Dependencies are native pm relationships, including `related` and `supersedes`. Comments explain consolidation decisions; all mutation history remains append-only. Export and consolidation verify history chains through the SDK before using them.

| Registered field | Type | Meaning |
| --- | --- | --- |
| memory_slug | string | Unique key under the package writer lock |
| memory_kind | string | user, feedback, project or reference |
| memory_why / memory_how | string | Rationale and application instructions |
| memory_pinned | boolean | Standing guidance |
| memory_source | string | Harness and relative path class; never an absolute source root |
| memory_verified_at | string | Verification timestamp; empty after semantic revision |
| memory_verdict | string | verified, stale or unknown |
| memory_recalls | number | Nonnegative safe-integer count of emitted recalls |
| memory_path | string | Validated relative original file name for export |
| memory_original | string | Base64 text containing exact imported bytes |
| memory_edited | boolean | Semantic update requires regenerated export |
| memory_artifact | boolean | Source index retained solely for lossless export |

Source bytes are durable item metadata, so shared tracker access includes access to imported files. The package never stages imports inside its own repository. The input privacy gate runs before schema or item mutations; imported emails require explicit opt-in. Unsafe source names, symlinks, non-UTF-8 files, unknown kinds, normalized slug collisions and conflicting semantic edits refuse.

The Store reads settings and registers fields through SDK schema operations. It certifies every full-corpus read using `certifyCompleteListResult`. Duplicate slugs, invalid counters, invalid verdicts and damaged history refuse. It uses `acquireLock` with a process-owned `memory-writer` lock, a bounded wait and conservative stale-lock handling. The lock encloses full-corpus read, slug validation and every counter update across independent processes. Native item/schema writers retain their own locks. Recall tests release two independent Node processes concurrently, each recalling three times, then assert exactly six increments.

The outer lock coordinates pm-memory clients. Independent native pm updates can bypass it; operators should use the package APIs for slug and counter changes. A multi-item operation is a sequence of audited SDK writes, so a process failure may leave a partial import/verify/consolidation. Retrying idempotent source imports completes missing files and links. Existing history is never repaired or rewritten by this package.

## Similarity and ranking

Duplicate refusal computes Jaccard overlap of normalized distinct word tokens over title plus body. The threshold is inclusive at 0.82. The SDK supplies text normalization and Jaccard scoring. Exact-slug updates keep one identity; explicit update requires an existing key; force-new permits a distinct identity. Import retains source duplicates to preserve every source file and lets consolidation propose merges.

Recall uses normalized query terms across title, body, rationale, application guidance and tags. Matching terms receive inverse-document-frequency weight `log(1 + N / (1 + df))`, normalized by `1 + log(1 + document_words) / 10`. Terms present in the title receive a threefold field weight. Lexical evidence is multiplied by 10, pinned guidance adds 0.5, and recency adds at most 0.2 with a one-day decay scale. Recency uses the native item's latest update time, including operational updates. Ties resolve by slug. The index orders pinned first, kind alphabetically, newest update first, then slug.

## Budget packing

The SDK exports `estimatePmOutputTokens`, whose estimator is `ceil(utf8_bytes / 4)`. The package uses the host's TOON encoder and pretty JSON representation and takes the larger byte count, including the final newline. Each proposed packet includes its omission receipt and a stabilized self-accounting token count. Only a fully measured candidate that fits is accepted. Large rows are skipped; the packet is never oversized. A budget too small for the empty envelope refuses without counter updates. Randomized tests cover real SDK-created memory sets, multiple budgets, Unicode and omissions. Recall increments only rows accepted by the packer.

Recall excerpts center near the first matching query term and retain a bounded prefix around that location. Unicode normalization at truncation boundaries prevents lone surrogate output. Index rows use a short rationale/body hook and always end with an omitted-memory count. Full source text remains in the item for explicit follow-up reads.

## Import and export

Import first enumerates only regular files, validates all paths/content/privacy and parses metadata; only then does it enter the writer boundary. YAML handles quoted/block scalars and nested metadata. A narrow compatibility transformation quotes plain name/description values containing a colon for parsing only; original bytes never change. The file stem maps to a slug; long or empty normalized stems receive a digest key. A changed original source revises the item through SDK updates. An unchanged source and already-existing wiki links produce no durable writes. Unresolved wiki-link counts are explicit.

Every original file, including MEMORY.md, is a Knowledge item. MEMORY.md is marked as an artifact and omitted from active recall/index/verify. Export of unchanged same-harness imports decodes original bytes rather than formatting YAML or Markdown again. Semantic edits generate portable content. Semantic fields are compared against the parsed original before preserving bytes, so edits through other pm surfaces cannot silently export an obsolete source. Empty files retain source identity through their relative name. Before writing, export checks histories, relative paths and destination conflicts. It traverses real directory parents and creates files with exclusive creation flags. Identical existing files are accepted. Filesystem failure during publication can leave newly created files; it never overwrites a conflicting file.

## Claim verification

The extractor recognizes HTTP(S) URLs, exact npm package versions (including scoped packages), identifier calls ending in `()`, long CLI flags, relative slash-delimited filenames and backtick-delimited common filenames. Repeated claims of the same type and value are checked once per memory. It is intentionally syntactic: claims embedded in prose may be examples, and undelimited statements may not be extracted.

File evidence resolves relative to the explicit root and stays inside its real path. Symlink escapes, absent paths and non-files are stale. Ripgrep performs fixed-string symbol-name/flag presence checks while excluding tracker internals, Git metadata and dependencies. Symbols prove textual presence rather than execution. No network calls occur without `network: true` / `--network`. Enabled npm checks use argument arrays with exact versions and bounded timeouts; registry-not-found versions are stale, transport failures unknown. URL HEAD returns verified for success, stale for 404/410 and unknown for other responses or transport errors.

One stale claim makes the memory stale. Verified requires at least one claim and every extracted claim verified. Any unknown evidence, or no claims, produces unknown. Each pass records a timestamp and verdict through native SDK updates and returns the failing claim alongside its type.

## Consolidation

A certified snapshot produces deterministic proposals. Near duplicates use the same threshold as remember. A newer memory with at least 0.5 heading or slug-token overlap and explicit opposite guidance produces a supersedes proposal. Enable/disable negations are normalized first. Each side must have an exclusive opposite toggle or requirement signal; ambiguous mixtures are refused. Always/never requires matching remaining guidance at the duplicate threshold. This remains a conservative lexical proposal rather than general semantic inference. An unused stale memory can be archived only when unpinned and its recall count is zero.

Without apply, no schema, comments, metadata or history changes occur. With apply, duplicate merges copy older context into the surviving body, add native links/comments and cancel the older item with a reason. Supersession adds a newer-to-older native supersedes link and a comment. Archives cancel the item with a reason. All originals and verified native history remain readable. Review dry-run proposals before authorizing application.
