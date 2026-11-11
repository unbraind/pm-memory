# Public SDK adoption

The supported peer range is `>=2026.11.11 <2027`: the floor is the reviewed detector inventory and
the pinned development host, and the bound stops before the next major so an unreviewed redesign
cannot be claimed. Hosts inside the range upgrade without a package release; the runtime finding
policy refuses unknown findings from any newer runtime conservatively, so lockstep releases
are not required for safety. Raising the floor or the bound requires reviewing the public rule union
and passing the real SDK compatibility fixtures. Real temporary trackers exercise
public transaction readers, supported abandonment, host-bound batch staging and
birth construction, and locked expected revisions. Source publication retains its
forward-only domain coordinator because generic batch compensation restores
values and create replay adopts existing ids. Those semantics cannot replace a
portable birth proof. Field ownership, history prefixes, ABA detection, dependency
read sets and positive complete-birth evidence remain required. New coordinator journals carry
a package marker in public recoveryData, bound to transaction, author and step.
Recovery validates it before publishing or abandoning a receipt, including under
the abandonment lock. Legacy unmarked receipts remain untouched; their native
forward writes remain readable and are never reversed.

## Credential policy

`scanMutationSecrets` owns shared provider keys, AWS ids, private-key markers,
password rules and entropy-based assignments. Its safe findings are reduced to a
fixed package error; detected content and scanner paths are never echoed.

The SDK also reports home paths and private network identities. Those findings
are excluded here: package identity/path rules retain their existing scope, and
credential admission must not treat an operator path as secret content. Email
consent, retention and identity/path checks stay local. Email consent never
bypasses credentials.

Narrow supplements retain the stronger existing policy:

| Rule | Reason |
| --- | --- |
| Generic literal assignments | Eight-character low-entropy values and aliases such as pwd/access token are outside the SDK entropy heuristic. The SDK now recognizes quoted JSON/Python keys, nested arrays/objects and XML values under its own supported key names; memory-specific short-value alias compatibility remains stronger than its entropy rule. JSON scalar values and bounded nested string copies are decoded before applying the same literal policy; short values still delegate to SDK assignment rules. Free-text assignments with bracketed or quoted wrappers apply the same literal policy to the unwrapped value. Quotes inside a bracket wrapper are part of that value, for bare, quoted and quoted-key assignments; they do not end the wrapper early. Environment references remain locally exempt subject to the SDK union below, and the placeholder exemption is restricted to recognizable secret-manager placeholders: `redacted` or letter-only words joined by spaces, underscores or hyphens. The exact `[scrubbed]` assignment marker is also accepted. Other bracketed digits, symbols or credential material are not placeholders and refuse through the same literal policy. |
| Generic sk/pk/rk prefixes and short GitHub keys | Legacy prefix refusal starts at 16 characters, includes short Anthropic-style keys, and has no word-end boundary for generic keys. SDK provider-specific floors, exclusions and boundaries differ. |
| Authorization headers and URL passwords | The shared scanner has no equivalent header or URL-authority rule. |
| JWT stream scan | Use the union of the old header/payload/signature thresholds and the SDK thresholds, preserving safe short JWT-shaped text while scanning complete segments within the resource bounds below. |
| Mixed-case or long private-key markers | The SDK literal marker is uppercase; complete markers can contain long prefixes without a separator before PRIVATE KEY. The whole-marker supplement preserves this SDK-positive case and the stronger case-insensitive policy. |
| Encoded credentials | Credential rules are literal in this SDK; percent/JSON escapes (including serialized escape wrappers), NFKC, legacy provider prefix/AWS case and invisible controls receive up to four decoding passes before the same policy. Escape runs are consumed once, preserving ordinary backslashes without quadratic retries. Remaining repeated encoding refuses safely at the limit. Invalid UTF-8 bytes become replacement characters in the inspection view, so a malformed suffix cannot conceal valid credential bytes. |

Every admission and export check evaluates the union of SDK credential findings
and the local compound-key policy over the complete value. Neither scanner
receives a prefix, window, collapsed projection or masked reference in place of
the original. Complete transport-decoded views receive the same union check.
Import checks each complete source document; export checks all emitted fields,
decoded retained originals and exact rendered output bytes before publication.
Multi-line import refusals report a whole-document location because the SDK
findings do not expose safe source offsets.

