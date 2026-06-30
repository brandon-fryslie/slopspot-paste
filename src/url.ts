// [LAW:single-enforcer] / [LAW:one-source-of-truth] The single home for "is this a
// canonical single-line URL token, and what is it." isUrl (parser.ts) and
// resolveProvider (providers.ts) both gate on a trimmed, single-line string before
// they parse or pattern-match it; sharing this predicate means the rule cannot
// drift between them. parser.ts and providers.ts already depend only downward
// (parser → providers → types), and this module depends on neither, so it adds no
// cycle.
//
// Rejecting EVERY character the WHATWG URL parser silently strips — tab (U+0009),
// LF (U+000A), CR (U+000D) — is the real invariant, not just "looks multi-line":
// `new URL("https://a\rb")` parses to `https://ab`, so a string containing any of
// them would be FETCHED and STORED as a different URL than its literal text. A
// `\n`-only check let a CR-only or tab-smuggled string through to be misclassified
// as a fetchable link. Forbidding the whole strip-set keeps the link we classify
// byte-identical to the link we resolve and fetch ([LAW:one-source-of-truth]).
const STRIPPED_BY_URL_PARSER = /[\t\r\n]/;

// Returns the trimmed token when it is a non-empty single-line URL candidate, or
// null when it is empty or contains a parser-stripped character. Callers layer
// their own meaning on top: isUrl parses + checks the protocol; resolveProvider
// pattern-matches against the provider registry.
export const singleLineUrl = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0 || STRIPPED_BY_URL_PARSER.test(trimmed)) return null;
  return trimmed;
};

// [LAW:one-source-of-truth] The single recognizer for a claude.ai/code session
// share link. Unlike claude.ai/share these are NOT a fetchable provider: slopspot
// cannot fetch them server-side yet (the transcript loads via an authenticated
// XHR the SPA issues only for an entitled account, behind Cloudflare — see
// slopspot-cc-share-4nc.2). The editor recognizes the shape to offer the agent-
// handoff workaround instead of a doomed fetch that would render the login wall.
// Returns the session id (the token after `session_`) when matched, else null —
// distinct from `false` so a caller can show the id without re-parsing.
const CLAUDE_CODE_SESSION_RE = /^https?:\/\/claude\.ai\/code\/session_([A-Za-z0-9_-]+)\/?(?:\?.*)?$/i;

export const claudeCodeSessionId = (input: string): string | null => {
  const url = singleLineUrl(input);
  if (url === null) return null;
  const m = CLAUDE_CODE_SESSION_RE.exec(url);
  return m === null ? null : (m[1] ?? null);
};
