// Secret/PII scanner checks (slopspot-secret-guard-4zw.2). Run: `tsx scripts/secret-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. This file IS the
// accept/reject shape table from src/secret-scan.ts made executable: every ACCEPT row must
// produce a finding of the stated kind at the stated range, and every REJECT row (a near-miss
// that shares tokens but not the shape) must produce NO finding of the tempting kind. A rule
// that regresses a row fails the build [LAW:verifiable-goals], [LAW:types-are-the-program].
//
// The values below are synthetic but shaped like the real producers (the capture-fixture
// scrub proves the technique). None is a live credential.

import { scanSecrets, describeSecretKind, type SecretFinding, type SecretKind } from "../src/secret-scan";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const findingsOfKind = (findings: ReadonlyArray<SecretFinding>, kind: SecretKind): ReadonlyArray<SecretFinding> =>
  findings.filter((f) => f.kind === kind);

// ── ACCEPT: a real leak, found at its exact range ────────────────────────────
// `secret` is the exact substring the scanner must flag; asserting the sliced range === secret
// verifies the offset contract (a finding indexes into the GIVEN string) the redaction slice
// depends on, not merely that "something matched".
interface AcceptCase {
  readonly label: string;
  readonly text: string;
  readonly kind: SecretKind;
  readonly secret: string;
}

