// [LAW:decomposition] The spoken projection of a conversation: one ordered list of
// utterances derived from the viewable dialogue. One sentence, no "and" — this module
// decides WHAT is said and IN WHOSE VOICE. It never speaks: it holds no reference to
// speechSynthesis, no DOM, no timers. Performing these utterances is speechPlayer.ts's
// job, at the browser edge [LAW:effects-at-boundaries], which is also what lets every
// rule below be tested with no mocks at all.
//
// Audio is a DERIVED, DISPOSABLE projection of the stored original — a sibling of the
// HTML renderer and of deriveSpineOutline, never a stored artifact. Nothing here is
// persisted and no audio is ever cached: a stored audio blob would be a second
// representation of the paste that drifts the moment the parser or these rules improve
// [LAW:one-source-of-truth], and it would owe a migration to every paste already stored.
// Derived at read time, a change to this file re-voices every existing paste for free.
//
// [LAW:one-way-deps] It depends on the model (dialogue); the model never depends on it.

import type { DisplayNode, ViewableDialogue, AssistantBlock } from "./dialogue";
import { blockVisibility, blockText, turnAnchorId, spineNodeLabel } from "./dialogue";

// [LAW:types-are-the-program] Who is speaking — and the ONE discriminator that carries
// the difference between the author's words and ours. `narrator` marks every utterance
// this module composed rather than quoted (a code block announced, folded detail counted),
// and it is simultaneously what selects a different synthesis voice at the edge. A
// separate `source: "author" | "narrator"` field beside a role would be the same fact
// twice, free to disagree; there is one field because there is one fact.
export const VOICES = ["user", "assistant", "system", "narrator"] as const;
export type Voice = (typeof VOICES)[number];

// [LAW:types-are-the-program] One thing said, by one voice, belonging to one spine node.
// `index` is the node's CARRIED index (never an array position), so `anchor` is the same
// t<N> string the renderer emitted as that node's id — which is what lets the player
// highlight the turn being spoken without inventing a second addressing scheme
// [LAW:one-source-of-truth].
export interface Utterance {
  readonly index: number;
  readonly anchor: string;
  readonly voice: Voice;
  readonly text: string;
}

// ── markdown → speech ────────────────────────────────────────────────────────────────
//
// A transcript is prose AND code, and they want opposite treatment: prose is the point,
// while a fenced diff read aloud character by character is worse than useless — it is a
// minute of noise that buries the sentence after it. So code is ANNOUNCED rather than
// read, which is the honest move: the listener is told a code block was there and how
// big it was, instead of it silently not existing [LAW:no-silent-failure].

// [LAW:types-are-the-program] A run of source text that has been classified. `quoted`
// is the author's own words, ready to speak; `announced` is our description standing in
// for something unspeakable. Order is preserved, so "here is the fix: <code> and then it
// works" reads prose, announcement, prose — in that order, as the reader sees it.
type Segment =
  | { readonly kind: "quoted"; readonly text: string }
  | { readonly kind: "announced"; readonly text: string };

// [LAW:types-are-the-program] Captures the delimiter run itself (group 1), not just
// whether one was present, because CommonMark's closing rule needs it: a closing fence
// must reuse the SAME character as its opener and be at least as long. Without tracking
// that, a code block opened with ``` that discusses fence syntax and contains a nested
// ~~~ example — or a shorter ``` — would close on the wrong line, splitting one block
// into a truncated fence plus stray "prose" that gets spoken instead of announced.
//
// Group 2 is the WHOLE info string, not just a language token: a real opener can carry
// more than a bare language (```jsx twoslash, ```js {1,3} line-highlight annotations) —
// requiring nothing-but-whitespace after the language would fail to recognize those as
// fences at all, spilling the fenced block's own backticks into prose to be read aloud
// character by character, which is exactly the invariant this module exists to prevent.
// The language spoken in the announcement is the info string's first token (see below);
// a closing line, by contrast, must have an EMPTY info string — CommonMark's rule that a
// close "may be followed only by spaces or tabs" — so the two uses read the same capture
// two different ways rather than needing two regexes.
const FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*(.*)$/;

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

