# pm-memory

Agents manage their own memory. Project management is context management: facts, feedback, standing preferences and references belong in shared, typed pm items instead of isolated harness files. A Knowledge item written by one agent is available through the same tracker to people, other agents, pm-web, MCP and pm-gpt. This package uses the pm SDK; a host must load the extension to expose its commands. Hosted deployment is outside this package's acceptance evidence.

This is an unreleased package under local review. Publication and scheduled releases remain held until the maintainer approves.

## Install

After publication, choose your usual package manager:

```sh
pm package install pm-memory

npm install --save-dev @unbrained/pm-cli@2026.10.19 pm-memory
npx pm package install pm-memory

bun add --dev @unbrained/pm-cli@2026.10.19 pm-memory
bunx --bun pm package install pm-memory

npx --package=@unbrained/pm-cli pm package install pm-memory
bunx --bun --package @unbrained/pm-cli pm package install pm-memory
```

Initialize a tracker first with `pm init`. For a nested project, set `PM_PATH` explicitly to its own `.agents/pm`. All SDK calls require an explicit initialized tracker directory; they never discover an ancestor. The peer host minimum and pinned development host are 2026.10.19. Node 22.18 or later is required.

## Commands

Every command returns native host TOON by default and accepts `--json`. Expected refusals include a typed category and a remedy. Source export writes files and returns a small receipt.

| Command | Example | Result |
| --- | --- | --- |
| remember | `pm memory remember "Run the build before review" --kind project --slug build --why "Catch regressions" --how "Run npm test" --pin` | Create Knowledge or revise an exact slug |
| recall | `pm memory recall "release workflow" --budget 800 --kind project` | Compact ranked rows, then excerpts; counts emitted memories |
| get | `pm memory get build` | Full selected memory, including its complete body |
| index | `pm memory index --budget 1500` | MEMORY.md-style markdown in `text`, ending with an omission receipt |
| import | `pm memory import ./memory-copy --from claude-code` | Idempotent import; native links from `[[slug]]` |
| export | `pm memory export ./memory-output --to claude-code` | Exact imported bytes or generated portable files |
| verify | `pm memory verify --slug build --root .` | Evidence verdict, timestamp and failing claims |
| consolidate | `pm memory consolidate` | Read-only duplicate, supersession and archive proposals |

`remember` requires `--kind user|feedback|project|reference`. Omit `--slug` for a stable content-derived key. An exact slug updates the same item and appends native history. Use `--update build` to require that the key already exists. Near duplicates at or above 0.82 normalized title-plus-body token Jaccard similarity refuse with the existing key and two remedies: `--update <slug>` or `--force-new --slug <distinct-key>`. `--why`, `--how`, `--pin` and repeatable `--link` add retrieval context and relationships. SDK clients may also supply tags.

The privacy gate examines facts, rationale, application instructions, tags and imported source bytes before mutations. It refuses recognizable API/token prefixes, JWTs, private keys, password/key/secret assignments, authenticated URLs and credential-shaped token assignments. Variable references and short plain `token:` accounting prose are references rather than literal credentials. Emails require explicit `--allow-email`, also supported by import. Import reports every offending relative file and line together with its matched class before writing anything; edit the listed files or permit email explicitly. This heuristic is an input guard, not a proof that arbitrary prose contains no private information. Do not store credentials in memory.

Recall defaults to 800 estimated tokens; index defaults to 1500. The entire packet, including the estimated-token field and omission receipt, is measured in both pretty JSON and native TOON with the host's UTF-8 byte estimator. An impossibly small budget refuses before counter writes. Recall packs compact rows first (slug, kind, pinned, description, score), in rank order; it then spends spare space on query-centered excerpts. A top result is never replaced by a smaller lower-ranked result. At 200 tokens even a maximum-length slug retains its top row; smaller budgets may refuse. Truncated excerpts carry an explicit marker pointing to `pm memory get <slug>`. Index entries may be omitted when oversized. All truncation is Unicode-safe. An index orders pinned guidance first, then kind, then recency.

