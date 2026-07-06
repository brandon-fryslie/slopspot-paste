// [LAW:effects-at-boundaries] The PURE secret/PII scanner: given a string, it returns the
// ranges within it that look like a leaked credential or personal datum. No IO, no storage,
// no knowledge of pastes or turns — it draws ONE line (secret vs. not) over raw text, so it
// composes over ANY coordinate space [LAW:composability]. The warn-only slice feeds it the
// submitted original; the offer-to-redact slice feeds it each prose piece from
// spanPiecesByTurn(turns), and because a finding's [start,end) index into the string it was
// GIVEN, those offsets ARE overlay span-target coordinates — one scanner, two contexts,
// variability in VALUES not modes [LAW:dataflow-not-control-flow].
//
// [LAW:types-are-the-program] The accept/reject SHAPE TABLE below is the scanner's spec,
// written before the body (enumeration-gap discipline). Each rule mirrors ONE producer's
// exact emitted shape; every reject row is a near-miss that shares tokens but not the shape,
// defeated by construction — an anchored pattern or a refinement predicate — never patched
// in after a reviewer finds it. scripts/secret-check.ts echoes this table verbatim, so a
// rule that regresses a row fails the build [LAW:verifiable-goals].
//
//                          MUST ACCEPT (a real leak)              MUST REJECT (near-miss, no leak)
//  aws-access-key-id   AKIA/ASIA + 16 UPPER alnum             AKIA + 16 lowercase (a scrubbed/defused id);
//                      (AKIAIOSFODNN7EXAMPLE)                 AKIA + 15 or + 17; lowercase akia… prefix;
//                                                             a 40-hex git SHA; AKIA embedded mid-token
//  github-token        ghp_/gho_/ghu_/ghs_/ghr_ + 36 alnum    ghp_ + 35; ghz_ (unknown type letter);
//                                                             the identifier github_pat in prose/code
//  anthropic-key       sk-ant-api03-<long tail>               sk-ant alone; sk-ant- + a short tail
//  openai-key          sk-<48 alnum>; sk-proj-<long>          sk-ant-… (that is Anthropic, not OpenAI);
//                                                             "the sk- prefix" in prose; sk-<short>
//  google-api-key      AIza + 35 of [0-9A-Za-z_-]             AIza… shorter than 39 total (a prose mention)
//  jwt                 eyJ… . eyJ… . <sig>  (3 base64url)     a lone base64 blob; a 2-part a.b; base64 image data
//  private-key-block   -----BEGIN [KIND ]PRIVATE KEY-----     -----BEGIN CERTIFICATE-----; BEGIN PUBLIC KEY;
//                                                             the words "private key" in prose
//  email               jane.doe@gmail.com                     @handle (no local part); foo@bar (no TLD);
//                                                             user@example.com (RFC-2606 reserved doc domain)
//  assigned-secret     a secret-NAMED key (…password/token/    a bare `apiKey` with no value; an unquoted
//                      …api_key) + = / : + a QUOTED literal    ref (apiKey = process.env.X); a placeholder
//                      value ≥8 chars that is not a placeholder (YOUR_KEY_HERE / changeme / xxx / <key> /
//                                                              ${X}); a value < 8; secretary / tokenizer
//                                                              (noun is not the key's final token)
//
// The assigned-secret rule is the ONE generalization beyond an exact producer prefix. A bare
// high-entropy detector is intractable — its reject set (every hash, UUID, base64 blob) is
// unbounded. The tractable shape is ASSIGNMENT-ANCHORED: a secret-named key + separator + a
// QUOTED literal value. The quote is the load-bearing anchor — it rejects every env-var reference
// (apiKey = process.env.X is unquoted) by construction, collapsing the near-miss space to two
// finite families (placeholder value, too-short value) a set + a few patterns enumerate; the
// key's FINAL-token match (a \b after the noun) rejects secretary/tokenizer. It trades recall for
// bounded noise (a warn, never a block), and can co-fire with a structured rule on the same value
// — the two findings overlap and fold to one redaction downstream.

