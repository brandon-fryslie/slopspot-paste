import type { ParseResult, Role, Turn } from "./types";
import { parseClaudeCode } from "./parsers/cc";

// [LAW:types-are-the-program] Every parser produces the same Turn[] union.
// All variability — which export format, which header style — is absorbed at
// this boundary. Downstream code receives one shape, dispatches on `kind`.
//
// [LAW:dataflow-not-control-flow] We iterate over a fixed list of parsers and
// take the first claim. No "is this ChatGPT?" branching at callsites.

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

const HEADER_DETECTORS: ReadonlyArray<HeaderDetector> = [
  // ## User / ## Assistant / ### system  — markdown headings (most explicit)
  {
    name: "markdown-heading",
    headerPattern: /^#{1,6}\s+([A-Za-z][A-Za-z0-9 .\-]{0,40})\s*$/,
    classify: classifyLabel,
  },
  // "You said:" / "ChatGPT said:" / "Claude said:" — ChatGPT/Claude copy-paste
  {
    name: "said-marker",
    headerPattern: /^\*{0,2}([A-Za-z][A-Za-z0-9 .\-]{0,40})\s+said:?\*{0,2}\s*$/,
    classify: classifyLabel,
  },
  // "User:" / "Assistant:" / "Human:" — bare name+colon on its own line
  {
    name: "name-colon",
    headerPattern: /^\*{0,2}([A-Za-z][A-Za-z0-9 .\-]{0,40})\*{0,2}\s*:\s*$/,
    classify: classifyLabel,
  },
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

export const parsePaste = (input: string): ParseResult => {
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return { ok: false, reason: "empty input" };

  // [LAW:dataflow-not-control-flow] Parsers as values in a list; first claim wins.
  // CC is tried first because its markers (❯ ⏺ ⎿) are highly specific and won't
  // false-positive on other formats.
  const ccTurns = parseClaudeCode(text);
  if (ccTurns) return { ok: true, turns: ccTurns };

  const headerTurns = parseHeaderFormats(text);
  if (headerTurns) return { ok: true, turns: headerTurns };

  // Fallback: a single assistant turn. Better to render the whole thing than
  // reject — user can re-paste with explicit headers.
  return { ok: true, turns: [{ kind: "message", role: "assistant", content: text }] };
};

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
