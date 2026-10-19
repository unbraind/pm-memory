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
| remember | `pm memory remember "Run the build before review" --kind project --slug build --why "Catch regressions" --how "Run npm test" --pin --link project-item` | Create Knowledge or revise an exact slug |
| recall | `pm memory recall "build review" --budget 800 --kind project` | Ranked, bounded excerpts; counts emitted memories |
| index | `pm memory index --budget 1500` | MEMORY.md-style markdown in `text`, ending with an omission receipt |
| import | `pm memory import ./memory-copy --from claude-code` | Idempotent import; native links from `[[slug]]` |
| export | `pm memory export ./memory-output --to claude-code` | Exact imported bytes or generated portable files |
| verify | `pm memory verify --slug build --root .` | Evidence verdict, timestamp and failing claims |
| consolidate | `pm memory consolidate` | Read-only duplicate, supersession and archive proposals |

`remember` requires `--kind user|feedback|project|reference`. Omit `--slug` for a stable content-derived key. An exact slug updates the same item and appends native history. Use `--update build` to require that the key already exists. Near duplicates at or above 0.82 normalized title-plus-body token Jaccard similarity refuse with the existing key and two remedies: `--update <slug>` or `--force-new --slug <distinct-key>`. `--why`, `--how`, `--pin` and repeatable `--link` add retrieval context and relationships. SDK clients may also supply tags.

The privacy gate examines facts, rationale, application instructions, tags and imported source bytes before mutations. It refuses recognizable API/token prefixes, JWTs, private keys, password/key/secret assignments, authenticated URLs and credential-shaped token assignments. Variable references and short plain `token:` accounting prose are references rather than literal credentials. Emails require explicit `--allow-email`, also supported by import. This heuristic is an input guard, not a proof that arbitrary prose contains no private information. Do not store credentials in memory.

Recall defaults to 800 estimated tokens; index defaults to 1500. The entire packet, including the estimated-token field and omission receipt, is measured in both pretty JSON and native TOON with the host's UTF-8 byte estimator. An impossibly small budget refuses before counter writes. Oversized entries are omitted; they never silently expand a budget. Excerpts are query-centered and Unicode-safe. An index orders pinned guidance first, then kind, then recency.

Import supports `--from claude-code|agents-md|cursor`, directories or individual regular UTF-8 files. Claude Code frontmatter recognizes `name`, `description`, `metadata.type` and legacy top-level `type`; optional `**Why:**` and `**How to apply:**` lines become fields. Unknown memory kinds and malformed YAML refuse. Plain unquoted `name`/`description` values containing a colon are accepted without altering their original bytes. Directory indexes are retained as export artifacts and excluded from retrieval. Import deliberately retains source duplicates for review instead of discarding source files. Re-importing unchanged bytes and links performs no durable writes. Independently revised items refuse source replacement.

Export supports `--to claude-code|agents-md`. Imported files of the same harness retain byte-identical content, frontmatter, BOM, line endings, ordering and final newline. Recall and verification metadata do not invalidate that preservation. Semantic updates generate fresh content. New Claude Code exports include a MEMORY.md index; AGENTS exports include an AGENTS.md plus per-memory files. Symlinks, unsafe relative names and conflicting destination files refuse; identical existing files are accepted. Use a dedicated empty output directory. Files are created exclusively; export does not overwrite existing content.

Verification extracts delimited paths, `fn()` calls, `--flags`, exact `package@version` claims and HTTP(S) URLs. Local checks use `--root` (the current directory by default), refuse escaping symlinks, and use ripgrep for symbol/flag presence. `--network` enables `npm view` version checks and URL HEAD checks. Without it, network claims remain unknown. A missing local claim makes a memory stale; all claims must verify for a verified verdict; no claims or incomplete evidence yields unknown. Grep proves textual presence, not runtime correctness. Network outages and denied endpoints remain unknown.

