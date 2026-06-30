import type { Role, Turn } from "../types";

// [LAW:types-are-the-program] Input is the markdown Firecrawl produced from a
// chatgpt.com/share page. Output is the same Turn[] union every other parser
// produces. The shape is observed empirically (see test/fixtures/chatgpt-share.md):
// each turn opens with a LEVEL-4 role heading on its own line —
//   #### You said:
//   #### ChatGPT said:
// and the message body sits between consecutive headings. This differs from
// claude.ai/share (parseClaudeShare), whose headings are level-2 and carry an
// inline preview of the message; here the marker stands alone and the body is the
// only copy of the content. In-body `##`/`###` headings are real message content,
// never turn boundaries — so the delimiter must match the level-4 role markers
// exactly, not any heading.
//
// [LAW:single-enforcer] This file knows the chatgpt.com/share page layout.
// Nothing upstream (Firecrawl client) or downstream (renderer) knows it. When
// OpenAI changes the share-page format, only this file changes.

const HEADING_RE = /^####\s+(You\s+said|ChatGPT\s+said)\s*:\s*$/i;

const ROLE_BY_LABEL: ReadonlyMap<string, Role> = new Map([
  ["you said", "user"],
  ["chatgpt said", "assistant"],
]);

// [LAW:one-source-of-truth] The page-chrome lines Firecrawl scrapes around the
// conversation — the share-page header (skip-link, "Chat history" title, the
// copy-notice and report button) and the footer (the voice-playback button and
// the AI disclaimer). The header sits before the first role heading and is
// dropped by slicing; the footer trails the last assistant turn and would leak
// into it, so the body walker strips the whole set. One list, the single home of
// what is page chrome versus conversation content.
const CHROME_LINE_RE = [
  /^\[Skip to content\]/i,
  /^##\s+Chat history$/i,
  /^This is a copy of a shared ChatGPT conversation$/i,
  /^Report conversation$/i,
  /^Voice$/i,
  /^ChatGPT is AI and can make mistakes\.$/i,
];

const isChromeLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return CHROME_LINE_RE.some((re) => re.test(trimmed));
};

// A code fence opens or closes on a line that begins (after optional indent)
// with ``` or ~~~. Defined locally rather than imported from the renderer:
// a parser must not depend on a downstream layer ([LAW:one-way-deps]).
const FENCE_RE = /^\s*(?:```|~~~)/;

// [LAW:dataflow-not-control-flow] One walker classifies every line the same way;
// the fence state is the typed owner of "are we inside code", so chrome is
// stripped only outside fences — a code block that happens to contain a chrome
// string (e.g. a literal "Voice" line) survives verbatim.
const bodyContent = (bodyLines: ReadonlyArray<string>): string => {
  const kept: string[] = [];
  let inFence = false;
  for (const line of bodyLines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    if (isChromeLine(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/^\s+|\s+$/g, "");
};

interface HeadingMatch {
  readonly role: Role;
  readonly lineIdx: number;
}

const findHeadings = (lines: ReadonlyArray<string>): ReadonlyArray<HeadingMatch> => {
  const out: HeadingMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]!);
    if (!m) continue;
    const label = m[1]!.trim().replace(/\s+/g, " ").toLowerCase();
    const role = ROLE_BY_LABEL.get(label);
    if (!role) continue;
    out.push({ role, lineIdx: i });
  }
  return out;
};

export const parseChatgptShare = (markdown: string): Turn[] | null => {
  const lines = markdown.split("\n");
  const headings = findHeadings(lines);
  if (headings.length < 2) return null;

  const turns: Turn[] = [];
  for (let i = 0; i < headings.length; i++) {
    const cur = headings[i]!;
    const next = headings[i + 1];
    const end = next ? next.lineIdx : lines.length;
    const content = bodyContent(lines.slice(cur.lineIdx + 1, end));
    if (content.length > 0) turns.push({ kind: "message", role: cur.role, content });
  }
  return turns.length >= 2 ? turns : null;
};