// The announcement standing in for a fenced block. The language is named when the fence
// declared one and simply omitted when it did not — an honest absence, never a guessed
// "text" that would tell the listener something the source never said.
const codeAnnouncement = (language: string, lines: number): string => {
  const what = language === "" ? "code block" : `${language} code block`;
  return lines === 0 ? `${what}, empty` : `${what}, ${plural(lines, "line")}`;
};

// [LAW:dataflow-not-control-flow] Inline transformations, applied unconditionally in one
// fixed order to every line of prose. Each is a total rewrite of one markdown surface
// into what it SOUNDS like; none of them decides whether to run.
//
// The through-line: a marker that exists to be SEEN (emphasis, heading hashes, list
// bullets, table pipes) is removed, because a synthesizer either voices it as punctuation
// noise or as nothing; text that carries MEANING (a link's label, an inline identifier)
// is kept. A URL is dropped rather than read: "h t t p s colon slash slash" is the single
// worst thing a screen reader does, and the label already says where it goes.
//
// Inline code is NOT among these — it is protected below, before this list ever runs, so
// markdown syntax written literally inside a code span reaches nothing here.
const INLINE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Images announce their alt text — the picture cannot be spoken, but what it was
  // labelled can, so it is described rather than dropped [LAW:no-silent-failure].
  [/!\[([^\]]*)\]\([^)]*\)/g, "image, $1"],
  // Links keep the label, lose the target.
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/<https?:\/\/[^>]+>/g, "link"],
  // Emphasis markers, in the one order that keeps *** from leaving a stray star.
  [/\*\*\*([^*]+)\*\*\*/g, "$1"],
  [/\*\*([^*]+)\*\*/g, "$1"],
  [/\*([^*]+)\*/g, "$1"],
  [/__([^_]+)__/g, "$1"],
  [/~~([^~]+)~~/g, "$1"],
  // Any HTML that survived into the source text.
  [/<[^>]+>/g, " "],
];

// Line-leading markers: structure the eye reads and the ear does not need.
const LEADING_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^[ \t]*#{1,6}[ \t]+/, ""], // heading hashes
  [/^[ \t]*>[ \t]?/, ""], // blockquote
  [/^[ \t]*[-*+][ \t]+/, ""], // bullet
  [/^[ \t]*\d+[.)][ \t]+/, ""], // ordered item
];

// GFM requires only ONE OR MORE hyphens per delimiter cell (`| - | - |` is a legal
// divider) — matching marked's actual table recognition, which is what render.ts hands
// transcripts to. A stricter `-{2,}` here would leave a real table's pipes unconverted
// whenever an author wrote the shortest legal divider.
//
// Every group in the regex below is independently optional, so the pattern alone matches
// a bare `---` thematic break — zero pipes at all — as a one-cell "divider". The explicit
// `line.includes("|")` precondition is what render.ts's own SEPARATOR_RE gets for free
// from its `+` repetition: a divider needs at least one REAL pipe, or a plain horizontal
// rule sitting next to unrelated prose (`ls | grep foo` on the line just above or below a
// `---`) would sweep that prose into the table set and corrupt its pipe as a cell
// boundary — the exact class of bug this file's table-membership proof exists to prevent.
const isTableDivider = (line: string): boolean =>
  line.includes("|") && /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line);

// A rule that is entirely presentational: a horizontal rule or a table's divider row has
// no spoken form at all, so the line is dropped rather than voiced as punctuation.
const isRuleLine = (line: string): boolean =>
  /^[ \t]*(?:[-*_][ \t]*){3,}$/.test(line) || isTableDivider(line);

// [LAW:parse-dont-validate] A literal "|" means "table cell boundary" in exactly one
// context: adjacent to the divider row every GFM table requires. Everywhere else it is
// ordinary punctuation — a shell pipe, a boolean-or, absolute-value bars — and reading
// "a | b" as "a, b" there would rewrite an ordinary sentence's meaning. So table
// membership is PROVEN once, from the divider outward (the header immediately above it,
// then every contiguous pipe-bearing row below), never guessed line by line from a bare
// pipe. A line not reachable from a real divider is never treated as a table row.
const tableLineIndices = (lines: ReadonlyArray<string>): ReadonlySet<number> => {
  const rows = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!isTableDivider(lines[i]!)) continue;
    rows.add(i);
    const header = lines[i - 1];
    if (header !== undefined && header.trim() !== "" && header.includes("|")) rows.add(i - 1);
    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j]!;
      if (row.trim() === "" || !row.includes("|")) break;
      rows.add(j);
    }
  }
  return rows;
};