// [LAW:types-are-the-program] The kinds are a closed set — each names one producer's shape,
// so a finding's kind alone tells the consumer what was found (and, via describeSecretKind,
// how to name it) without re-deriving it from the matched text.
export type SecretKind =
  | "aws-access-key-id"
  | "github-token"
  | "anthropic-key"
  | "openai-key"
  | "google-api-key"
  | "jwt"
  | "private-key-block"
  | "email"
  | "assigned-secret";

// [LAW:one-source-of-truth] A finding is its kind and the half-open [start,end) range INTO
// THE SCANNED STRING — nothing more. The matched text is NOT carried: it is text.slice(start,
// end), a derivable copy that would let display and range drift, and echoing a secret back
// verbatim is the opposite of what a redaction feature wants. The consumer holds the string
// and decides how to mask or splice.
export interface SecretFinding {
  readonly kind: SecretKind;
  readonly start: number;
  readonly end: number;
}

// A rule mirrors one producer's shape: an anchored global pattern, plus an optional
// refinement that rejects a near-miss the regex alone still admits (the email reserved-domain
// exclusion). Most reject rows are defeated inside the pattern (word boundaries, a negative
// lookahead); `accept` is the escape hatch for the ones a single regex cannot express.
interface SecretRule {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
  readonly accept?: (match: string) => boolean;
}

// RFC 2606 / RFC 6761 reserved domains: an address here is documentation, not a person's
// contact, so it is a near-miss the email pattern would otherwise flag as PII.
const RESERVED_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net", "example.edu"]);
const RESERVED_EMAIL_TLDS = new Set(["test", "example", "invalid", "localhost"]);
const isRealEmail = (match: string): boolean => {
  const domain = match.slice(match.lastIndexOf("@") + 1).toLowerCase();
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return !RESERVED_EMAIL_DOMAINS.has(domain) && !RESERVED_EMAIL_TLDS.has(tld);
};

// [LAW:types-are-the-program] A hardcoded credential has no fixed alphabet, so it cannot be
// anchored on a producer prefix like the rules above. The tractable theorem is the ASSIGNMENT: a
// secret-named key bound to a QUOTED literal value. The quote makes the reject set bounded — an
// env-var reference or bare identifier is unquoted and fails the pattern outright, so the only
// near-misses the predicate must still reject are placeholder and too-short values, both finite.
const ASSIGNED_SECRET_MIN_LENGTH = 8;

// Values that NAME a secret slot instead of holding one. Compared after lowercasing and stripping
// separators so YOUR-API-KEY, your_api_key and yourApiKey collapse to one entry. Kept in sync with
// the reject rows in scripts/secret-check.ts [LAW:verifiable-goals].
// The secret NOUNS (secret/password/token/apikey/key) are deliberately NOT here: a value that IS
// its own noun (password = "password") is a weak real credential worth warning on, not a slot the
// author means to replace, and the noun would also swallow an obfuscated form (p.a.s.s.w.o.r.d
// normalizes to "password"). Min length rejects the short noun values; these are the words that
// genuinely name a slot.
const PLACEHOLDER_SECRET_VALUES = new Set([
  "changeme", "change", "placeholder", "example", "sample", "dummy", "redacted", "todo", "tbd",
  "fixme", "none", "null", "nil", "na", "test", "testing", "value", "string", "default",
  "yourkey", "yourapikey", "yoursecret", "yourtoken", "yourpassword", "yourpasswd",
  "yourkeyhere", "yourapikeyhere", "yoursecrethere", "yourtokenhere", "yourpasswordhere",
  "yourpasswdhere", "insertkeyhere", "replaceme",
  "foo", "bar", "foobar", "abc", "xxx", "yyy",
]);

