import type { Role, Turn } from "../types";

// [LAW:types-are-the-program] Input is the markdown Firecrawl produced from a
// claude.ai/share page. Output is the same Turn[] union every other parser
// produces. The shape of the markdown is observed empirically (see
// test/fixtures/claude-share.md) — every heading follows the form:
//   ## You said: <inline preview>
//   ## Claude responded: <inline preview>
// and the message body sits between consecutive headings.
//
// [LAW:single-enforcer] This file knows the claude.ai/share page layout.
// Nothing upstream (Firecrawl client) or downstream (renderer) knows it.
// When Anthropic changes the share-page format, only this file changes.

const HEADING_RE = /^##\s+(You\s+said|Claude\s+responded|Claude\s+said|Human|Assistant)\s*:\s*.*$/i;

const ROLE_BY_LABEL: ReadonlyMap<string, Role> = new Map([
  ["you said", "user"],
  ["human", "user"],
  ["claude responded", "assistant"],
  ["claude said", "assistant"],
  ["assistant", "assistant"],
]);

// [LAW:one-source-of-truth] The list of "stripped" body lines lives here.
// These are page-chrome artifacts Firecrawl includes that aren't part of the
// conversation — a single source of truth instead of scattered regexes at
// every render site.
const CHROME_LINE_RE = [
  /^Report$/i,
  /^This is a copy of a chat between/i,
  /^\[Ask Claude your own question\]/i,
  // Date stamps Claude.ai inserts after a user message, like "May 18".
  // Three-letter month + 1-2 digit day, optionally followed by a year/time.
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at\s+.+)?$/i,
];

const isChromeLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return CHROME_LINE_RE.some((re) => re.test(trimmed));
};

// [LAW:single-enforcer] The Private Use Area (U+E000–U+F8FF) holds Claude.ai's
// icon-font codepoints — its per-message action buttons (copy/retry) scrape
// into Firecrawl's markdown as PUA glyphs trailing every turn. They are page
// chrome, not conversation content, so they belong to the same residue strip
// this file already owns. Default-deny the whole range, not a blocklist of the
// glyphs seen today (U+E056/U+E03B): a blocklist leaks the next icon Anthropic
// ships. No standard character lives in the PUA, so real prose — emoji, the CC
// markers ❯⏺⎿★ — is outside the range and survives untouched.
const PUA_RE = /[\u{E000}-\u{F8FF}]/gu;

const cleanBody = (body: string): string => {
  const kept = body
    .split("\n")
    .filter((line) => !isChromeLine(line))
    .join("\n")
    .replace(PUA_RE, "");
  return kept.replace(/^\s+|\s+$/g, "");
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

export const parseClaudeShare = (markdown: string): Turn[] | null => {
  const lines = markdown.split("\n");
  const headings = findHeadings(lines);
  if (headings.length < 2) return null;

  const turns: Turn[] = [];
  for (let i = 0; i < headings.length; i++) {
    const cur = headings[i]!;
    const next = headings[i + 1];
    const end = next ? next.lineIdx : lines.length;
    const bodyLines = lines.slice(cur.lineIdx + 1, end);
    // The heading's inline preview duplicates the body's opening sentence —
    // we ignore it. The body is the source of truth for message content.
    const body = cleanBody(bodyLines.join("\n"));
    if (body.length === 0) continue;
    turns.push({ kind: "message", role: cur.role, content: body });
  }
  return turns.length >= 2 ? turns : null;
};