Import supports `--from claude-code|agents-md|cursor`, directories or individual regular UTF-8 files. Claude Code frontmatter recognizes `name`, `description`, `metadata.type` and legacy top-level `type`; optional `**Why:**` and `**How to apply:**` lines become fields. Unknown memory kinds and malformed YAML refuse. Plain unquoted `name`/`description` values containing a colon are accepted without altering their original bytes. A valid frontmatter `name` is the canonical kebab-case key. The original file stem remains a link alias; canonical names take precedence, and ambiguous aliases stay unresolved. Frontmatter descriptions populate the native description field and participate in ranking and compact recall. Claude Code MEMORY.md indexes are retained as export artifacts and excluded from retrieval. Import deliberately retains source duplicates for review instead of discarding source files. Re-importing unchanged bytes and links performs no durable writes. A changed source reopens its archived memory; an unchanged re-import leaves it archived. Revisions preserve every other existing status. Independently revised items refuse source replacement.

Export supports `--to claude-code|agents-md`. Unchanged imported facts of the same harness whose wiki references still resolve retain byte-identical content, frontmatter, BOM, line endings, ordering and final newline. Recall and verification metadata do not invalidate that preservation. Semantic updates generate fresh content. Exported wiki links resolve only to emitted facts, using their exported canonical slugs or unambiguous path aliases; unavailable or ambiguous references become plain text. Generated relationships omit canceled items and index artifacts. Reference repairs reduce the byte-preserved count. Claude Code exports regenerate stale MEMORY.md indexes from the emitted relative paths; a complete current original index retains its bytes. AGENTS exports incorporate added facts, remove archived component sections and replace revised component sections in AGENTS.md, and include per-memory files. Destination symlinks, user-owned ancestor symlinks, unsafe relative names and conflicting destination files refuse; POSIX root-owned system links are allowed in ancestors; identical existing files are accepted. Use a dedicated empty output directory. Export plans before creating directories, writes to a sibling temporary directory, then publishes with one rename. Failed staging is removed. The destination must be absent, empty or already contain identical output. Export creates missing destination parents after preflight.

Verification extracts delimited paths, `fn()` calls, `--flags`, exact `package@version` claims and HTTP(S) URLs. Repeat `--root` to search multiple trees, including nested Git repositories: `pm memory verify --root . --root ../shared`. The bounded inventory includes hidden files and ignores Git ignore rules while excluding node_modules, .git, dist and coverage at every depth. Tracker file names remain resolvable for explicit path-existence claims; tracker contents never count as symbol or flag evidence. A bare basename, or a relative path whose suffix matches an indexed path, resolves under a root. A requested relative path that is missing stays unknown when only a different path shares its basename (`basename found elsewhere: <relative match>`); that match does not verify it. Known runtime globals are skipped. Absolute paths outside home, unmatched home references, excluded-tree and escaping paths remain unknown, as do symlink escapes. Home-relative and home-absolute paths can resolve when their portable suffix matches an indexed path under a declared root. Flags check the SDK command registry and source text; a flag absent from both has unknown context and is never stale. Absent symbols are stale only with explicit source-file context. Every stale claim includes an absence reason with the path or number of files searched. A bounded search failure remains unknown or refuses rather than claiming absence.

`--network` enables `npm view` version checks and URL HEAD checks. Without it, network claims remain unknown. One confidently absent claim makes a memory stale; all claims must verify for a verified verdict; no claims or incomplete evidence yields unknown. Textual presence does not establish runtime correctness. Network outages and denied endpoints remain unknown. Verification reports changed or archived snapshots in `skipped` without overwriting their verdicts.

Consolidation changes nothing without `--apply`. Applied duplicate merges retain old content in the surviving item, link the originals and cancel the duplicate with a reason. Supersession recognizes overlapping headings/slug tokens with explicit opposite guidance (`enable/disable`, `always/never`, `required/forbidden`); it normalizes toggle negations and requires exclusive opposing signals with matching subjects. Always/never requires the same remaining guidance. It adds a native `supersedes` edge and a comment. It is a lexical proposal, so review the dry run before applying. Archive proposals require stale status with a persisted confident reason, zero recalls, no pin, and `memory_changed_at` content age of at least 30 days. Use `--min-age-days 60` to change the threshold. Recall and verify leave content age unchanged. Legacy memories fall back to creation time. Merge targets remain active; durable merge receipts let retries finish without appending content twice. All original items and history remain available.

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