The SDK private-host matcher exhibits quadratic behavior on some long dotted or
hyphenated noncredentials even without an at-sign. A linear resource guard
refuses the whole value with the typed privacy error before scanning when it
exceeds 1 MiB, or when the sum of each identifier run's length multiplied by its
dot/hyphen count exceeds 2,000,000. It never substitutes a partial inspection.
Ordinary long documents below those bounds remain accepted; adversarial deadline
controls retain their original limits and accept a safe typed refusal.

The local policy exempts complete standalone environment references, recognizable
placeholders and the exact `[scrubbed]` marker, but these exemptions never erase
an SDK credential finding. For example, `password=$BUILD_PASSWORD` and
`_authToken=${BUILD_TOKEN}` are SDK-positive and refuse; `password=${BUILD_PASSWORD}`
remains accepted. Parenthesized explanatory suffixes in local references remain
accepted when the complete match contains multiple space-separated words using
letters and prose punctuation, is at most 200 characters and ends at a value
boundary. Unknown or literal continuations refuse. The generic literal policy
includes passphrase aliases with the same eight-character floor.

New admission rules run before schema/item writes. Native history and older
persisted records remain readable; emitted content still passes export policy.
CLI privacy refusals supply a redacted recovery command and argument list so the
host cannot echo refused content through its default JSON or text recovery bundle.

Credential checks run before export origin setup, including decoded retained original documents. Refusals identify the native record id and field (including `document.original`) without echoing content, retain the underlying refusal category, message and remedy instead of replacing them with a generic cause, and rethrow failures that are not privacy refusals so defects never masquerade as policy. Checks also run on exact output bytes before publication. Existing records remain readable; credential-bearing legacy content cannot be emitted. Export retains its existing email-consent behavior. JSON string wrappers have a four-level inspection budget; malformed escaped credential declarations refuse safely without echoing their content.

The finding policy is exhaustively checked against the public `SecretGuardFinding["rule"]` union. Detector additions or removals fail typecheck until their category is reviewed; unknown findings from an unsupported newer runtime SDK refuse conservatively. The bounded peer range documents the reviewed compatibility floor without coupling routine host upgrades to a package release; raising its floor or upper bound requires reviewing the public rule union and passing the real SDK compatibility fixtures. Known identity/path findings stay local, and provider detector grammars remain SDK-owned. Nested objects retain their enclosing credential key when inspecting scalar descendants. JSON inspection gives each member a unique inspection key before parsing, so every duplicate assignment and its original credential context survives, including nested object/array values. Free-text JSON string inspection also checks overlapping unescaped quote boundaries, so stray prose quotes cannot hide serialized declarations. Local reference exemptions never override SDK findings; short-scalar policy remains unchanged.

SDK 2026.11.11 adds quoted-key, nested-value and XML inspection under its own supported credential names. The local parser remains necessary for the broader memory key/value policy tracked upstream in [pm-cli#1704](https://github.com/unbraind/pm-cli/issues/1704). One case-insensitive key grammar recognizes optional alphanumeric prefix components separated by underscores or hyphens and the credential suffix families, including `db_password`, `client_secret`, `GITHUB_TOKEN`, `aws_secret_access_key` and `stripe_api_key`. Bare assignments, reference classification, quoted and escaped declarations, bracket wrappers and inherited JSON member context share that grammar. Complete key boundaries preserve ordinary settings such as `token_budget`, `max_tokens` and `output_token_budget`; the existing value floors and placeholder exemptions remain in force.

Known limitations remain for SDK-unsupported keys nested in mixed prose that is not itself valid JSON, and environment-reference concatenations such as `password=${EMPTY}"literal"`. Remaining compatibility work is tracked in [pm-memory#58](https://github.com/unbraind/pm-memory/issues/58); shared detector changes belong upstream in pm-cli. Use standalone secret-manager references instead of embedding literal credentials.

Unreadable transaction receipts surface a safe typed transaction refusal rather than being treated as missing ownership. Revision conflict fingerprints retain the current revision found by the SDK locked write and the original expected history value.

JSON credential inspection tokenizes quoted strings at their known start and
stops after an unterminated token; malformed input falls back to the existing
free-text policy. Valid JSON still retains every duplicate member and its
original enclosing credential key.

Operational error translations retain the original typed failure as a
non-enumerable `cause` for SDK diagnostics. CLI JSON and TOON output continue to
use the safe domain message and remedy. Content-parser refusals omit raw syntax
errors that may contain refused input. Packed npm/Bun consumers run explicitly
under `test:install`, outside ordinary unit and coverage discovery.
