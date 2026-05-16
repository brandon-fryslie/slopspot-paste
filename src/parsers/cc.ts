import type { Turn, ToolOutputKind } from "../types";

// [LAW:types-are-the-program] Input is the raw text of a Claude Code transcript;
// output is the same Turn[] union every other parser converges to. The "is this
// CC?" question is answered by structural matching, not a flag.
//
// [LAW:dataflow-not-control-flow] A line-walk state machine: classify each line
// by its leading marker, *flush* the in-progress event, start a new one. The
// rendering downstream operates on the resulting flat array of typed events.

// Markers in Claude Code's rendered output:
//   ❯           — user prompt
//   ⏺           — assistant/tool event
//   ⎿           — tool output chunk
//   ★ Insight   — inline insight (always preceded by ⏺)
//   spinner+    — turn-done footer ("✻ Sautéed for 53s"; glyph varies)

const USER_RE = /^❯\s*(.*)$/u;
const INSIGHT_OPEN_RE = /^⏺\s+★\s*Insight\s*─*\s*$/u;
const INSIGHT_CLOSE_RE = /^\s*─{3,}\s*$/u;
const TOOL_CALL_RE = /^⏺\s+([A-Za-z][\w-]*)\(/u;
const ASSIST_RE = /^⏺\s+(.+)$/u;
const CALLED_MCP_RE = /^\s+Called\s+([\w@.\-]+)\s*\(/u;
const OUTPUT_LINE_RE = /^\s{0,4}⎿\s?(.*)$/u;
// Spinner-glyph + gerund + duration. Glyph is any single non-letter/digit/space
// character (✻ ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏ ★ ⚙ etc). Gerund allows accented letters
// ("Sautéed", "Pondering", "Whisking", "…"). Duration: number+unit pairs.
const TURN_SUMMARY_RE =
  /^([^A-Za-z0-9\s])\s+([A-Z][\p{L}…]+)\s+for\s+(\d+[smhd](?:\d+[smhd])*)\s*$/u;

const isMarker = (line: string): boolean =>
  USER_RE.test(line) ||
  /^⏺\s/u.test(line) ||
  CALLED_MCP_RE.test(line) ||
  TURN_SUMMARY_RE.test(line);

const TOOL_OUTPUT_KIND: ReadonlyMap<string, ToolOutputKind> = new Map([
  ["Bash", "terminal"],
  ["Shell", "terminal"],
  ["Read", "file-read"],
  ["NotebookRead", "file-read"],
]);

const outputKindFor = (tool: string): ToolOutputKind =>
  TOOL_OUTPUT_KIND.get(tool) ?? "generic";

const countParens = (s: string): number => {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth;
};

const stripIndent = (s: string, n: number): string =>
  s.startsWith(" ".repeat(n)) ? s.slice(n) : s.replace(/^\s*/, "");

interface CollectResult {
  readonly content: string;
  readonly next: number;
}

// Continuation lines for a message body: everything up to the next marker.
// Blank lines stay in the body — markdown will rejoin paragraphs naturally.
const collectBody = (
  lines: ReadonlyArray<string>,
  startIdx: number,
  initial: string,
): CollectResult => {
  const parts = initial ? [initial] : [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isMarker(line)) break;
    parts.push(line);
    i++;
  }
  // Strip leading 2-space indent CC adds to body lines so markdown lists/bullets
  // parse cleanly. (Markdown allows 0-3 spaces before `-`, so this is safe.)
  const stripped = parts.map((p, idx) => (idx === 0 ? p : stripIndent(p, 2)));
  return { content: stripped.join("\n").trim(), next: i };
};

const collectInsight = (
  lines: ReadonlyArray<string>,
  startIdx: number,
): CollectResult => {
  const parts: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (INSIGHT_CLOSE_RE.test(line)) {
      i++;
      break;
    }
    if (isMarker(line)) break;
    parts.push(stripIndent(line, 2));
    i++;
  }
  return { content: parts.join("\n").trim(), next: i };
};

interface ToolCallResult {
  readonly turn: Turn;
  readonly next: number;
}

