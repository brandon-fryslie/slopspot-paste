import type { ParseResult, Role, Turn } from "./types";

// [LAW:types-are-the-program] Input is plain text; output is typed Turn[].
// All variability — which export format, which header style — is absorbed at this
// boundary. Downstream code receives the same shape every time.
// [LAW:dataflow-not-control-flow] We try patterns by *iterating* over a fixed list
// of detectors; we don't branch on "is this ChatGPT?" — each detector inspects the
// value and either claims it or yields, and the first claim wins.

interface Detector {
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

const DETECTORS: ReadonlyArray<Detector> = [
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

interface Split {
  readonly role: Role;
  readonly start: number; // line index where content begins
}

const trySplit = (lines: ReadonlyArray<string>, detector: Detector): Turn[] | null => {
  const splits: Array<Split & { headerLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = detector.headerPattern.exec(lines[i]!);
    if (!m) continue;
    const role = detector.classify(m[1]!);
    if (!role) continue;
    splits.push({ role, headerLine: i, start: i + 1 });
  }
  if (splits.length < 2) return null; // need at least two turns to call it a conversation

  const turns: Turn[] = [];
  for (let i = 0; i < splits.length; i++) {
    const cur = splits[i]!;
    const next = splits[i + 1];
    const end = next ? next.headerLine : lines.length;
    const body = lines.slice(cur.start, end).join("\n").replace(/^\s+|\s+$/g, "");
    if (body.length === 0) continue;
    turns.push({ role: cur.role, content: body });
  }
  return turns.length >= 2 ? turns : null;
};

export const parsePaste = (input: string): ParseResult => {
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return { ok: false, reason: "empty input" };

  const lines = text.split("\n");
  for (const detector of DETECTORS) {
    const turns = trySplit(lines, detector);
    if (turns) return { ok: true, turns };
  }

  // Fallback: a single assistant turn. Better to render the whole thing
  // than reject — user can re-paste with explicit headers.
  return { ok: true, turns: [{ role: "assistant", content: text }] };
};

// [LAW:one-source-of-truth] Title is derived from the first user turn's first line,
// or null. Not stored as a separate concept the user maintains.
export const deriveTitle = (turns: ReadonlyArray<Turn>): string | null => {
  const firstUser = turns.find((t) => t.role === "user") ?? turns[0];
  if (!firstUser) return null;
  const firstLine = firstUser.content.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const stripped = firstLine.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
  return stripped.length > 80 ? stripped.slice(0, 77) + "…" : stripped;
};
