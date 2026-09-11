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

// [LAW:parse-dont-validate] What a label MEANS to the ear, decided once and consumed by
// both the image rule and the link rule below. A label that is empty, or is itself a URL
// (ChatGPT exports put the full-size image URL in the alt text), carries nothing a
// listener can use — a URL read aloud is the one thing worse than silence — so its
// meaning is the empty string, and each rule falls back to its noun.
const isUrl = (text: string): boolean => /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/i.test(text);
const labelMeaning = (label: string): string => {
  const text = label.trim();
  return isUrl(text) ? "" : text;
};

// The replacement side of a rule: the matched surface and its capture groups, to what is
// said. Every rule is a function so the table has one shape [LAW:one-type-per-behavior];
// the common case — keep the inner text, drop the markers — is named once.
type Replacer = (match: string, ...groups: string[]) => string;
const keepInner: Replacer = (_, inner) => inner;

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
const INLINE_RULES: ReadonlyArray<readonly [RegExp, Replacer]> = [
  // Images announce their alt text — the picture cannot be spoken, but what it was
  // labelled can, so it is described rather than dropped [LAW:no-silent-failure]. An alt
  // with no meaning leaves the bare noun: the listener still learns a picture was here.
  [
    /!\[([^\]]*)\]\([^)]*\)/g,
    (_, alt) => {
      const what = labelMeaning(alt);
      return what === "" ? "image" : `image, ${what}`;
    },
  ],
  // Links keep the label, lose the target; a label that IS the target becomes "link".
  [/\[([^\]]*)\]\([^)]*\)/g, (_, label) => labelMeaning(label) || "link"],
  [/<https?:\/\/[^>]+>/g, () => "link"],
  // Emphasis markers, in the one order that keeps *** from leaving a stray star.
  [/\*\*\*([^*]+)\*\*\*/g, keepInner],
  [/\*\*([^*]+)\*\*/g, keepInner],
  [/\*([^*]+)\*/g, keepInner],
  [/__([^_]+)__/g, keepInner],
  [/~~([^~]+)~~/g, keepInner],
  // Any HTML that survived into the source text.
  [/<[^>]+>/g, () => " "],
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

// A candidate table row: begins AND ends with a pipe, once trimmed — the shape every
// genuine markdown table row an LLM transcript actually uses. `row.includes("|")` alone
// is not a real test: an ordinary sentence with exactly one stray pipe ("See y | z for
// details.", "the value is |x - y| here") splits into the same two-or-three "cells" a
// real row would, purely by coincidence, so counting cells cannot tell them apart either
// — only the delimiter SHAPE can. Prose essentially never both opens and closes on a
// literal "|"; a genuine row, in every transcript this tool has seen, always does.
const looksLikeTableRow = (line: string): boolean => /^[ \t]*\|.*\|[ \t]*$/.test(line);

// Pipes are unescaped `|` (not `\|`) — the same escape rule render.ts's own cellCount/
// splitPipes uses to detect the real <table> the page renders, so a cell that escapes its
// own separator ("a\|b") counts as ONE cell here too, not two.
const splitCells = (line: string): ReadonlyArray<string> => {
  const trimmed = line.trim();
  if (trimmed === "") return [];
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/);
};

// [LAW:parse-dont-validate] A literal "|" means "table cell boundary" in exactly one
// context: adjacent to the divider row every GFM table requires. Everywhere else it is
// ordinary punctuation — a shell pipe, a boolean-or, absolute-value bars — and reading
// "a | b" as "a, b" there would rewrite an ordinary sentence's meaning. So table
// membership is PROVEN once, from the divider outward (the header immediately above it,
// then every contiguous row below), never guessed line by line from a bare pipe.
//
// The header and the continuation rows are proven DIFFERENTLY, on purpose. GFM (and this
// codebase's own render.ts::normalizeTables) does not require outer pipes at all — `a | b`
// over `--- | ---` is a fully valid, pipeless table — so gating strictly on shape would
// leave a real on-page <table> partly unspoken. A header is accepted by shape
// (looksLikeTableRow) OR by its cell count exactly matching the divider it immediately
// precedes: a divider is a highly specific run of dash-groups a stray sentence essentially
// never precedes by coincidence, so this looser signal is safe there. A continuation row
// below stays shape-gated ONLY — no cell-count fallback — because that is exactly where
// the corruption this file was already burned by lived: ordinary prose trailing a real
// table's last row, sharing its column count purely by chance ("See y | z for details."
// right after a 2-column table). A trailing sentence has no comparable structural pairing
// to a divider that would make a false positive rare, so a pipeless table's BODY rows are
// deliberately NOT spoken as a table here — only a pipeless header is. Full symmetry would
// need the real GFM table lexer, not a line-level heuristic.
const tableLineIndices = (lines: ReadonlyArray<string>): ReadonlySet<number> => {
  const rows = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!isTableDivider(lines[i]!)) continue;
    rows.add(i);
    const dividerCells = splitCells(lines[i]!).length;
    const header = lines[i - 1];
    if (header !== undefined && (looksLikeTableRow(header) || splitCells(header).length === dividerCells)) {
      rows.add(i - 1);
    }
    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j]!;
      if (!looksLikeTableRow(row)) break;
      rows.add(j);
    }
  }
  return rows;
};

// The placeholder wrapper: a NUL character, built with String.fromCharCode rather than
// written as a literal in this source file — a control byte that cannot occur in real
// markdown, so restoring a span can never collide with prose that happens to contain the
// same digits. A PRINTABLE wrapper (even a bare space) risks exactly that collision:
// "wait 5 minutes" already has the shape "space, digit, space".
const SHIELD = String.fromCharCode(0);
const SHIELD_RE = new RegExp(`${SHIELD}(\\d+)${SHIELD}`, "g");