Consolidation changes nothing without `--apply`. Applied duplicate merges retain old content in the surviving item, link the originals and cancel the duplicate with a reason. Supersession recognizes overlapping headings/slug tokens with explicit opposite guidance (`enable/disable`, `always/never`, `required/forbidden`); it adds a native `supersedes` edge and a comment. It is a lexical proposal, so review the dry run before applying. Stale memories are archived only when never recalled and not pinned. All original items and history remain available.

## Harness usage

Claude Code can import and export its memory directory. Codex and pi can import AGENTS.md sections as files and consume recall/index directly. Cursor can import its rules directory. Commands always use the selected tracker, so shared visibility follows the host's tracker access and extension configuration.

Add this guidance to AGENTS.md (or the harness's equivalent instructions):

```md
## Long-term memory

At session start, run `pm memory index --budget 1500`, then
`pm memory recall "<current task>" --budget 800`.
Read linked pm items when more context is needed.
After learning a durable fact, use `pm memory remember "<fact>" --kind project`
with a stable slug, rationale and application guidance. Update existing slugs.
Never store credentials. Review `pm memory verify --root .` and
`pm memory consolidate` periodically; review proposals before applying them.
```

For a local Markdown artifact, extract the SDK packet's `text` field. CLI output remains a structured host receipt rather than writing an untracked MEMORY.md into the repository automatically.

## SDK

```ts
import {
  remember, recall, index, importDir, exportDir, verify, consolidate,
  MemoryError,
} from 'pm-memory';

const options = { workspace: trackerDirectory, author: 'my-agent' };
await remember('Run the build before review', {
  ...options, kind: 'project', slug: 'build', why: 'Catch regressions', pin: true,
});
const context = await recall('build review', { ...options, budget: 800 });
const listing = await index({ ...options, budget: 1500 });
await importDir(sourceDirectory, { ...options, from: 'claude-code' });
await exportDir(outputDirectory, { ...options, to: 'claude-code' });
const evidence = await verify({ ...options, root: sourceRoot });
const proposal = await consolidate(options);
```

All seven functions are asynchronous. `remember(fact, RememberOptions)` returns `{id, slug, updated}`. `recall(query, options)` and `index(options)` return `Packet` with `estimated_tokens`, `omitted`, `complete` and either `memories` or `text`. `importDir(path, options)` returns imported/updated/unchanged/unresolved-link counts. `exportDir(path, options)` returns exported/byte-preserved counts. `verify(options)` returns checked/stale counts and per-memory claim results. `consolidate(options)` returns proposals and whether application was requested. Exported types document every option; `MemoryError` exposes `code` and `remedy`.

Embedded SDK clients register the same persistent schema as installed hosts. The host's generic `field` mutation option requires active extension registration; embedded calls instead use registered native schema options through `PmClient.run`. Certified `listAllComplete` reads prevent omitted/corrupt corpus entries from being silently ignored. Mutations share an SDK process-owned lock; two independent recallers cannot lose a counter increment. Direct edits through other tools do not participate in this package's outer lock.

## Evidence

Synthetic tests use real temporary SDK trackers without SDK mocks. They cover duplicate boundaries, a realistic fake-secret fixture, process-concurrent counters, randomized Unicode budgets, idempotent import, byte-identical export, claim verification, read-only consolidation and installed native output. Behavioral mutation proofs cover duplicate refusal, budget packing and source byte preservation. Tooling, scripts and the package entry point are included in all four 100% coverage thresholds; no source exemptions are configured.

Private-copy aggregate results are recorded here after the local acceptance run. No source content, file identities or tracker snapshots are published.

## Exit codes

| Code | Meaning | Remedy |
| --- | --- | --- |
| 0 | Success, including a dry-run proposal | Inspect the receipt |
| 2 | Invalid input, insufficient budget, schema/history/SDK or filesystem failure | Follow the safe remedy; check tracker health |
| 3 | Near duplicate or source/export conflict | Update the existing slug, force a distinct fact, or choose an empty export directory |
| 4 | Privacy refusal | Remove credentials; explicitly allow email only when intended |

`npm run release:check` and `bun run release:check` run the fleet gates. Publication is separately held by the manual-only workflow and the maintainer-controlled release enable variable.
