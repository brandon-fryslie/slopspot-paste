import type { ParseResult, PasteInput, Role, SourceKind, Turn } from "./types";
import { MAX_PASTE_BYTES, MAX_PASTE_LABEL, SOURCE_KINDS } from "./types";
import { parseClaudeCode } from "./parsers/cc";
import { parseClaudeJsonl } from "./parsers/jsonl";
import { parseClaudeShare } from "./parsers/claude-share";
import { firecrawlScrape, type FirecrawlEnv } from "./firecrawl";

// [LAW:types-are-the-program] Every parser produces the same Turn[] union.
// All variability — which export format, which header style — is absorbed at
// this boundary. Downstream code receives one shape, dispatches on `kind`.
//
// [LAW:dataflow-not-control-flow] Per-kind dispatch is a lookup, not a
// switch — PARSER_BY_KIND maps SourceKind → parser function. `parseInput`
// is two lines: normalize, dispatch. Wrong-kind failure is a clean
// `{ ok: false }` (T2 makes wrong-kind unreachable by gating the dropdown
// with a detector); we don't silently fall back to a different parser
// because that would lie about what the user asked for.

interface HeaderDetector {
  readonly name: string;
  readonly headerPattern: RegExp;
  readonly classify: (label: string) => Role | null;
}

const ROLE_BY_LABEL: ReadonlyMap<string, Role> = new Map([
  ["user", "user"],
  ["you", "user"],
  ["human", "user"],
  ["me", "user"],
  ["assistant", "assistant"],
  ["chatgpt", "assistant"],
  ["gpt", "assistant"],
  ["gpt-4", "assistant"],
  ["gpt-5", "assistant"],
  ["claude", "assistant"],
  ["gemini", "assistant"],
  ["bot", "assistant"],
  ["ai", "assistant"],
  ["model", "assistant"],
  ["system", "system"],
  ["developer", "system"],
]);

