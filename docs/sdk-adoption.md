# Public SDK adoption

The peer floor and development pin are 2026.11.5. Real temporary trackers exercise
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
| Generic literal assignments | Eight-character low-entropy values and aliases such as pwd/access token are outside the SDK entropy heuristic. Quoted JSON/YAML keys also need a local supplement: this SDK does not recognize their closing key quote. JSON scalar values and bounded nested string copies are decoded before applying the same literal policy; short values still delegate to SDK assignment rules. Environment references and explicit secret-manager placeholders remain accepted. |
| Generic sk/pk/rk prefixes and short GitHub keys | Legacy prefix refusal starts at 16 characters, includes short Anthropic-style keys, and has no word-end boundary for generic keys. SDK provider-specific floors, exclusions and boundaries differ. |
| Authorization headers and URL passwords | The shared scanner has no equivalent header or URL-authority rule. |
| JWT stream scan | Use the union of the old header/payload/signature thresholds and the SDK thresholds, preserving safe short JWT-shaped text while scanning arbitrarily long segments in linear time. |
| Mixed-case or long private-key markers | The SDK literal marker is uppercase; long markers can span bounded scan windows. |
| Encoded credentials | Credential rules are literal in this SDK; percent/JSON escapes (including serialized escape wrappers), NFKC, legacy provider prefix/AWS case and invisible controls receive up to four decoding passes before the same policy. Escape runs are consumed once, preserving ordinary backslashes without quadratic retries. Remaining repeated encoding refuses safely at the limit. Invalid UTF-8 bytes become replacement characters in the inspection view, so a malformed suffix cannot conceal valid credential bytes. |

The SDK private-host matcher exhibits quadratic behavior on a long hyphenated
noncredential without an at-sign. Credential scanning uses overlapping
128-character windows at 64-character strides and reuses adjacent identical
windows. A second window pass collapses whitespace, preserving unquoted SDK assignment context across arbitrarily long spacing without copying the assignment grammar. Each later window preserves the preceding character behind a neutral word prefix, so slicing cannot turn an embedded identifier into a new credential start. Bounded provider-key prefixes remain detectable; unbounded JWT and
private-key markers use the supplements above. A second SDK inspection uses complete
quoted spans with eight-character body prefixes and whitespace-normalized prefix contexts. The pinned SDK quoted rules require six or eight body characters; contiguous provider tokens remain covered by raw windows. Bounding the projection avoids redundant SDK work for long distinct quoted spans. Quoted-rule prefix contexts restart at quote delimiters. Short contiguous spans
already covered completely by a raw window skip redundant SDK calls; normalized
whitespace and long spans still receive the complete projection. It
retains both quote styles and mixed delimiters, so quoted SSH passwords with long values and
passphrases cannot bypass the host rules. Credential grammars and finding exclusions
still belong to the SDK adapter; no sshpass/password grammar is copied. The adversarial-input deadline controls remain unchanged, including distinct spans longer than 64 characters; CI certifies the complete gate.
Standalone environment-reference masking replaces the assignment key, separator, optional opening quote and reference with neutral text. An adjacent literal suffix instead retains the original assignment key and separator while removing the reference, so both scanners inspect that literal in context. Parenthesized explanatory suffixes remain accepted.

New admission rules run before schema/item writes. Native history and older
persisted records remain readable; emitted content still passes export policy.

Credential checks run before export origin setup, including decoded retained original documents, and on exact output bytes before publication. Existing records remain readable; credential-bearing legacy content cannot be emitted. Export retains its existing email-consent behavior. JSON string wrappers have a four-level inspection budget; malformed escaped credential declarations refuse safely without echoing their content.
