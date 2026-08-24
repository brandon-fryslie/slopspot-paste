import type { ChartPoint, ChartSeries, Role, Turn } from "../types";

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

// Exported for the fixture-capture script, which must verify its credential
// scrub never flips a line's eligibility class — with this predicate, not a
// copied threshold ([LAW:one-source-of-truth]).
export const isIndicatorEligible = (t: string): boolean =>
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

// [LAW:decomposition] The shared core both exports build on: split the markdown
// into per-heading turns, but also report WHERE each heading's contribution
// ends in the flat array (`boundaries[i]` = turns.length right after heading i)
// — a fact only `parseClaudeShareWithCharts` needs, to know where a chart
// belongs, but that is cheapest to compute once, here, alongside the turns
// themselves rather than re-derived by re-walking the heading list twice.
interface BuiltTurns {
  readonly turns: Turn[];
  readonly headings: ReadonlyArray<HeadingMatch>;
  readonly boundaries: ReadonlyArray<number>;
}

const buildTurns = (markdown: string): BuiltTurns | null => {
  const lines = markdown.split("\n");
  const headings = findHeadings(lines);
  if (headings.length < 2) return null;

  const turns: Turn[] = [];
  const boundaries: number[] = [];
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
    boundaries.push(turns.length);
  }
  return { turns, headings, boundaries };
};

export const parseClaudeShare = (markdown: string): Turn[] | null => {
  const built = buildTurns(markdown);
  return built !== null && built.turns.length >= 2 ? built.turns : null;
};

// ─────────────────────────────────────────────────────────────────────────
// Chart recovery (slopspot-mobile-parity-8s8.1.1)
//
// The share page's charts have no markdown representation at all — no <img>,
// no image syntax, nothing bodyTurns above could ever see. What IS present in
// the raw HTML fetch is the chart's own SVG: axis tick <text> elements carrying
// REAL numeric labels next to their pixel position, and data marks (<circle>,
// a <path> tracing the same points) at pixel coordinates in that SAME local
// space. Reading two-or-more (pixel, labeled value) pairs per axis and fitting
// a line through them turns every mark's pixel position back into the real
// value — not a guess, a direct inverse of the scale the chart itself drew
// with. Investigation evidence: the reference share
// (https://claude.ai/share/2a78ba96-44b9-4e01-84bf-423b6a8aa553) — re-verified
// live during 8s8.1.1, never committed as a fixture per this repo's capture
// pipeline (test/fixtures/README.md).
//
// [LAW:no-silent-failure] Every step below is a proof-or-abstain check: a chart
// whose axes don't fit a line, or a fetch whose turn count doesn't line up with
// the markdown's, yields NO chart turns rather than a wrong or misplaced one.
// Fewer charts recovered is honest; a chart attached to the wrong turn, or
// carrying invented values, is not.

// A chart-eligible SVG carries this design system's own chart primitives — a
// structural fingerprint (like the doubled-line tool-indicator check above),
// not a size threshold, so it survives if Anthropic re-orders attributes.
const isChartEligible = (svg: string): boolean =>
  svg.includes("<circle") && svg.includes("cds-chart-axis");

const SVG_RE = /<svg[\s\S]*?<\/svg>/g;

// A y-axis tick: `<g transform="translate(0,PIXEL)">…<text … text-anchor="end"
// …>VALUE</text></g>` — the gridline and its label share the tick's own
// vertical offset, so the wrapping `<g>`'s translate Y IS the tick's pixel
// position.
const Y_TICK_RE = /<g transform="translate\(0,(-?[\d.]+)\)">[\s\S]*?text-anchor="end"[^>]*>(-?[\d.]+)<\/text>/g;

// An x-axis tick: a bare `<text x="PIXEL" y="…" text-anchor="middle" …>VALUE
// </text>` — no wrapping group; the tick's own x attribute is its pixel
// position.
const X_TICK_RE = /<text x="(-?[\d.]+)" y="-?[\d.]+" text-anchor="middle"[^>]*>(-?[\d.]+)<\/text>/g;

// A data mark: `<circle cx="PX" cy="PY" … fill="var(--cds-chart-categorical-N)"
// …>`. The categorical-N slot is the closest thing to a series identity this
// markup carries — grouping by it separates multiple series drawn in one
// chart without claiming a series NAME the source never gave us.
const POINT_RE = /<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)"[^>]*fill="var\(--cds-chart-(categorical-\d+)\)"/g;

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Least-squares fit of value = slope*pixel + intercept over the tick pairs. A
// chart draws its ticks at evenly-spaced pixel steps by construction, so two
// ticks would fit exactly — least squares over every tick recovered is simply
// the more robust read, absorbing any single tick's rounding in the source
// markup. null when there are too few ticks, or the ticks share one pixel
// (a degenerate axis this method cannot invert) — never a fabricated scale.
const linearFit = (
  pairs: ReadonlyArray<readonly [pixel: number, value: number]>,
): ((pixel: number) => number) | null => {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return (pixel: number) => slope * pixel + intercept;
};

