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
  // Attachment placeholder the share page shows for hidden uploads.
  /^### Files hidden in shared chats$/i,
  // Truncation button under long user messages.
  /^Show more$/i,
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

// [LAW:single-enforcer] A "lone backslash" line — whitespace plus a single
// backslash and nothing else — is the markdown hard-break residue left behind
// when Claude.ai's per-message action row is captured: the row scrapes as PUA
// icon glyphs followed by a hard-break `\`, so once the glyphs above are gone
// the bare `\` line remains. It carries no conversation content. A real hard
// break is `text\` with content before the backslash; a backslash that means
// something in code sits inside a fence, which the strip below never touches.
const RESIDUE_LINE_RE = /^\s*\\\s*$/;

// A code fence opens or closes on a line that begins (after optional indent)
// with ``` or ~~~. Defined locally rather than imported from the renderer:
// a parser must not depend on a downstream layer ([LAW:one-way-deps]).
const FENCE_RE = /^\s*(?:```|~~~)/;

// [LAW:types-are-the-program] Tool-use indicators on the share page are an OPEN
// set — fixed labels ("Searched the web"), count summaries ("Viewed 9 files,
// ran 2 commands"), free-form status text ("Reading frontend design skill"),
// MCP tool labels ("Search-designs"), and artifact/file card titles in the
// user's own language. An enum of known strings would reject most real
// indicators, so the classifier is structural: the share page renders each
// indicator's text twice (visible + accessible copy), which Firecrawl scrapes
// as the SAME plain line twice in a row. Prose never does that outside code
// fences (ASCII diagrams inside fences do — observed — hence fence gating).
//
// "Eligible" = could be an indicator at all: short, not a markdown structure
// line, no sentence-terminal punctuation. This is the reject half of the
// fingerprint, protecting deliberately repeated prose (refrains, "No!" "No!")
// from promotion.
const INDICATOR_MAX_CHARS = 160;
const MD_STRUCTURE_RE = /^(?:#|[-*+>|]|\d+[.)]\s|\[|!\[|`|~|_{3,})/;
const TERMINAL_PUNCT_RE = /[.!?:;,…]$/;

const isIndicatorEligible = (t: string): boolean =>
  t.length > 0 &&
  t.length <= INDICATOR_MAX_CHARS &&
  !MD_STRUCTURE_RE.test(t) &&
  !TERMINAL_PUNCT_RE.test(t) &&
  !isChromeLine(t);

// The two non-doubled indicator shapes, observed verbatim on real shares:
// the analysis tool scrapes as its label plus a "View analysis" button line,
// and an artifact card scrapes as an optional title line followed by an
// "Interactive artifact[ ∙ Version N]" type line.
const ANALYSIS_LABEL = "Analyzed data";
const ANALYSIS_BUTTON = "View analysis";
const ARTIFACT_CARD_RE = /^Interactive artifact(?:\s+∙\s+Version\s+\d+)?$/;

const nextNonBlank = (lines: ReadonlyArray<string>, from: number): number => {
  let j = from;
  while (j < lines.length && lines[j]!.trim().length === 0) j++;
  return j;
};

// Shape C's card title sits at the tail of the prose segment when the anchor
// line is reached. Pop it only if it could plausibly be a title (same
// eligibility as indicators); otherwise the preceding prose stays intact.
const popTrailingTitle = (segment: string[]): string => {
  let end = segment.length;
  while (end > 0 && segment[end - 1]!.trim().length === 0) end--;
  if (end === 0) return "";
  const t = segment[end - 1]!.trim();
  if (!isIndicatorEligible(t)) return "";
  segment.length = end - 1;
  return t;
};

// [LAW:dataflow-not-control-flow] One walker classifies every line the same
// way; the fence state is the typed owner of "are we inside code", so capture
// residue (chrome lines, lone-backslash hard-break residue) is stripped and
// indicators are promoted only outside fences — verbatim code survives, the
// acceptance criterion that backslashes and repeated diagram lines inside
// fences are untouched. Indicator promotion is gated on the role VALUE: tool
// use exists only in assistant turns, so user bodies (which may quote or paste
// anything, including doubled lines) are never scanned.
const bodyTurns = (body: string, role: Role): Turn[] => {
  const lines = body.replace(PUA_RE, "").split("\n");
  const out: Turn[] = [];
  const segment: string[] = [];
  const flush = (): void => {
    const content = segment.join("\n").replace(/^\s+|\s+$/g, "");
    segment.length = 0;
    if (content.length > 0) out.push({ kind: "message", role, content });
  };
  // Indicator text is a UI label: runs of exotic whitespace (the share page
  // uses U+2002 en-spaces around "∙") carry no meaning, so the stored value is
  // space-normalized rather than leaking layout bytes into render/minimap.
  const toolCall = (tool: string, args: string): void => {
    flush();
    out.push({
      kind: "tool-call",
      tool: tool.replace(/\s+/g, " "),
      args: args.replace(/\s+/g, " "),
      output: null,
    });
  };

  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      segment.push(line);
      i++;
      continue;
    }
    if (inFence) {
      segment.push(line);
      i++;
      continue;
    }
    if (isChromeLine(line) || RESIDUE_LINE_RE.test(line)) {
      i++;
      continue;
    }
    const t = line.trim();
    if (role === "assistant" && t.length > 0) {
      const j = nextNonBlank(lines, i + 1);
      const next = j < lines.length ? lines[j]!.trim() : null;
      // Shape A: the doubled-line fingerprint.
      if (next === t && isIndicatorEligible(t)) {
        toolCall(t, "");
        i = j + 1;
        continue;
      }
      // Shape B: analysis-tool label + its button line.
      if (t === ANALYSIS_LABEL && next === ANALYSIS_BUTTON) {
        toolCall(t, "");
        i = j + 1;
        continue;
      }
      // Shape C: artifact card — type line, optional preceding title.
      if (ARTIFACT_CARD_RE.test(t)) {
        const title = popTrailingTitle(segment);
        toolCall(t, title);
        i++;
        continue;
      }
    }
    segment.push(line);
    i++;
  }
  flush();
  return out;
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
    // A body yields an ORDERED event stream — prose messages interleaved with
    // the tool-call indicators promoted out of them — matching the shape every
    // other parser produces.
    turns.push(...bodyTurns(bodyLines.join("\n"), cur.role));
  }
  return turns.length >= 2 ? turns : null;
};