// A quoted assignment value is a PLACEHOLDER (not a leak) when it names a slot, is WHOLLY a
// template/reference envelope (${VAR} / {{VAR}} / <your-key> / $VAR), an ellipsis, a your…here
// token, a single repeated char, or a WHOLE-value env-var reference. Every arm is anchored on the
// WHOLE value (a Set.has exact, or a ^…$ regex) so a real credential that merely CONTAINS one of
// these shapes — Pa{ss}word99 (brace), PutYourTokenHereNow (your…here substring), or
// process.env.X;realpass (reference prefix) — is still flagged. Matching any of them mid-value
// would silently drop a real leak [LAW:no-silent-failure]. Each arm is one reject family from the
// shape table.
const TEMPLATE_ENVELOPE = /^(?:\$\{[^}]*\}|\{\{.*\}\}|<[^>]*>|\$[A-Za-z_]\w*)$/;
// The tail admits property, subscript, AND method-call access (os.environ.get('K', 'D')) of the
// SUPPORTED roots — a value that is wholly one of these is a reference, not a literal. New roots
// (os.getenv, System.getenv, …) are an unbounded set the generic detector deliberately scopes out:
// their fallout is a dismissible warn, the design's accepted bounded noise, never a missed leak.
const ENV_REFERENCE = /^(?:process\.env|import\.meta\.env|os\.environ)(?:[.[(][\w.[\](),'"\s]*)?$/i;
const isPlaceholderSecretValue = (value: string): boolean => {
  const normalized = value.toLowerCase().replace(/[\s_.-]/g, "");
  return (
    PLACEHOLDER_SECRET_VALUES.has(normalized) ||
    /^(.)\1*$/.test(value) ||
    TEMPLATE_ENVELOPE.test(value) ||
    /^(?:\.{3,}|…+)$/.test(value) ||
    // Fill-me-in template ("insert your key here" and its siblings), tested against the NORMALIZED
    // value so it is delimiter-insensitive for free — INSERT_YOUR_KEY_HERE, INSERT-YOUR-KEY-HERE and
    // insertyourkeyhere collapse to one form [LAW:single-enforcer], no bespoke word boundary needed.
    /^(?:your|insert|replace|put|add|enter|paste|fill).*here$/.test(normalized) ||
    ENV_REFERENCE.test(value)
  );
};

// [LAW:no-defensive-null-guards] The rule matches the WHOLE `key = "value"` assignment, so accept
// re-extracts the trailing quoted value the pattern guarantees is there; the `!== undefined` is not
// a defensive guard but part of the accept-set ("has a real quoted value AND it is long and not a
// placeholder"). Real iff it clears the min length and is not a named/template/reference slot.
const isRealAssignedSecret = (match: string): boolean => {
  const value = /(['"])((?:(?!\1)[^\n])+)\1$/.exec(match)?.[2];
  return value !== undefined && value.length >= ASSIGNED_SECRET_MIN_LENGTH && !isPlaceholderSecretValue(value);
};

const SECRET_RULES: ReadonlyArray<SecretRule> = [
  // AWS access key ids are exactly AKIA/ASIA + 16 UPPERCASE alnum. \b at both ends rejects
  // an embedded or over-long run; the uppercase class rejects a scrubbed lowercase id.
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // GitHub tokens: a known type letter, then exactly 36 alnum. \b rejects short/long tails;
  // the [posru] class rejects an unknown type letter and the bare `github_pat` identifier.
  { kind: "github-token", pattern: /\bgh[posru]_[A-Za-z0-9]{36}\b/g },
  // Anthropic keys carry the unambiguous sk-ant- prefix and a long tail. Checked BEFORE the
  // OpenAI rule so sk-ant-… is never mis-labeled; the {24,} tail rejects a bare `sk-ant`.
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}/g },
  // OpenAI keys are sk- + a long token; the negative lookahead cedes sk-ant- to Anthropic,
  // and the {20,} minimum rejects "the sk- prefix" in prose (a space ends the run at 0).
  { kind: "openai-key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  // Google API keys are AIza + 35 of [0-9A-Za-z_-]; the fixed length rejects a prose mention.
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  // A JWT is three base64url segments with the header AND payload both base64 of `{"…` (eyJ).
  // Requiring eyJ.eyJ. rejects a lone base64 blob, a 2-part token, and base64 image data.
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // A PEM private-key header. The optional [A-Z0-9]+ words admit RSA/EC/OPENSSH/DSA variants;
  // requiring the literal "PRIVATE KEY" rejects CERTIFICATE, PUBLIC KEY, and prose.
  { kind: "private-key-block", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  // Email (PII): a local part, @, a dotted domain with a real TLD. The pattern rejects
  // @handle (no local part) and foo@bar (no TLD); isRealEmail rejects reserved doc domains.
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    accept: isRealEmail,
  },
  // A hardcoded secret assignment: a key whose FINAL token is a secret noun, a : or = separator,
  // then a QUOTED literal value. The \b after the noun makes it the key's last token, so
  // secretary/tokenizer (noun is a prefix, not the token) fail by construction; ['"]? admits a
  // JSON "key": form. The value is (?:(?!\1)[^\n])+ — content up to the CAPTURED delimiter, so a
  // double-quoted value may contain an apostrophe (and vice versa) without truncating the match.
  // Known bounded-recall limit: NOT escape-aware, so a value with a backslash-escaped copy of its
  // own delimiter (password = "val\"escaped") truncates at that quote and is dropped; escape
  // handling would need a ReDoS-safe \\.-alternation, not worth the hot-path complexity for a
  // pathological paste given this is an explicitly bounded-recall backstop.
  // It matches the WHOLE assignment — not just the value — because scrub replaces a match with an
  // inert marker, and a marker left where only the value was would sit after the key and re-trigger
  // this rule; removing the key + quotes too keeps scrub idempotent. Checked LAST: it is the broad
  // backstop and can co-fire with a structured rule on the same value (the ranges overlap and fold
  // to one redaction downstream).
  {
    kind: "assigned-secret",
    pattern:
      /\b[A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret)\b['"]?\s*[:=]\s*(['"])(?:(?!\1)[^\n])+\1/gi,
    accept: isRealAssignedSecret,
  },
];

// [LAW:no-ambient-temporal-coupling] Each scan builds a FRESH RegExp per rule, so the global
// pattern's lastIndex is never shared between calls — the scanner is pure and re-entrant, its
// result a function of the input alone, never of a previous scan's residual match position.
export const scanSecrets = (text: string): ReadonlyArray<SecretFinding> => {
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const m of text.matchAll(re)) {
      const match = m[0];
      if (rule.accept && !rule.accept(match)) continue;
      findings.push({ kind: rule.kind, start: m.index, end: m.index + match.length });
    }
  }
  // Deterministic source order for stable display and stable tests; downstream overlay
  // mergeRanges folds any overlap between two kinds into one redaction span.
  return findings.sort((a, b) => a.start - b.start || a.end - b.end);
};

// [LAW:one-source-of-truth] The human label for each kind, co-located with the kinds so a new
// kind is compiler-forced to name itself. The warn-only slice surfaces this verbatim to the
// author; keeping it here means "what do we call this leak" has one home, not a copy per UI.
export const describeSecretKind = (kind: SecretKind): string => {
  switch (kind) {
    case "aws-access-key-id":
      return "AWS access key ID";
    case "github-token":
      return "GitHub token";
    case "anthropic-key":
      return "Anthropic API key";
    case "openai-key":
      return "OpenAI API key";
    case "google-api-key":
      return "Google API key";
    case "jwt":
      return "JSON Web Token (JWT)";
    case "private-key-block":
      return "private key block";
    case "email":
      return "email address";
    case "assigned-secret":
      return "hardcoded secret";
  }
};