const collectToolCall = (
  lines: ReadonlyArray<string>,
  startIdx: number,
  toolName: string,
): ToolCallResult => {
  const firstLine = lines[startIdx]!;
  const openIdx = firstLine.indexOf("(");
  let argsBuf = firstLine.slice(openIdx + 1);
  let depth = 1 + countParens(argsBuf);
  let i = startIdx + 1;

  // Consume continuation lines until parens balance. Defensive: also stop if
  // we run into a marker (malformed args) so we don't swallow the next event.
  while (i < lines.length && depth > 0) {
    const line = lines[i]!;
    if (isMarker(line)) break;
    argsBuf += "\n" + line;
    depth += countParens(line);
    i++;
  }

  // Strip the trailing close-paren that balanced depth.
  const lastParen = argsBuf.lastIndexOf(")");
  const args = (lastParen >= 0 ? argsBuf.slice(0, lastParen) : argsBuf).trim();

  // Collect ⎿ output chunks. Each ⎿ starts a chunk; following 5-space-indented
  // lines extend it. Multiple ⎿ chunks concatenate into one output text.
  const chunks: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    const m = OUTPUT_LINE_RE.exec(line);
    if (m) {
      chunks.push(m[1] ?? "");
      i++;
      while (i < lines.length) {
        const cont = lines[i]!;
        if (cont.trim() === "") break;
        if (isMarker(cont)) break;
        if (OUTPUT_LINE_RE.test(cont)) break; // next ⎿ chunk
        if (/^\s{4,}/.test(cont)) {
          chunks[chunks.length - 1] += "\n" + stripIndent(cont, 5);
          i++;
        } else {
          break;
        }
      }
      continue;
    }
    if (line.trim() === "" && i + 1 < lines.length && OUTPUT_LINE_RE.test(lines[i + 1]!)) {
      i++;
      continue;
    }
    break;
  }

  const output =
    chunks.length > 0
      ? { kind: outputKindFor(toolName), text: chunks.join("\n") }
      : null;

  return {
    turn: { kind: "tool-call", tool: toolName, args, output },
    next: i,
  };
};

const looksLikeCC = (input: string): boolean =>
  /(^|\n)❯\s/u.test(input) ||
  /(^|\n)⏺\s/u.test(input) ||
  /\n\s+Called\s+\S+\s*\(/u.test(input) ||
  /(^|\n)[^A-Za-z0-9\s]\s+[A-Z]\p{L}+\s+for\s+\d+[smhd]/u.test(input);

export const parseClaudeCode = (input: string): Turn[] | null => {
  if (!looksLikeCC(input)) return null;

  const lines = input.split("\n");
  const turns: Turn[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (TURN_SUMMARY_RE.test(line)) {
      turns.push({ kind: "turn-summary", text: line.trim() });
      i++;
      continue;
    }

    const userM = USER_RE.exec(line);
    if (userM) {
      const body = collectBody(lines, i + 1, userM[1] ?? "");
      if (body.content.length > 0) {
        turns.push({ kind: "message", role: "user", content: body.content });
      }
      i = body.next;
      continue;
    }

    if (INSIGHT_OPEN_RE.test(line)) {
      const ins = collectInsight(lines, i + 1);
      if (ins.content.length > 0) {
        turns.push({ kind: "insight", content: ins.content });
      }
      i = ins.next;
      continue;
    }

    const toolM = TOOL_CALL_RE.exec(line);
    if (toolM) {
      const tc = collectToolCall(lines, i, toolM[1]!);
      turns.push(tc.turn);
      i = tc.next;
      continue;
    }

    const calledM = CALLED_MCP_RE.exec(line);
    if (calledM) {
      turns.push({
        kind: "tool-call",
        tool: calledM[1]!,
        args: "",
        output: null,
      });
      i++;
      continue;
    }

    const assistM = ASSIST_RE.exec(line);
    if (assistM) {
      const body = collectBody(lines, i + 1, assistM[1] ?? "");
      if (body.content.length > 0) {
        turns.push({ kind: "message", role: "assistant", content: body.content });
      }
      i = body.next;
      continue;
    }

    // Unmatched at top level — skip blank lines, stray content between events.
    i++;
  }

  return turns.length >= 2 ? turns : null;
};