const ACCEPT: ReadonlyArray<AcceptCase> = [
  // aws-access-key-id — AKIA/ASIA + 16 UPPERCASE alnum
  { label: "AWS AKIA id (AWS's own doc example)", text: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE", kind: "aws-access-key-id", secret: "AKIAIOSFODNN7EXAMPLE" },
  { label: "AWS ASIA temporary id", text: "export KEY=ASIAY34FZKBOKMUTVV7A here", kind: "aws-access-key-id", secret: "ASIAY34FZKBOKMUTVV7A" },
  // github-token — known type letter + 36 alnum
  { label: "GitHub ghp_ classic PAT", text: "token: ghp_0123456789abcdefghijABCDEFGHIJ012345", kind: "github-token", secret: "ghp_0123456789abcdefghijABCDEFGHIJ012345" },
  { label: "GitHub gho_ oauth token", text: "gho_0123456789abcdefghijABCDEFGHIJ012345", kind: "github-token", secret: "gho_0123456789abcdefghijABCDEFGHIJ012345" },
  // anthropic-key — sk-ant- + long tail
  { label: "Anthropic sk-ant- key", text: "ANTHROPIC_API_KEY=sk-ant-api03-A0b1C2d3E4f5G6h7I8j9K0l1M2n3O4p5", kind: "anthropic-key", secret: "sk-ant-api03-A0b1C2d3E4f5G6h7I8j9K0l1M2n3O4p5" },
  // openai-key — sk- + long token (classic and project)
  { label: "OpenAI sk- classic key", text: "OPENAI_API_KEY=sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL", kind: "openai-key", secret: "sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL" },
  { label: "OpenAI sk-proj- project key", text: "sk-proj-Ab0Cd1Ef2Gh3Ij4Kl5Mn6Op7Qr8St9Uv0Wx1Yz", kind: "openai-key", secret: "sk-proj-Ab0Cd1Ef2Gh3Ij4Kl5Mn6Op7Qr8St9Uv0Wx1Yz" },
  // google-api-key — AIza + 35
  { label: "Google AIza API key", text: "key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456&cb=1", kind: "google-api-key", secret: "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456" },
  // jwt — three base64url segments, header + payload both eyJ
  { label: "JWT (HS256)", text: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", kind: "jwt", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c" },
  // private-key-block — BEGIN [KIND ]PRIVATE KEY
  { label: "PEM RSA private key header", text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...", kind: "private-key-block", secret: "-----BEGIN RSA PRIVATE KEY-----" },
  { label: "PEM OPENSSH private key header", text: "-----BEGIN OPENSSH PRIVATE KEY-----", kind: "private-key-block", secret: "-----BEGIN OPENSSH PRIVATE KEY-----" },
  { label: "PEM unadorned private key header", text: "-----BEGIN PRIVATE KEY-----", kind: "private-key-block", secret: "-----BEGIN PRIVATE KEY-----" },
  // email (PII) — local @ dotted-domain with a real TLD
  { label: "email address (gmail)", text: "reach me at jane.doe@gmail.com anytime", kind: "email", secret: "jane.doe@gmail.com" },
  { label: "email address (multi-label TLD)", text: "first.last@company.co.uk", kind: "email", secret: "first.last@company.co.uk" },
  // assigned-secret — secret-named key + = / : + a quoted literal ≥8 chars; the finding spans the
  // WHOLE assignment (so scrub removes the key+quotes and the marker cannot re-trigger the rule).
  { label: "api_key = quoted literal (= sep, double quote)", text: `api_key = "a1b2c3d4e5f6g7h8"`, kind: "assigned-secret", secret: `api_key = "a1b2c3d4e5f6g7h8"` },
  { label: "password: quoted literal (colon sep, YAML style)", text: `password: "s3cr3tP@ssw0rd99"`, kind: "assigned-secret", secret: `password: "s3cr3tP@ssw0rd99"` },
  { label: "client_secret quoted (single quote, no spaces)", text: `client_secret='Xk9Lm2Qp7Rt4Zw8Bv'`, kind: "assigned-secret", secret: `client_secret='Xk9Lm2Qp7Rt4Zw8Bv'` },
  { label: "prefixed uppercase key AUTH_TOKEN (token is final token)", text: `AUTH_TOKEN = "ghijklmnop1234567890"`, kind: "assigned-secret", secret: `AUTH_TOKEN = "ghijklmnop1234567890"` },
  { label: "db_password (prefix, no spaces around =)", text: `db_password="hunter2hunter2hunter2"`, kind: "assigned-secret", secret: `db_password="hunter2hunter2hunter2"` },
  { label: "camelCase apiKey (api[_-]?key matches under i-flag)", text: `apiKey = "aVeryLongRandomValue12"`, kind: "assigned-secret", secret: `apiKey = "aVeryLongRandomValue12"` },
  // A real password that merely CONTAINS a template char is a leak, not a placeholder — the
  // envelope reject is anchored on the whole value, so a brace mid-value does not drop it.
  { label: "a real password containing braces is flagged (not treated as a template)", text: `password = "Pa{ss}word9900xk"`, kind: "assigned-secret", secret: `password = "Pa{ss}word9900xk"` },
  // Min-length boundary: exactly 8 chars is the accept edge (7 rejects, below in the REJECT table).
  { label: "a value of exactly the minimum length (8) is accepted", text: `token = "aB3xK9mP"`, kind: "assigned-secret", secret: `token = "aB3xK9mP"` },
  // A value that merely CONTAINS a your…here / reference / apostrophe is a real leak, not a
  // placeholder — every placeholder arm is whole-value anchored, so embedded shapes stay flagged.
  { label: "an embedded Your...Here inside a real secret is flagged (not a template)", text: `password = "PutYourTokenHereNow91234"`, kind: "assigned-secret", secret: `password = "PutYourTokenHereNow91234"` },
  { label: "a reference prefix with a real secret appended is flagged", text: `api_key = "process.env.API_KEY;realPassw0rd"`, kind: "assigned-secret", secret: `api_key = "process.env.API_KEY;realPassw0rd"` },
  { label: "a double-quoted value containing an apostrophe is not truncated", text: `token = "it's a longsecret12"`, kind: "assigned-secret", secret: `token = "it's a longsecret12"` },
  { label: "a weak credential whose value IS the noun (password) is flagged", text: `password = "password"`, kind: "assigned-secret", secret: `password = "password"` },
];

// ── REJECT: a near-miss that shares tokens but not the shape ──────────────────
interface RejectCase {
  readonly label: string;
  readonly text: string;
  readonly forbid: SecretKind;
}

const REJECT: ReadonlyArray<RejectCase> = [
  // aws-access-key-id near-misses
  { label: "scrubbed/defused AWS id (16 lowercase) is not a leak", text: "AKIAxxxxxxxxxxxxxxxx", forbid: "aws-access-key-id" },
  { label: "AWS prefix + only 15 chars is too short", text: "AKIAIOSFODNN7EXAMPL", forbid: "aws-access-key-id" },
  { label: "AWS prefix + 17 chars is over-long (part of a bigger token)", text: "AKIAIOSFODNN7EXAMPLEE", forbid: "aws-access-key-id" },
  { label: "AKIA embedded mid-token is not a key", text: "XXAKIAIOSFODNN7EXAMPLE", forbid: "aws-access-key-id" },
  // github-token near-misses
  { label: "GitHub token + only 35 chars is too short", text: "ghp_0123456789abcdefghijABCDEFGHIJ01234", forbid: "github-token" },
  { label: "GitHub unknown type letter ghz_ is not a token", text: "ghz_0123456789abcdefghijABCDEFGHIJ012345", forbid: "github-token" },
  { label: "the identifier github_pat in code is not a token", text: "const github_pat = readEnv('GH');", forbid: "github-token" },
  // anthropic-key near-misses
  { label: "the bare word sk-ant in prose is not a key", text: "install the sk-ant SDK from npm", forbid: "anthropic-key" },
  { label: "sk-ant- with a short tail is not a key", text: "sk-ant-xyz", forbid: "anthropic-key" },
  // openai-key near-misses
  { label: "the sk- prefix mentioned in prose is not a key", text: "OpenAI keys use the sk- prefix", forbid: "openai-key" },
  { label: "sk- + a short tail is not a key", text: "sk-abc123", forbid: "openai-key" },
  // google-api-key near-miss
  { label: "AIza mentioned short in prose is not a key", text: "keys look like AIzaSy... in the docs", forbid: "google-api-key" },
  // jwt near-misses
  { label: "a lone base64 segment is not a JWT", text: "eyJhbGciOiJIUzI1NiJ9", forbid: "jwt" },
  { label: "a two-part token a.b is not a JWT", text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9", forbid: "jwt" },
  // private-key-block near-misses (public material / prose)
  { label: "a CERTIFICATE block is public, not a private key", text: "-----BEGIN CERTIFICATE-----", forbid: "private-key-block" },
  { label: "a PUBLIC KEY block is not a private key", text: "-----BEGIN PUBLIC KEY-----", forbid: "private-key-block" },
  { label: "the words 'private key' in prose are not a block", text: "keep your private key somewhere safe", forbid: "private-key-block" },
  // email near-misses
  { label: "a bare @handle has no local part", text: "thanks @octocat for the fix", forbid: "email" },
  { label: "an npm scope @scope/pkg is not an email", text: "npm i @acme/widgets", forbid: "email" },
  { label: "no-TLD foo@bar is not a full address", text: "the token foo@bar is internal", forbid: "email" },
  { label: "a reserved doc domain (example.com) is not PII", text: "email user@example.com in the sample", forbid: "email" },
  // assigned-secret near-misses — each perturbs ONE invariant while holding the rest.
  // (no value / bare identifier)
  { label: "a bare identifier named apiKey with no value is not a leak", text: "const apiKey = readConfig();", forbid: "assigned-secret" },
  { label: "apiKey mentioned in prose with no assignment", text: "set your apiKey before calling the API", forbid: "assigned-secret" },
  // (unquoted RHS — the quote anchor rejects references and expressions by construction)
  { label: "an env-var reference (unquoted) is not a hardcoded secret", text: "apiKey = process.env.API_KEY", forbid: "assigned-secret" },
  { label: "a function-call value (unquoted) is not a hardcoded secret", text: "token = getToken()", forbid: "assigned-secret" },
  { label: "a variable value (unquoted) is not a hardcoded secret", text: "password = userSuppliedInput", forbid: "assigned-secret" },
  // (placeholder value — names a slot, does not hold one)
  { label: "the placeholder YOUR_KEY_HERE is not a leak", text: `api_key = "YOUR_KEY_HERE"`, forbid: "assigned-secret" },
  { label: "the placeholder changeme is not a leak", text: `password = "changeme"`, forbid: "assigned-secret" },
  { label: "the placeholder xxx is not a leak", text: `token = "xxx"`, forbid: "assigned-secret" },
  { label: "an angle-bracket template <your-api-key> is not a leak", text: `api_key = "<your-api-key>"`, forbid: "assigned-secret" },
  { label: "a shell template ${API_KEY} is not a leak", text: `secret = "\${API_KEY}"`, forbid: "assigned-secret" },
  { label: "a mustache template {{token}} is not a leak", text: `token = "{{token}}"`, forbid: "assigned-secret" },
  { label: "a bare $VAR shell reference is not a leak", text: `secret = "$MY_SECRET_VALUE"`, forbid: "assigned-secret" },
  { label: "an ellipsis placeholder is not a leak", text: `api_key = "..."`, forbid: "assigned-secret" },
  { label: "a quoted env-var reference is still a reference, not a leak", text: `apiKey = "process.env.API_KEY"`, forbid: "assigned-secret" },
  // JSON-form placeholders: the value extraction is $-anchored, so the key-closing quote is never
  // taken as the value delimiter — the placeholder predicate sees the value, not ": value".
  { label: "JSON-form placeholder YOUR_KEY_HERE is rejected", text: `{"api_secret": "YOUR_KEY_HERE"}`, forbid: "assigned-secret" },
  { label: "JSON-form placeholder changeme is rejected", text: `{"api_secret": "changeme"}`, forbid: "assigned-secret" },
  { label: "JSON-form quoted env reference is rejected", text: `{"api_secret": "process.env.KEY"}`, forbid: "assigned-secret" },
  // (too-short value)
  { label: "a value shorter than the minimum is not a leak", text: `token = "abc"`, forbid: "assigned-secret" },
  { label: "a value one below the minimum (7 chars) is rejected at the boundary", text: `token = "aB3xK9m"`, forbid: "assigned-secret" },
  { label: "an empty quoted value is not a leak", text: `api_key = ""`, forbid: "assigned-secret" },
  // (key is not secret-named, or the noun is not the key's FINAL token)
  { label: "a non-secret key (username) is not flagged on its value", text: `username = "john_the_admin_user"`, forbid: "assigned-secret" },
  { label: "secretary — secret is a prefix, not the key's final token", text: `secretary = "the office manager name"`, forbid: "assigned-secret" },
  { label: "tokenizer — token is a prefix, not the key's final token", text: `tokenizer = "bert-base-uncased-01"`, forbid: "assigned-secret" },
  { label: "password_length — password is not the key's final token", text: `password_length = "twenty-characters"`, forbid: "assigned-secret" },
];

// ── ZERO: high-entropy content that resembles NOTHING must produce no finding ─
const ZERO: ReadonlyArray<{ readonly label: string; readonly text: string }> = [
  { label: "a 40-hex git SHA trips nothing", text: "9f2a1c3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90" },
  { label: "a UUID trips nothing", text: "550e8400-e29b-41d4-a716-446655440000" },
  {
    label: "a base64 PNG data URI trips nothing",
    text: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  },
];

console.log("secret-check: ACCEPT rows (a real leak, found at its exact range)");
for (const c of ACCEPT) {
  const found = findingsOfKind(scanSecrets(c.text), c.kind);
  const exact = found.some((f) => c.text.slice(f.start, f.end) === c.secret);
  assert(`${describeSecretKind(c.kind)}: ${c.label}`, exact);
}

console.log("secret-check: REJECT rows (a near-miss must NOT be flagged)");
for (const c of REJECT) {
  const found = findingsOfKind(scanSecrets(c.text), c.forbid);
  assert(`${describeSecretKind(c.forbid)}: ${c.label}`, found.length === 0);
}

console.log("secret-check: ZERO rows (resembles no producer)");
for (const c of ZERO) {
  assert(c.label, scanSecrets(c.text).length === 0);
}

// ── DISAMBIGUATION: sk-ant- is Anthropic ONLY, never also OpenAI ─────────────
// The single sharpest enumeration gap: two producers share the sk- stem. The negative
// lookahead must cede sk-ant- to Anthropic with zero OpenAI double-count.
{
  const text = "key=sk-ant-api03-A0b1C2d3E4f5G6h7I8j9K0l1M2n3O4p5";
  const all = scanSecrets(text);
  assert("sk-ant- yields exactly one Anthropic finding", findingsOfKind(all, "anthropic-key").length === 1);
  assert("sk-ant- yields ZERO OpenAI findings (no double-count)", findingsOfKind(all, "openai-key").length === 0);
}

// ── MIXED: many secrets + near-misses in one blob, each found once ───────────
// Proves the scanner composes over realistic multi-line content, in source order, without a
// near-miss leaking through or a real secret being masked by an adjacent one.
{
  const blob = [
    "# config",
    "aws_key = AKIAIOSFODNN7EXAMPLE   # real",
    "defused = AKIAxxxxxxxxxxxxxxxx    # scrubbed, ignore",
    "openai  = sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL",
    "contact = jane.doe@gmail.com",
    "docs    = user@example.com       # reserved, ignore",
    "sha     = 9f2a1c3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90",
  ].join("\n");
  const kinds = scanSecrets(blob).map((f) => f.kind);
  assert("mixed blob finds the AWS key", kinds.includes("aws-access-key-id"));
  assert("mixed blob finds the OpenAI key", kinds.includes("openai-key"));
  assert("mixed blob finds the real email", kinds.includes("email"));
  assert("mixed blob finds exactly 3 secrets (near-misses ignored)", scanSecrets(blob).length === 3);
  // Findings are in source order — the sort contract downstream redaction relies on.
  const starts = scanSecrets(blob).map((f) => f.start);
  assert("mixed blob findings are sorted by start", starts.every((s, i) => i === 0 || starts[i - 1]! <= s));
}

// ── ASSIGNED-SECRET: JSON-quoted key + whole-assignment range contract ────────
// A JSON `"key": "value"` form (the key itself quoted) is caught — the optional key-closing quote
// in the pattern admits it. And the finding spans the WHOLE assignment, not just the value: scrub
// relies on this so its inert marker replaces the key + quotes and cannot re-trigger the rule.
{
  const json = `{"api_secret": "longsecretvalue1234"}`;
  const found = findingsOfKind(scanSecrets(json), "assigned-secret");
  assert("JSON-quoted secret key is flagged", found.length === 1);
  assert("finding spans the whole key:value assignment, not just the value", json.slice(found[0]!.start, found[0]!.end) === `api_secret": "longsecretvalue1234"`);
}

// Empty input is the identity: no text, no findings — the honest zero, not a crash.
assert("empty string yields no findings", scanSecrets("").length === 0);

console.log("secret-check complete");