const classifyLabel = (raw: string): Role | null => {
  const key = raw.trim().toLowerCase().replace(/[*_`]/g, "");
  if (ROLE_BY_LABEL.has(key)) return ROLE_BY_LABEL.get(key)!;
  // tolerate "GPT-4o", "Claude 3.5 Sonnet", etc. by matching just the leading word
  const leading = key.split(/[\s\-]/)[0] ?? "";
  return ROLE_BY_LABEL.get(leading) ?? null;
};

// [LAW:one-source-of-truth] Each detector is named once, lives once, and is
// referenced by both the legacy auto-race (HEADER_DETECTORS) and the per-kind
// dispatch table below. No copy of the regex anywhere else.
const MARKDOWN_HEADING_DETECTOR: HeaderDetector = {
  // ## User / ## Assistant / ### system  — markdown headings (most explicit)
  name: "markdown-heading",
  headerPattern: /^#{1,6}\s+([A-Za-z][A-Za-z0-9 .\-]{0,40})\s*$/,
  classify: classifyLabel,
};

const SAID_MARKER_DETECTOR: HeaderDetector = {
  // "You said:" / "ChatGPT said:" / "Claude said:" — ChatGPT/Claude copy-paste
  name: "said-marker",
  headerPattern: /^\*{0,2}([A-Za-z][A-Za-z0-9 .\-]{0,40})\s+said:?\*{0,2}\s*$/,
  classify: classifyLabel,
};

const NAME_COLON_DETECTOR: HeaderDetector = {
  // "User:" / "Assistant:" / "Human:" — bare name+colon on its own line
  name: "name-colon",
  headerPattern: /^\*{0,2}([A-Za-z][A-Za-z0-9 .\-]{0,40})\*{0,2}\s*:\s*$/,
  classify: classifyLabel,
};

const HEADER_DETECTORS: ReadonlyArray<HeaderDetector> = [
  MARKDOWN_HEADING_DETECTOR,
  SAID_MARKER_DETECTOR,
  NAME_COLON_DETECTOR,
];

const trySplitByHeaders = (
  lines: ReadonlyArray<string>,
  detector: HeaderDetector,
): Turn[] | null => {
  const splits: Array<{ role: Role; headerLine: number; start: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = detector.headerPattern.exec(lines[i]!);
    if (!m) continue;
    const role = detector.classify(m[1]!);
    if (!role) continue;
    splits.push({ role, headerLine: i, start: i + 1 });
  }
  if (splits.length < 2) return null;

  const turns: Turn[] = [];
  for (let i = 0; i < splits.length; i++) {
    const cur = splits[i]!;
    const next = splits[i + 1];
    const end = next ? next.headerLine : lines.length;
    const body = lines
      .slice(cur.start, end)
      .join("\n")
      .replace(/^\s+|\s+$/g, "");
    if (body.length === 0) continue;
    turns.push({ kind: "message", role: cur.role, content: body });
  }
  return turns.length >= 2 ? turns : null;
};

const parseHeaderFormats = (text: string): Turn[] | null => {
  const lines = text.split("\n");
  for (const detector of HEADER_DETECTORS) {
    const turns = trySplitByHeaders(lines, detector);
    if (turns) return turns;
  }
  return null;
};

// [LAW:dataflow-not-control-flow] Per-kind parsing is a table lookup. Each
// entry takes normalized text and returns the parser's claim — Turn[] when it
// fits, null when it doesn't. The dispatch in parseInput is two lines.
const parseSingleDetector =
  (detector: HeaderDetector) =>
  (text: string): Turn[] | null =>
    trySplitByHeaders(text.split("\n"), detector);

const parseRaw = (text: string): Turn[] => [
  { kind: "message", role: "assistant", content: text },
];

// Text arms only — claude-share is excluded because it has no synchronous
// (text: string) => Turn[] interpretation; its ingest path is async and
// lives in ingestPaste below. Keeping this table strictly typed prevents a
// future contributor from wiring claude-share into the sync dispatch.
type TextArmKind = Exclude<SourceKind, "claude-share">;

const PARSER_BY_KIND: {
  readonly [K in TextArmKind]: (text: string) => Turn[] | null;
} = {
  "claude-jsonl": parseClaudeJsonl,
  "claude-code": parseClaudeCode,
  "chatgpt": parseSingleDetector(SAID_MARKER_DETECTOR),
  "claude-paste": parseSingleDetector(NAME_COLON_DETECTOR),
  "markdown": parseSingleDetector(MARKDOWN_HEADING_DETECTOR),
  "raw": parseRaw,
};

const normalize = (input: string): string => input.replace(/\r\n?/g, "\n").trim();

// [LAW:types-are-the-program] parseInput commits to the kind the caller named.
// No silent fallback to a different parser — a wrong pick is a typed failure.
// The T2 detector (detectSources, below) makes wrong picks unreachable from
// the UI by populating the dropdown only with kinds that actually parse.
//
// [LAW:single-enforcer] URL ingestion is genuinely async (Firecrawl fetch).
// Rather than poison this signature with a Promise return for every arm,
// claude-share gets a typed redirect to `ingestPaste`. Callers that want a
// uniform async surface use ingestPaste; callers that only care about text
// arms (parser-check tests, detector) use parseInput.
export const parseInput = (input: PasteInput): ParseResult => {
  if (input.kind === "claude-share") {
    return {
      ok: false,
      reason: "claude-share is a URL arm; use ingestPaste() to fetch and parse.",
    };
  }
  // input is narrowed to the content-bearing arms here (claude-share returned
  // above), so no cast is needed — a future URL-shaped arm would fail to compile.
  const text = normalize(input.content);
  if (text.length === 0) return { ok: false, reason: "empty input" };
  const turns = PARSER_BY_KIND[input.kind](text);
  if (turns === null || turns.length === 0) {
    return {
      ok: false,
      reason: `Content does not parse as ${input.kind}.`,
    };
  }
  return { ok: true, turns };
};

// [LAW:single-enforcer] The one entry point that does network I/O for
// PasteInput. Text arms pass straight through to parseInput; the URL arm
// fetches via Firecrawl and parses the returned markdown. The API handler
// uses this so it doesn't branch on `kind` itself — `kind` discrimination
// stays inside the parser module.
export const ingestPaste = async (
  input: PasteInput,
  env: FirecrawlEnv,
): Promise<ParseResult> => {
  if (input.kind !== "claude-share") return parseInput(input);

  if (!isClaudeShareUrl(input.url)) {
    return { ok: false, reason: "Not a valid claude.ai/share URL." };
  }
  const fetched = await firecrawlScrape(input.url, env);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };
  // [LAW:single-enforcer] The same size cap that the API applies to user input
  // also governs fetched content — otherwise a tiny URL could smuggle an
  // arbitrarily large markdown body past the boundary into parse + KV storage.
  if (new TextEncoder().encode(fetched.markdown).length > MAX_PASTE_BYTES) {
    return { ok: false, reason: `Fetched content exceeds the ${MAX_PASTE_LABEL} limit.` };
  }
  const turns = parseClaudeShare(fetched.markdown);
  if (turns === null || turns.length === 0) {
    return {
      ok: false,
      reason: "Fetched the page, but could not extract a conversation.",
    };
  }
  return { ok: true, turns };
};

// [LAW:one-source-of-truth] The URL shape claude-share accepts lives here,
// once. The detector calls it; ingestPaste re-validates at the trust boundary
// (defense against a directly-crafted API request that bypassed the UI).
const CLAUDE_SHARE_RE =
  /^https?:\/\/claude\.ai\/share\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i;

export const isClaudeShareUrl = (input: string): boolean => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("\n")) return false;
  return CLAUDE_SHARE_RE.test(trimmed);
};

// [LAW:one-source-of-truth] For text arms, the detector IS the parser — it
// calls parseInput and keeps kinds that succeed. There is no separate
// "could-this-parse" heuristic for text arms; drift is structurally impossible.
//
// For claude-share, the detector necessarily diverges: a fetch on every
// keystroke would be wrong (rate-limited, slow, costs money), so the URL arm
// is recognized by pattern. The actual fetch + parse happens at submit time
// inside ingestPaste. This split is the single point where the URL/text
// asymmetry surfaces; comment it so it doesn't metastasize.
//
// [LAW:dataflow-not-control-flow] Empty input is the priming state: no text
// to classify yet, so every kind is a legitimate pre-selection for the about-
// to-be-pasted content. The return shape (a ReadonlyArray<SourceKind>) is the
// same in every case; the dropdown reads it as data and rebuilds its options.
export const detectSources = (input: string): ReadonlyArray<SourceKind> => {
  if (normalize(input).length === 0) return SOURCE_KINDS;
  return SOURCE_KINDS.filter((kind) =>
    kind === "claude-share"
      ? isClaudeShareUrl(input)
      : parseInput({ kind, content: input } as PasteInput).ok,
  );
};

// [LAW:locality-or-seam] The legacy auto-race lives behind its own seam so
// the API can use it for the no-source path (form posts that pre-date the
// dropdown, direct API callers) without re-introducing race logic into the
// per-kind dispatch above. CC tried first because its markers (❯ ⏺ ⎿) are
// highly specific and won't false-positive on other formats.
export const parseAuto = (input: string): ParseResult => {
  const text = normalize(input);
  if (text.length === 0) return { ok: false, reason: "empty input" };

  // [LAW:one-source-of-truth] The race order mirrors SOURCE_KINDS priority:
  // JSONL is the most specific (first non-blank line must be valid JSON) and
  // cheapest to rule out, so it leads — a session JSONL paste on the legacy
  // no-source path now ingests correctly instead of falling through to raw.
  const jsonlTurns = parseClaudeJsonl(text);
  if (jsonlTurns) return { ok: true, turns: jsonlTurns };

  const ccTurns = parseClaudeCode(text);
  if (ccTurns) return { ok: true, turns: ccTurns };

  const headerTurns = parseHeaderFormats(text);
  if (headerTurns) return { ok: true, turns: headerTurns };

  return { ok: true, turns: parseRaw(text) };
};

// Aliased so imports that pre-date the per-kind API (parser-check tests, any
// in-flight branches) keep compiling. New callers use parseInput / parseAuto.
export const parsePaste = parseAuto;

// [LAW:one-source-of-truth] Title is derived from the first user message
// (or the first message of any role if no user turn exists). Tool calls and
// turn-summary events are skipped — they don't carry conversational content.
export const deriveTitle = (turns: ReadonlyArray<Turn>): string | null => {
  const messages = turns.filter(
    (t): t is Extract<Turn, { kind: "message" }> => t.kind === "message",
  );
  const firstUser = messages.find((t) => t.role === "user") ?? messages[0];
  if (!firstUser) return null;
  const firstLine = firstUser.content.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const stripped = firstLine.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
  return stripped.length > 80 ? stripped.slice(0, 77) + "…" : stripped;
};