// A code span. Group 1 is the opening backtick RUN, greedily matched, and the closing
// delimiter is a backreference to it (`\1`) rather than a bare single backtick — a code
// span containing a literal backtick is written with a longer run as its delimiter
// (CommonMark: ``` ``a`b`` ``` for the literal text `` a`b ``). A single-backtick pattern
// pairs the first ` with the very next one — the interior ` — mis-splitting the span into
// an empty span plus a stray "`b`", leaking literal markdown syntax into prose. Content is
// matched non-greedily so back-to-back spans stay distinct rather than one match
// swallowing everything between the first opener and the last closer.
const CODE_SPAN = /(`+)(.*?)\1/g;
// The placeholder wrapper: a NUL character, built with String.fromCharCode rather than
// written as a literal in this source file — a control byte that cannot occur in real
// markdown, so restoring a span can never collide with prose that happens to contain the
// same digits. A PRINTABLE wrapper (even a bare space) risks exactly that collision:
// "wait 5 minutes" already has the shape "space, digit, space".
const SHIELD = String.fromCharCode(0);
const SHIELD_RE = new RegExp(`${SHIELD}(\\d+)${SHIELD}`, "g");

const speakLine = (line: string, isTable: boolean): string => {
  // Inline code is protected from every other inline rule by being pulled out FIRST and
  // swapped back in verbatim after — the same isolation fenced blocks get at the line
  // level, applied here at the span level. Without this, a markdown token literally
  // written inside a code span (a link, a bold marker, a literal pipe) would be
  // interpreted as real markdown by rules meant for the surrounding prose, corrupting
  // the exact syntax the span exists to display verbatim.
  const shielded: string[] = [];
  const withPlaceholders = line.replace(CODE_SPAN, (_match, _delim: string, content: string) => {
    const token = `${SHIELD}${shielded.length}${SHIELD}`;
    shielded.push(content);
    return token;
  });

  // Applied to a FIXPOINT, not a single pass: a leading marker can nest ("> ## Heading" is
  // a heading quoted inside a blockquote), and a single pass only ever recognizes the
  // OUTERMOST one — the blockquote strip exposes a fresh "##" that a one-shot pass has
  // already moved past. Looping until nothing matches is what "line-leading structure the
  // ear does not need" actually means when markers stack.
  let led = withPlaceholders;
  for (;;) {
    const stripped = LEADING_RULES.reduce((acc, [re, to]) => acc.replace(re, to), led);
    if (stripped === led) break;
    led = stripped;
  }
  const inlined = INLINE_RULES.reduce((acc, [re, to]) => acc.replace(re, to), led);

  // A table row's pipes are column furniture; the cells are the content. This runs on
  // `inlined` — BEFORE code spans are restored — so a literal pipe protected inside a code
  // span is still a shield placeholder here and cannot be mistaken for a cell boundary.
  // Restoring first would put the real "|" back too early: a cell like `` `a|b` `` would
  // read as two cells instead of one, silently splitting content the shield exists to keep
  // intact.
  const tabled = isTable
    ? inlined.replace(/[ \t]*\|[ \t]*/g, ", ").replace(/^,[ \t]*|,[ \t]*$/g, "")
    : inlined;
  return tabled.replace(SHIELD_RE, (_match, i: string) => shielded[Number(i)] ?? "");
};

const collapse = (text: string): string => text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();

// [LAW:dataflow-not-control-flow] One pass over the lines with a single piece of carried
// state — whether we are inside a fence, and what that fence declared. Fenced lines
// accumulate into a count; unfenced lines accumulate into prose. No line is skipped: it
// lands in exactly one of the two accumulators, which is what makes "nothing is silently
// discarded" a property of the shape rather than a promise.
//
// An UNCLOSED fence is closed by the end of input rather than treated as an error: the
// stored original may genuinely contain one (a truncated transcript), and refusing to
// speak the paste would be a worse answer than announcing the block it opened.
export const speakableSegments = (markdown: string): ReadonlyArray<Segment> => {
  const segments: Segment[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number; language: string; lines: number } | null = null;

  const flushProse = (): void => {
    const text = collapse(prose.join("\n"));
    prose = [];
    if (text !== "") segments.push({ kind: "quoted", text });
  };
  const flushFence = (): void => {
    if (fence === null) return;
    segments.push({ kind: "announced", text: codeAnnouncement(fence.language, fence.lines) });
    fence = null;
  };

  const lines = markdown.split("\n");
  const tableRows = tableLineIndices(lines);

  lines.forEach((line, i) => {
    const fenced = FENCE.exec(line);
    if (fence !== null) {
      // Inside a block: the only line that closes it reuses the SAME delimiter character
      // as the opener, is at least as long, and carries no trailing info string —
      // CommonMark's own rules. Without the length+char check, a nested example using the
      // other fence character (or a shorter run) would prematurely end the block it lives
      // inside; without the empty-info-string check, a nested fence opener that happens to
      // share the outer delimiter's char and length (```md containing an inner ```js
      // example) would be mistaken for the outer close, leaking the inner block's content
      // into prose instead of staying announced.
      const closes =
        fenced !== null &&
        fenced[1]![0] === fence.char &&
        fenced[1]!.length >= fence.length &&
        fenced[2]!.trim() === "";
      if (!closes) fence.lines += 1;
      else flushFence();
      return;
    }
    if (fenced !== null) {
      flushProse();
      const info = fenced[2]!.trim();
      // The announcement speaks only the LANGUAGE — the info string's first token — never
      // the rest of an annotation (twoslash, {1,3}) a listener has no use for.
      const language = info === "" ? "" : info.split(/\s+/)[0]!;
      fence = { char: fenced[1]![0]!, length: fenced[1]!.length, language, lines: 0 };
      return;
    }
    prose.push(isRuleLine(line) ? "" : speakLine(line, tableRows.has(i)));
  });
  flushProse();
  flushFence();
  return segments;
};

// ── dialogue → utterances ────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] What a node's UNSPOKEN activity holds, counted rather than
// re-listed. The visual renderer folds thinking / tool calls / subagents behind a
// disclosure, so the audio does not read them — but it does SAY they are there. A
// listener who is told "2 tool calls" knows the conversation had a shape the audio
// abridged; one who is told nothing has been quietly handed a different conversation
// [LAW:no-silent-failure]. Token usage joins the same announcement for the same reason,
// on the numeric side rather than the folded side: the renderer shows it as a widget of
// raw counts, and reading digits aloud would be noise no differently than a diff would be.
//
// [LAW:types-are-the-program] The exhaustive counterpart, for THIS module, to
// dialogue.ts's own BLOCK_VISIBILITY: every AssistantBlock kind names the unit spoken for
// it here (or null, for a kind that never contributes a count). A new "detail" kind added
// to dialogue.ts is correctly excluded from being read verbatim by BLOCK_VISIBILITY alone
// — but without an entry HERE too, it would land in blockVisibility's "detail" bucket and
// contribute nothing to this announcement, silently under-counting exactly the "quietly
// handed a different conversation" failure this file's header warns against. Adding a kind
// to AssistantBlock now fails to compile until it is classified in both maps.
const DETAIL_UNIT: { readonly [K in AssistantBlock["kind"]]: string | null } = {
  text: null,
  insight: null,
  "tool-call": "tool call",
  thinking: "thinking block",
  subagent: "subagent run",
  "turn-summary": null,
  usage: null,
};

// usage is checked by kind directly because it is the one "meta" kind that is genuinely
// unspeakable as numbers — turn-summary, the other meta kind, is real prose and is SPOKEN
// below, not folded into this count.
const detailAnnouncement = (blocks: ReadonlyArray<AssistantBlock>): string => {
  const counts: Partial<Record<AssistantBlock["kind"], number>> = {};
  for (const b of blocks) {
    if (blockVisibility(b) !== "detail") continue;
    counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  }
  const hasUsage = blocks.some((b) => b.kind === "usage");
  const counted = (Object.keys(DETAIL_UNIT) as ReadonlyArray<AssistantBlock["kind"]>)
    .map((kind) => {
      const n = counts[kind];
      const unit = DETAIL_UNIT[kind];
      return n !== undefined && unit !== null ? plural(n, unit) : "";
    })
    .filter((p) => p !== "");
  const parts = hasUsage ? [...counted, "a token usage note"] : counted;
  return parts.length === 0 ? "" : `${parts.join(", ")} not read aloud`;
};

// [LAW:one-source-of-truth] An assistant node's blocks, spoken in ONE pass over their
// ACTUAL array order — not spine text followed by turn-summary followed by a detail
// count, three groups concatenated regardless of where each really sits. deriveDialogue
// pushes blocks in the order the parser saw them, and renderDialogueHtml draws each block
// at its real position; a turn-summary block sitting between two chunks of assistant text
// in one continuous turn (a mid-turn compaction marker — closeAssistant() only fires on a
// user/system message) renders on the page BEFORE the text that follows it. Concatenating
// groups would always speak it AFTER all of that text instead, breaking this module's own
// "speech mirrors what the renderer draws" invariant for ORDER, not just presence.
//
// turn-summary is the one "meta" block kind that carries real, page-visible prose —
// rendered as a visible <aside>, never folded behind a disclosure — so it is SPOKEN,
// through the same markdown rules as spine text, in the narrator voice: it is the
// source's OWN annotation about the conversation, not a line either party actually said.
// Detail blocks (thinking/tool-call/subagent) are still COUNTED rather than positioned —
// a listener hears "N tool calls... not read aloud" once, at the end, not scattered
// through the turn every time one occurs — because detailAnnouncement's per-kind map
// already answers "how many of each", which speaking each occurrence in place would not
// improve.
const assistantUtterances = (
  blocks: ReadonlyArray<AssistantBlock>,
  at: (voice: Voice, text: string) => Utterance,
): ReadonlyArray<Utterance> => {
  const spoken = blocks.flatMap((b) => {
    if (blockVisibility(b) === "spine") {
      return speakableSegments(blockText(b)).map((seg) => at(seg.kind === "quoted" ? "assistant" : "narrator", seg.text));
    }
    if (b.kind === "turn-summary") {
      return speakableSegments(b.text).map((seg) => at("narrator", seg.text));
    }
    return [];
  });
  const detail = detailAnnouncement(blocks);
  return detail === "" ? spoken : [...spoken, at("narrator", detail)];
};

// [LAW:dataflow-not-control-flow] One node in, its utterances out. A spoken (user/system)
// node has no blocks to interleave, so it stays a single speakableSegments pass over its
// own content; an assistant node hands off to assistantUtterances above, which owns the
// ordering an assistant turn actually needs.
const nodeUtterances = ({ index, node, collapsed }: DisplayNode): ReadonlyArray<Utterance> => {
  const anchor = turnAnchorId(index);
  const at = (voice: Voice, text: string): Utterance => ({ index, anchor, voice, text });

  // [LAW:one-source-of-truth] A collapsed spine node sits behind a native <details>,
  // shown only on demand — the SAME fold the renderer already applies for feature/
  // highlight-reel overlays. Speech mirrors it exactly the way it mirrors the detail
  // fold inside an assistant turn: announced by the node's own label, the SAME text the
  // visual <summary> reads, rather than read in full. Reusing spineNodeLabel is what
  // keeps the two from ever naming the same fold two different ways.
  if (collapsed) return [at("narrator", `Folded: ${spineNodeLabel(node)}.`)];

  if (node.kind === "spoken") {
    return speakableSegments(node.content).map((seg) => at(seg.kind === "quoted" ? node.role : "narrator", seg.text));
  }

  return assistantUtterances(node.blocks, at);
};

// [LAW:one-source-of-truth] The spoken projection of the SAME ViewableDialogue the
// renderer draws and deriveSpineOutline reads. Consuming that view rather than the raw
// Turn[] is what keeps the audio and the page telling one story: a node an authored
// overlay omitted is absent from the view, and so is never spoken — without this module
// knowing overlays exist at all.
export const deriveUtterances = (view: ViewableDialogue): ReadonlyArray<Utterance> =>
  view.flatMap(nodeUtterances);
