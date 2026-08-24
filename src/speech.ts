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

import type { DisplayNode, SpineNode, ViewableDialogue, AssistantBlock } from "./dialogue";
import { blockVisibility, nodeVisibleProse, turnAnchorId } from "./dialogue";

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

const FENCE = /^[ \t]*(?:```+|~~~+)[ \t]*([^\s`]*)[ \t]*$/;

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
const INLINE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Images announce their alt text — the picture cannot be spoken, but what it was
  // labelled can, so it is described rather than dropped [LAW:no-silent-failure].
  [/!\[([^\]]*)\]\([^)]*\)/g, "image, $1"],
  // Links keep the label, lose the target.
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/<https?:\/\/[^>]+>/g, "link"],
  // Inline code is usually an identifier or a flag — short, and genuinely part of the
  // sentence, so it is READ. Only its backticks go.
  [/`([^`]*)`/g, "$1"],
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

// A rule that is entirely presentational: a horizontal rule or a table's divider row has
// no spoken form at all, so the line is dropped rather than voiced as punctuation.
const isRuleLine = (line: string): boolean =>
  /^[ \t]*(?:[-*_][ \t]*){3,}$/.test(line) || /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(line);

const speakLine = (line: string): string => {
  const led = LEADING_RULES.reduce((acc, [re, to]) => acc.replace(re, to), line);
  const inlined = INLINE_RULES.reduce((acc, [re, to]) => acc.replace(re, to), led);
  // A table row's pipes are column furniture; the cells are the content.
  return inlined.replace(/[ \t]*\|[ \t]*/g, ", ").replace(/^,[ \t]*|,[ \t]*$/g, "");
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
  let fence: { language: string; lines: number } | null = null;

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

  for (const line of markdown.split("\n")) {
    const fenced = FENCE.exec(line);
    if (fence !== null) {
      // Inside a block: the only line that means anything is the one that closes it.
      if (fenced === null) fence.lines += 1;
      else flushFence();
      continue;
    }
    if (fenced !== null) {
      flushProse();
      fence = { language: fenced[1] ?? "", lines: 0 };
      continue;
    }
    prose.push(isRuleLine(line) ? "" : speakLine(line));
  }
  flushProse();
  flushFence();
  return segments;
};

// ── dialogue → utterances ────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] What a node's detail holds, counted rather than re-listed.
// The visual renderer folds thinking / tool calls / subagents behind a disclosure, so the
// audio does not read them — but it does SAY they are there. A listener who is told
// "2 tool calls" knows the conversation had a shape the audio abridged; one who is told
// nothing has been quietly handed a different conversation [LAW:no-silent-failure].
//
// It counts by blockVisibility rather than by naming kinds, so a new AssistantBlock kind
// is classified once, in dialogue.ts, and reaches this announcement for free.
const detailAnnouncement = (blocks: ReadonlyArray<AssistantBlock>): string => {
  const detail = blocks.filter((b) => blockVisibility(b) === "detail");
  const tools = detail.filter((b) => b.kind === "tool-call").length;
  const thinking = detail.filter((b) => b.kind === "thinking").length;
  const subagents = detail.filter((b) => b.kind === "subagent").length;
  const parts = [
    tools > 0 ? plural(tools, "tool call") : "",
    thinking > 0 ? plural(thinking, "thinking block") : "",
    subagents > 0 ? plural(subagents, "subagent run") : "",
  ].filter((p) => p !== "");
  return parts.length === 0 ? "" : `${parts.join(", ")} not read aloud`;
};

// The voice a spine node speaks in. An assistant node is the assistant; a spoken node is
// whichever of user/system it carries — the same discriminant the renderer colours by.
const nodeVoice = (node: SpineNode): Voice => (node.kind === "spoken" ? node.role : "assistant");

// [LAW:dataflow-not-control-flow] One node in, its utterances out — the same operations
// for every node, with the node's data deciding how many utterances come back (possibly
// zero, for a node whose visible prose is empty). Nothing here branches on node kind
// beyond the voice above, because nodeVisibleProse already answered "what does a reader
// of this node actually see" for both arms.
const nodeUtterances = ({ index, node }: DisplayNode): ReadonlyArray<Utterance> => {
  const anchor = turnAnchorId(index);
  const at = (voice: Voice, text: string): Utterance => ({ index, anchor, voice, text });

  const voice = nodeVoice(node);
  const spoken = speakableSegments(nodeVisibleProse(node)).map((seg) =>
    at(seg.kind === "quoted" ? voice : "narrator", seg.text),
  );

  const detail = node.kind === "assistant" ? detailAnnouncement(node.blocks) : "";
  return detail === "" ? spoken : [...spoken, at("narrator", detail)];
};

// [LAW:one-source-of-truth] The spoken projection of the SAME ViewableDialogue the
// renderer draws and deriveSpineOutline reads. Consuming that view rather than the raw
// Turn[] is what keeps the audio and the page telling one story: a node an authored
// overlay omitted is absent from the view, and so is never spoken — without this module
// knowing overlays exist at all.
export const deriveUtterances = (view: ViewableDialogue): ReadonlyArray<Utterance> =>
  view.flatMap(nodeUtterances);