All eight functions are asynchronous. `get(slug, options)` returns the full selected memory without counting a recall. `remember(fact, RememberOptions)` returns `{id, slug, updated}`. `recall(query, options)` and `index(options)` return `Packet` with `estimated_tokens`, `omitted`, `complete` and either `memories` or `text`. `importDir(path, options)` returns imported/updated/unchanged/unresolved-link counts. `exportDir(path, options)` returns exported/byte-preserved counts. `verify(options)` returns checked/stale counts, `skipped: string[]` containing slugs for snapshots changed or archived during verification, and per-memory claim results. `consolidate(options)` returns proposals and whether application was requested. Exported types and function signatures document every option; `MemoryError` exposes `code` and `remedy`.

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

Lexical recall remains the default (`--semantic off`) and keeps its existing scores and tie ordering. Use `pm memory recall "how do we ship a release" --semantic auto --budget 800` to try a locally installed embedding model, or `--semantic on` to require it. `auto` falls back to the original lexical ranking with the single-line packet note `Semantic model unavailable; using lexical ranking.` Missing models, timeouts, invalid vectors and cache failures follow this policy. `on` refuses with a remedy instead of silently degrading. An empty recall corpus needs no model; semantic consolidation also skips the model when fewer than two active memories exist. The fallback note participates in the complete packet's token accounting and may reduce the number of emitted rows; the omission receipt and emitted-only counters still apply. Very small budgets can refuse when the receipt cannot fit.