// [LAW:effects-at-boundaries] A hand-written linear scan, not a backtracking regex —
// deliberately, because this runs server-side on every page view with no cache and no
// length guard (this.astro's `prerender = false`), against UNTRUSTED paste content. A
// backreferenced backtick-run pattern (`/(`+)(.*?)\1/`) is exactly the shape that invites
// catastrophic backtracking: a crafted line of thousands of backticks with no matching
// close forces the engine to retry every run-length against every content-length before
// giving up. This scan visits each character a bounded number of times regardless of
// input shape, so a hostile paste costs proportionally more CPU, never combinatorially
// more.
//
// The delimiter rule mirrors CommonMark: a run of backticks opens a span, and it closes
// on the NEXT run of the SAME length (not merely at-least — unlike code fences, a code
// span's closer must match exactly). A run with no same-length closer later on the line
// is not a span at all; its backticks are left as literal text, exactly as an unclosed
// span reads on the page.
const shieldCodeSpans = (line: string): { readonly text: string; readonly shielded: ReadonlyArray<string> } => {
  const shielded: string[] = [];
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i++;
      continue;
    }
    let openEnd = i;
    while (line[openEnd] === "`") openEnd++;
    const openLength = openEnd - i;

    let k = openEnd;
    let closeStart = -1;
    while (k < line.length) {
      if (line[k] === "`") {
        let runEnd = k;
        while (line[runEnd] === "`") runEnd++;
        if (runEnd - k === openLength) {
          closeStart = k;
          break;
        }
        k = runEnd;
      } else {
        k++;
      }
    }

    if (closeStart === -1) {
      // No same-length closer anywhere ahead: this run is literal text, not a delimiter.
      out += line.slice(i, openEnd);
      i = openEnd;
      continue;
    }
    const token = `${SHIELD}${shielded.length}${SHIELD}`;
    shielded.push(line.slice(openEnd, closeStart));
    out += token;
    i = closeStart + openLength;
  }
  return { text: out, shielded };
};

const speakLine = (line: string, isTable: boolean): string => {
  // Inline code is protected from every other inline rule by being pulled out FIRST and
  // swapped back in verbatim after — the same isolation fenced blocks get at the line
  // level, applied here at the span level. Without this, a markdown token literally
  // written inside a code span (a link, a bold marker, a literal pipe) would be
  // interpreted as real markdown by rules meant for the surrounding prose, corrupting
  // the exact syntax the span exists to display verbatim.
  const { text: withPlaceholders, shielded } = shieldCodeSpans(line);

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
  //
  // `(?<!\\)` excludes an ESCAPED pipe from the boundary rewrite — GFM (and this
  // codebase's own render.ts, which actually renders these pastes as a real <table>)
  // treats `\|` inside a cell as a literal character, not a separator, so a cell written
  // `` a\|b `` is one cell "a|b" on the page and must stay one utterance here too. The
  // trailing unescape restores the literal pipe the boundary rewrite deliberately skipped.
  const tabled = isTable
    ? inlined
        .replace(/[ \t]*(?<!\\)\|[ \t]*/g, ", ")
        .replace(/^,[ \t]*|,[ \t]*$/g, "")
        .replace(/\\\|/g, "|")
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
  // A chart is spine-visible like text/insight, not a "detail" count — and its
  // blockText is "", so the spoken pass simply contributes nothing for it
  // (honest silence, never an invented narration of numbers).
  chart: null,
};

// usage is checked by kind directly because it is the one "meta" kind that is genuinely
// unspeakable as numbers — turn-summary, the other meta kind, is real prose and is SPOKEN
// below, not folded into this count.
//
// usage is COUNTED, not merely detected: a single continuous agentic turn (several
// tool-call round-trips, each its own LLM completion) commonly carries several distinct
// usage blocks — buildTurns flushes one per message id, and deriveDialogue only closes an
// assistant node on a user/system message — and renderDialogueHtml draws each one as its
// own separate widget. A boolean collapsed every count to "a token usage note" (always
// singular), silently undercounting the exact way the sibling per-kind counts above were
// already fixed to avoid.
const detailAnnouncement = (blocks: ReadonlyArray<AssistantBlock>): string => {
  const counts: Partial<Record<AssistantBlock["kind"], number>> = {};
  for (const b of blocks) {
    if (blockVisibility(b) !== "detail") continue;
    counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  }
  const usageCount = blocks.filter((b) => b.kind === "usage").length;
  const counted = (Object.keys(DETAIL_UNIT) as ReadonlyArray<AssistantBlock["kind"]>)
    .map((kind) => {
      const n = counts[kind];
      const unit = DETAIL_UNIT[kind];
      return n !== undefined && unit !== null ? plural(n, unit) : "";
    })
    .filter((p) => p !== "");
  const parts = usageCount > 0 ? [...counted, plural(usageCount, "token usage note")] : counted;
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
// rendered as a visible <aside> — so it is SPOKEN, in the narrator voice, because it is
// the source's OWN annotation about the conversation, not a line either party actually
// said. It is spoken VERBATIM (collapsed whitespace only), NOT through speakableSegments'
// markdown-stripping pipeline: renderDialogueHtml draws it with escapeHtml alone, never
// renderMarkdown — unlike text/insight blocks, whose renderer counterpart genuinely does
// call renderMarkdown, which is what makes speakableSegments the right transform for
// THEM. Running turn-summary through the same markdown-stripping rules would silently
// speak clean prose ("Tool calls: Bash, Read") for text the page shows completely literal
// ("Tool calls: `Bash`, `Read`") — diverging from what a reader actually sees, the one
// thing this module exists to mirror.
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
      const text = collapse(b.text);
      return text === "" ? [] : [at("narrator", text)];
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