const tickPairs = (svg: string, re: RegExp): ReadonlyArray<readonly [number, number]> => {
  const pairs: Array<readonly [number, number]> = [];
  for (const m of svg.matchAll(re)) {
    const pixel = Number(m[1]);
    const value = Number(m[2]);
    if (Number.isFinite(pixel) && Number.isFinite(value)) pairs.push([pixel, value]);
  }
  return pairs;
};

// One SVG → its recovered series, or null if this SVG isn't a chart this
// method can invert (ineligible fingerprint, or either axis doesn't fit).
const extractChart = (svg: string): ReadonlyArray<ChartSeries> | null => {
  if (!isChartEligible(svg)) return null;
  const yFit = linearFit(tickPairs(svg, Y_TICK_RE));
  const xFit = linearFit(tickPairs(svg, X_TICK_RE));
  if (yFit === null || xFit === null) return null;

  const bySeries = new Map<string, ChartPoint[]>();
  for (const m of svg.matchAll(POINT_RE)) {
    const cx = Number(m[1]);
    const cy = Number(m[2]);
    const key = m[3]!;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    const points = bySeries.get(key) ?? [];
    points.push({ x: round2(xFit(cx)), y: round2(yFit(cy)) });
    bySeries.set(key, points);
  }
  return bySeries.size > 0 ? [...bySeries.values()].map((points) => ({ points })) : null;
};

// Every chart-eligible SVG in the document, in document order, paired with its
// byte offset — the offset is what lets the caller decide WHICH conversation
// exchange it belongs to.
const extractCharts = (html: string): ReadonlyArray<{ offset: number; series: ReadonlyArray<ChartSeries> }> => {
  const out: Array<{ offset: number; series: ReadonlyArray<ChartSeries> }> = [];
  for (const m of html.matchAll(SVG_RE)) {
    const series = extractChart(m[0]);
    if (series !== null) out.push({ offset: m.index, series });
  }
  return out;
};

// [LAW:no-silent-failure] The correlation step: WHICH assistant turn does an
// HTML-offset chart belong to? The share page marks the start of every user
// turn with `data-testid="user-message"`, in the same order the markdown's
// user headings appear — so the Nth such marker begins the SAME exchange as
// the Nth user heading, and everything up to the (N+1)th marker (or EOF) is
// that exchange's assistant response. This is proven, not assumed: if the
// marker count disagrees with the markdown's user-heading count, the two
// streams cannot be lined up, and NO chart is attached rather than guessed at.
const chartTurnsByBoundary = (
  html: string,
  headings: ReadonlyArray<HeadingMatch>,
  boundaries: ReadonlyArray<number>,
): ReadonlyMap<number, Turn[]> => {
  const userMarkerOffsets = [...html.matchAll(/data-testid="user-message"/g)].map((m) => m.index);
  const userHeadingIndices = headings
    .map((h, i) => (h.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  if (userMarkerOffsets.length !== userHeadingIndices.length) return new Map();

  const charts = extractCharts(html);
  if (charts.length === 0) return new Map();

  const inserts = new Map<number, Turn[]>();
  for (let i = 0; i < userMarkerOffsets.length; i++) {
    const segStart = userMarkerOffsets[i]!;
    const segEnd = i + 1 < userMarkerOffsets.length ? userMarkerOffsets[i + 1]! : html.length;
    const assistantHeadingIdx = userHeadingIndices[i]! + 1;
    if (assistantHeadingIdx >= headings.length) continue;
    if (headings[assistantHeadingIdx]!.role !== "assistant") continue;

    const inSegment = charts.filter((c) => c.offset >= segStart && c.offset < segEnd);
    if (inSegment.length === 0) continue;

    const boundary = boundaries[assistantHeadingIdx]!;
    const chartTurns: Turn[] = inSegment.map((c) => ({ kind: "chart", series: c.series }));
    inserts.set(boundary, [...(inserts.get(boundary) ?? []), ...chartTurns]);
  }
  return inserts;
};

// [LAW:one-source-of-truth] The provider-registry entry point: project the
// fetched markdown exactly as parseClaudeShare always has, then splice in any
// chart turns the html fetch recovers. html is optional (a legacy record, or a
// fetch made before charts were requested) — its absence yields exactly
// parseClaudeShare's output, never a partial/wrong chart set.
export const parseClaudeShareWithCharts = (markdown: string, html: string | null): Turn[] | null => {
  const built = buildTurns(markdown);
  if (built === null || built.turns.length < 2) return null;
  if (html === null) return built.turns;

  const inserts = chartTurnsByBoundary(html, built.headings, built.boundaries);
  if (inserts.size === 0) return built.turns;

  const out: Turn[] = [];
  for (let i = 0; i <= built.turns.length; i++) {
    const toInsert = inserts.get(i);
    if (toInsert) out.push(...toInsert);
    if (i < built.turns.length) out.push(built.turns[i]!);
  }
  return out;
};