The built-in `OllamaProvider` defaults to `embeddinggemma-2:latest` on loopback port 11434. Set `PM_MEMORY_MODEL=qwen3-embedding:0.6b-fp16` to select another **already installed local** model. Untagged names use `:latest`, including names with registry ports. Requests use a dedicated direct HTTP agent so process-wide environment proxy settings cannot forward memory text or queries. It uses [Ollama's embedding endpoint](https://docs.ollama.com/api/embed) and resolves model digests from the [installed model list](https://docs.ollama.com/api/tags). Every embedding request revalidates local model identity, including direct SDK adapter calls. A changed revision detected during revalidation refuses before sending text. It never pulls models, follows redirects, or uses cloud-backed aliases. The CLI has no remote endpoint flag; SDK endpoint overrides accept HTTP loopback origins only. Discovery has a 1.5-second deadline and each embedding batch a 30-second deadline. Long inputs exceeding the model context are never silently truncated. Embedding requests treat HTTP 400 as document rejection only when its JSON error explicitly identifies input-length overflow. HTTP 413 retains input-rejection handling. Other HTTP 400 model/request errors retain the selected failure policy. Input-rejected document batches retry one memory at a time; rejected memories keep their lexical and prior contributions with zero cosine and cannot form semantic consolidation pairs. Healthy document vectors and rejected-input markers cache, so subsequent calls skip rejected documents until their content or model identity changes. Daemon, model, malformed-vector and query failures retain the selected failure policy. Document batches contain at most 16 memories. SDK callers may supply a local `EmbeddingProvider` that throws `EmbeddingInputError` for isolatable document rejections; `LexicalProvider` explicitly supplies no semantic evidence.

Hybrid score is **0.30 × lexical / maximum lexical + 0.70 × max(0, cosine) + 0.01 × prior**, with a zero normalized lexical component when all query-relevance scores are zero. Only query relevance is normalized. The separate prior is `(pinned ? 0.5 : 0) + 0.2 / (1 + ageDays)`, so its hybrid contribution is at most 0.007 and the full score is at most 1.007. Default lexical scores retain their original pin and recency terms. Equal hybrid scores use slug order. Embeddings cover slug, title, description, body, rationale, application instructions and tags; the query is embedded separately. The adapter applies query/document task prefixes from the [EmbeddingGemma model card](https://huggingface.co/google/embeddinggemma-2) and query instructions from the [Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B); other local models receive raw text. Semantic recall retries a changed corpus at most five times, then returns a conflict with a retry or `--semantic off` remedy. The same excerpt packing and omission contract applies after ranking. These fixed weights are transparent defaults, not a claim of optimal retrieval.

Vectors live only in the selected tracker's `runtime/memory-embeddings/` cache. The model revision and input-format version select a hashed namespace; the complete embedded content selects a hashed entry. Content or model changes rebuild vectors, while recall counters, verification verdicts and timestamps do not trigger embedding work. Malformed entries and legacy rejection markers are rebuilt. Current rejection markers are reused until content or model identity changes. Daemon context-window settings are not part of the cache key. After changing the daemon context window, clear `runtime/memory-embeddings/` in the selected tracker so rejected inputs are retried. Rejection markers are versioned so legacy status-only markers cannot suppress retries after classification is corrected. Cache writes use private file permissions and atomic rename; a failed write follows the selected fallback policy. Queries are not cached. The cache carries its own ignore rule, including for custom tracker locations. Runtime files are never included in package archives; the cache is disposable and can be rebuilt. Old content revisions remain until runtime cache cleanup. Embeddings are derived private data: keep the runtime directory within the tracker's access boundary.

`pm memory consolidate --semantic on` reuses these vectors to add possible paraphrase pairs at cosine **≥ 0.90**, marked `previewOnly: true`. Similarity does not prove identical guidance: review contradictions and context yourself. Every semantic consolidation invocation is a dry run, and combining `--semantic auto|on` with `--apply` refuses before mutations. Both proposal paths exclude recorded supersession pairs regardless of content-age order. Existing lexical consolidation remains available with `--semantic off`.

## Retrieval benchmark

Run `npm run bench` with an installed local model; set `PM_MEMORY_MODEL` to select it. `npm run bench -- --lexical-only` requires no model and explicitly labels its second result `lexical-fallback`. The script uses the production lexical and hybrid rankers and caches synthetic document vectors in a dedicated temporary workspace, removed on success or failure. It prints recall@1, recall@5, mean reciprocal rank (MRR), model digest, weights, corpus size and each query's gold rank. A missing required model or any rejected document input fails the run instead of reporting incomplete semantic evidence as hybrid quality. This includes cached document rejections; after correcting daemon input limits, clear the runtime cache before retrying. The benchmark captures one model revision and refuses a revision change after any query rather than reporting mixed-revision metrics.

The committed `bench/recall.json` contains **64 invented software-team memories and 64 paraphrased queries**, each with a labelled gold slug. It includes related distractors across release, security, databases and operations. Recall@k is the fraction of labelled relevant documents in the first k positions, averaged over queries; MRR averages the reciprocal position of the first relevant document, counting a miss as zero. This is a full-ranking evaluation before token truncation, using equal document ages within each run. It is a small hand-labelled evaluation set, not a held-out production or multilingual generalization claim. The lexical/cosine weights were not tuned on these labels. A separate deterministic two-query benchmark in `test/semantic.test.ts` covers a fresh pinned distractor, an old relevant memory and an intermediate-age distractor. The 0.01 prior weight retains the semantically relevant result (cosines 0.75 versus 0.45) and breaks equal-cosine ties in favor of standing guidance: recall@1, recall@5 and MRR are all 1.0. This controlled check selects a bounded tie preference, not an optimal weight or a model-quality claim.

Historical measurement with the original prior-inclusive normalization and `embeddinggemma-2:latest` (digest and full per-query ranks in `bench/embeddinggemma-2.results.json`; these results predate the separate-prior correction):

| Ranker | recall@1 | recall@5 | MRR |
| --- | ---: | ---: | ---: |
| Lexical | 20.3125% | 50.0000% | 0.332508 |
| Hybrid (30% lexical, 70% cosine) | 28.1250% | 67.1875% | 0.442726 |

The improvement is modest and individual queries can regress. A separate attempt with the installed `qwen3-embedding:0.6b-fp16` timed out; no Qwen quality metrics are claimed. Model availability and hardware latency are separate from ranking quality.

## Without git

Remember, recall (including local semantic recall), get, index, import, export, verify and consolidation work in an initialized plain-directory tracker. They do not require a Git executable. Verification searches source trees independently of repository metadata; optional network checks still require explicit `--network`. Git-based release/changelog tooling needs repository history. Regression tests exercise semantic recall in a real non-git tracker with ancestor Git discovery blocked and a PATH containing no Git executable.
