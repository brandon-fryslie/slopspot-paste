import type { ParseResult, PasteInput, Role, SourceKind, Turn } from "./types";
import { SOURCE_KINDS } from "./types";
import { parseClaudeCode } from "./parsers/cc";
import { parseClaudeJsonl } from "./parsers/jsonl";

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

const PARSER_BY_KIND: {
  readonly [K in SourceKind]: (text: string) => Turn[] | null;
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
export const parseInput = (input: PasteInput): ParseResult => {
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

// [LAW:one-source-of-truth] The detector IS the parser. It calls parseInput
// for each SourceKind and keeps the ones that succeed. There is no separate
// "could-this-parse" heuristic — that would be a second source of truth that
// could drift from the real parser. Drift is structurally impossible here.
//
// [LAW:dataflow-not-control-flow] Empty input is the priming state: no text
// to classify yet, so every kind is a legitimate pre-selection for the about-
// to-be-pasted content. The return shape (a ReadonlyArray<SourceKind>) is the
// same in every case; the dropdown reads it as data and rebuilds its options.
export const detectSources = (input: string): ReadonlyArray<SourceKind> => {
  if (normalize(input).length === 0) return SOURCE_KINDS;
  return SOURCE_KINDS.filter((kind) => parseInput({ kind, content: input }).ok);
};

// [LAW:locality-or-seam] The legacy auto-race lives behind its own seam so
// the API can use it for the no-source path (form posts that pre-date the
// dropdown, direct API callers) without re-introducing race logic into the
// per-kind dispatch above. CC tried first because its markers (❯ ⏺ ⎿) are
// highly specific and won't false-positive on other formats.
export const parseAuto = (input: string): ParseResult => {
  const text = normalize(input);
  if (text.length === 0) return { ok: false, reason: "empty input" };

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
