// [LAW:decomposition] The read-along painter: it marks, on the page, where the voice is —
// the turn card, the segment inside it, the word — and answers the reverse, which place in
// the text a point on the page is. One sentence, no "and" hiding a second job: this module
// translates between utterance-text coordinates and the rendered card, both ways. It
// decides nothing about WHAT is said (speech.ts), WHERE playback is (the performers) or
// WHICH cursor to paint (speechManifest.cursorAt) — it is handed an utterance, its
// turn-mates and a cursor, and paints; it is handed a caret, and names a mark.
//
// WHY A WORD MAP EXISTS AT ALL. An utterance is derived from the stored dialogue with the
// markdown stripped and whitespace collapsed; the card is that same markdown rendered to
// HTML. Neither knows the other's character offsets, so a cursor in utterance coordinates
// has no address in the page until the words are matched up. The match is on WORDS, the
// one unit both texts share: the utterance's words in order (the manifest's own rule,
// `wordSpans`, so a painted word is exactly a timed word [LAW:one-source-of-truth]) against
// the card's words in document order, with fenced code, folded details and usage asides
// left out because speech.ts never reads those aloud — it announces them, and an
// announcement has no words on the page to paint. ONE match, `matchCard`, serves both
// directions: the words it wraps for painting are the words a tap can name
// [LAW:single-enforcer].
//
// [LAW:no-silent-failure] The match is honest about what it cannot place. `alignWords` is a
// monotone scan inside a window: a spoken word with no page word in reach is unmatched and
// stays unpainted, never snapped to the nearest lookalike; the turn mark on the card still
// says where we are. Cost, stated once: a run of page words longer than the window that
// speech skipped (an image's alt text, say) desyncs the rest of that card, which shows as
// no word paint until the next card. A tap on text nothing says — a code block, a fold,
// the usage aside — names no mark; the announcement that stands in for a code block has
// no words on the page to tap.
//
// HOW IT PAINTS. On first entry to a card, every matched word of that card is wrapped in a
// span and the card takes the turn class; painting a cursor is toggling two classes on the
// spans — the segment's on the words the segment covers, the word's on the word — so the
// page shows a light sentence and a bright word inside it. Leaving the card unwraps: each
// span becomes its text again and the card's text nodes are re-merged, so the DOM the
// renderer produced is restored. The Custom Highlight API would paint without touching
// the DOM and is not used yet: it needs this same match plus a Range per word, and the
// spans double as the elements the follow-scroll measures; that refinement is deferred,
// its cost being one wrap and unwrap per card entered [LAW:carrying-cost].

import type { Mark } from "./performer";
import type { Utterance } from "./speech";
import { wordSpans, type Cursor, type WordSpan } from "./speechManifest";

// ── the pure match ──────────────────────────────────────────────────────────────────

// Two words are the same word when they agree letter for letter and digit for digit,
// whatever case or attached punctuation they wear: the utterance says "cell," where a
// table cell shows "cell", and "Hello" opens a sentence the page may set in caps.
export const wordKey = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// How far past the last match the scan looks for the next spoken word before calling it
// unmatched. Wide enough to step over a heading's number or a list's marker text, narrow
// enough that a common word ("the") cannot be matched a paragraph away.
export const MATCH_WINDOW = 40;

// For each spoken word, the index of the page word it is, or `undefined`. Monotone: a
// match is always after the previous match, so painted words never run backwards.
export const alignWords = (
  spoken: ReadonlyArray<string>,
  page: ReadonlyArray<string>,
  window: number = MATCH_WINDOW,
): ReadonlyArray<number | undefined> => {
  const keys = page.map(wordKey);
  let from = 0;
  return spoken.map((word) => {
    const key = wordKey(word);
    const limit = Math.min(keys.length, from + window);
    for (let i = from; i < limit; i++) {
      if (keys[i] === key) {
        from = i + 1;
        return i;
      }
    }
    return undefined;
  });
};

// ── the page's words ────────────────────────────────────────────────────────────────

// A word in the page: the text node holding it and its offsets within that node.
export interface PageWord {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

// What the narrator's voice covers on the page: fenced code (<pre>), every native fold
// (<details>, which is both the detail blocks and a collapsed turn), the usage aside, the
// turn-summary aside, and anything hidden. None of it is in the spoken pool below, so none
// of it is a match target. The turn-summary is the one block here the narrator does read,
// verbatim; it is left unpainted until an utterance says whether its text is the page's own
// (slopspot-read-along-a35.wqz) rather than matched by a voice that also names what is not.
const UNSPOKEN = "pre, details, aside.bubble-usage, aside.bubble-turn-summary, [hidden], [aria-hidden='true']";
const SHOW_TEXT = 4;
const TEXT_NODE = 3;

// A text node reached from the card has an element parent; `?? card` states the type's
// one impossible arm as the card itself, which the same selector then judges.
const unspoken = (text: Text, card: Element): boolean => (text.parentElement ?? card).closest(UNSPOKEN) !== null;

export const pageWords = (card: Element): ReadonlyArray<PageWord> => {
  const walker = card.ownerDocument.createTreeWalker(card, SHOW_TEXT);
  const words: PageWord[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (unspoken(text, card)) continue;
    for (const span of wordSpans(text.data, 0)) words.push({ node: text, start: span.charStart, end: span.charEnd });
  }
  return words;
};

const textOf = (word: PageWord): string => word.node.data.slice(word.start, word.end);

// ── the match of a card ─────────────────────────────────────────────────────────────

// Every utterance of the page on one anchor, in page order: what one turn card says.
export const turnOf = (utterances: ReadonlyArray<Utterance>, anchor: string): ReadonlyArray<Utterance> =>
  utterances.filter((utterance) => utterance.anchor === anchor);

// A page word a spoken word is: where it sits in the page, and which utterance's word.
interface Match {
  readonly page: PageWord;
  readonly utterance: Utterance;
  readonly word: WordSpan;
}

// The card's words matched against its turn, in page order. Narrator utterances —
// announcements, folded-detail counts, the turn summary — are exactly the text
// `pageWords` leaves out (UNSPOKEN, above), so they are not in the spoken pool: a word they
// share with the prose ("code", "then") must not pull that prose word to them
// [LAW:one-source-of-truth].
const matchCard = (card: Element, turn: ReadonlyArray<Utterance>): ReadonlyArray<Match> => {
  const spoken = turn
    .filter((utterance) => utterance.voice !== "narrator")
    .flatMap((utterance) => wordSpans(utterance.text, 0).map((word) => ({ utterance, word })));
  const page = pageWords(card);
  const matched = alignWords(
    spoken.map(({ utterance, word }) => utterance.text.slice(word.charStart, word.charEnd)),
    page.map(textOf),
  );
  return matched.flatMap((pageIndex, spokenIndex) => {
    if (pageIndex === undefined) return [];
    const word = page[pageIndex];
    const said = spoken[spokenIndex];
    if (word === undefined || said === undefined) throw new Error(`read-along: matched page word ${pageIndex} to spoken word ${spokenIndex}`);
    return [{ page: word, utterance: said.utterance, word: said.word }];
  });
};

// ── the painter ─────────────────────────────────────────────────────────────────────

// What the panel hands the painter: the utterance being said, every utterance of the same
// turn in order (the match runs over the whole card, so a cursor in the third paragraph
// lands in the third paragraph), and the cursor in utterance-text coordinates.
export interface ReadAlongAt extends Cursor {
  readonly utterance: Utterance;
  readonly turn: ReadonlyArray<Utterance>;
}

// What was painted, for whoever keeps it in view: the card's anchor, and the element that
// carries the cursor — the word, else the first word of the segment, else the card.
export interface Painted {
  readonly anchor: string;
  readonly el: Element;
}

export interface Painter {
  // Paints the cursor, or with null paints nothing: whatever card was wrapped is unwrapped
  // and the page is as the renderer left it. Null back when there is nothing on this page
  // to keep in view: no cursor, or an utterance whose card is not in this document.
  readonly paint: (at: ReadAlongAt | null) => Painted | null;
}

// A wrapped word: where it is in the utterance, and the span that now holds it.
interface Wrapped {
  readonly word: WordSpan;
  readonly text: string;
  readonly el: HTMLElement;
}

interface WrappedCard {
  readonly anchor: string;
  readonly card: Element | null;
  readonly byUtterance: ReadonlyMap<Utterance, ReadonlyArray<Wrapped>>;
}

export const WORD_CLASS = "ra-word";
export const CURSOR_CLASS = "ra-on";
export const SEGMENT_CLASS = "ra-in";
// The turn being spoken, on its card: the one mark that follows the voice even where no
// word of the card can be placed.
export const TURN_CLASS = "speaking";

const intersects = (a: WordSpan, b: WordSpan): boolean => a.charStart < b.charEnd && b.charStart < a.charEnd;

// Wrap every matched word of the card. Page words are grouped by text node and each node
// is rebuilt once — text, span, text, span, … — so no offset goes stale mid-pass.
const wrapCard = (doc: Document, anchor: string, turn: ReadonlyArray<Utterance>): WrappedCard => {
  const card = doc.getElementById(anchor);
  const byUtterance = new Map<Utterance, Wrapped[]>(turn.map((u) => [u, []]));
  // An utterance whose card is not in this document (the page rendered a slice) has no
  // words to paint: an empty map, not an error.
  if (card === null) return { anchor, card, byUtterance };
  card.classList.add(TURN_CLASS);

  const byNode = new Map<Text, Match[]>();
  for (const match of matchCard(card, turn)) {
    const group = byNode.get(match.page.node) ?? [];
    group.push(match);
    byNode.set(match.page.node, group);
  }

  for (const [node, group] of byNode) {
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (const { page: word, utterance, word: said } of group) {
      fragment.append(node.data.slice(cursor, word.start));
      const el = doc.createElement("span");
      el.className = WORD_CLASS;
      el.textContent = textOf(word);
      fragment.append(el);
      cursor = word.end;
      const words = byUtterance.get(utterance);
      if (words === undefined) throw new Error(`read-along: a spoken word of a turn-mate not in the turn (${utterance.anchor})`);
      words.push({ word: said, text: textOf(word), el });
    }
    fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }
  return { anchor, card, byUtterance };
};

const unwrapCard = (doc: Document, wrapped: WrappedCard): void => {
  for (const words of wrapped.byUtterance.values()) {
    for (const { text, el } of words) el.replaceWith(doc.createTextNode(text));
  }
  wrapped.card?.classList.remove(TURN_CLASS);
  wrapped.card?.normalize();
};

export const createPainter = (doc: Document): Painter => {
  // [LAW:no-shared-mutable-globals] The one card wrapped at a time; owned here.
  let current: WrappedCard | null = null;

  const clear = (): void => {
    if (current !== null) unwrapCard(doc, current);
    current = null;
  };

  const paint = (at: ReadAlongAt | null): Painted | null => {
    if (at === null) {
      clear();
      return null;
    }
    const { utterance, turn, segment, word } = at;
    if (current === null || current.anchor !== utterance.anchor) {
      clear();
      current = wrapCard(doc, utterance.anchor, turn);
    }
    let onWord: Element | null = null;
    let inSegment: Element | null = null;
    for (const [said, words] of current.byUtterance) {
      for (const wrapped of words) {
        const lit = said === utterance && word !== null && intersects(wrapped.word, word);
        const covered = said === utterance && intersects(wrapped.word, segment);
        wrapped.el.classList.toggle(CURSOR_CLASS, lit);
        wrapped.el.classList.toggle(SEGMENT_CLASS, covered);
        if (lit && onWord === null) onWord = wrapped.el;
        if (covered && inSegment === null) inSegment = wrapped.el;
      }
    }
    const el = onWord ?? inSegment ?? current.card;
    return el === null ? null : { anchor: current.anchor, el };
  };

  return { paint };
};

// ── the reverse: a point on the page to a mark ──────────────────────────────────────

// A place in the document's text, as the browser reports the one under a pointer.
export interface Caret {
  readonly node: Node;
  readonly offset: number;
}

// [LAW:parse-dont-validate] The browser's caret-from-point, behind its two spellings: the
// standard `caretPositionFromPoint` and WebKit's older `caretRangeFromPoint`. Exactly the
// members read, so a document with either satisfies it structurally; one with neither is
// a browser this page cannot place a tap in, and says so.
interface CaretSource {
  readonly caretPositionFromPoint?: (x: number, y: number) => { readonly offsetNode: Node; readonly offset: number } | null;
  readonly caretRangeFromPoint?: (x: number, y: number) => { readonly startContainer: Node; readonly startOffset: number } | null;
}

export const caretAt = (doc: Document, x: number, y: number): Caret | null => {
  const source: CaretSource = doc;
  if (source.caretPositionFromPoint !== undefined) {
    const position = source.caretPositionFromPoint.call(doc, x, y);
    return position === null ? null : { node: position.offsetNode, offset: position.offset };
  }
  if (source.caretRangeFromPoint !== undefined) {
    const range = source.caretRangeFromPoint.call(doc, x, y);
    return range === null ? null : { node: range.startContainer, offset: range.startOffset };
  }
  throw new Error("read-along: this browser cannot place a caret from a point");
};

// The mark a caret names: the matched word the caret is in, or the first matched word
// after it (a tap between words, or on punctuation, starts the next word). Null when the
// caret is not in text a voice says: outside every turn card, inside an unspoken block,
// or past the last word the card and its turn share. The caret is a text position because
// the browser's own caret placement (caretAt) reports one; a caret in an element is a
// point between children, not in text, and names nothing.
export const markAt = (utterances: ReadonlyArray<Utterance>, caret: Caret): Mark | null => {
  if (caret.node.nodeType !== TEXT_NODE) return null;
  const text = caret.node as Text;
  const anchors = new Set(utterances.map((utterance) => utterance.anchor));
  let card: Element | null = text.parentElement;
  while (card !== null && !anchors.has(card.id)) card = card.parentElement;
  if (card === null || unspoken(text, card)) return null;

  const doc = card.ownerDocument;
  const atOrAfter = matchCard(card, turnOf(utterances, card.id)).find(({ page }) => {
    const range = doc.createRange();
    range.setStart(page.node, page.start);
    range.setEnd(page.node, page.end);
    return range.comparePoint(text, caret.offset) <= 0;
  });
  if (atOrAfter === undefined) return null;
  const utterance = utterances.indexOf(atOrAfter.utterance);
  if (utterance === -1) throw new Error(`read-along: a matched utterance not in the page (${atOrAfter.utterance.anchor})`);
  return { utterance, char: atOrAfter.word.charStart };
};

// [LAW:parse-dont-validate] A click, parsed into the mark it seeks to, or null when the
// click is doing something else — following a link, pressing a control, opening a fold,
// ending a drag that selected text — or lands on nothing a voice says. The one unit that
// decides what a tap on the page means for the listen; the page does not re-ask.
const CONTROLS = "a, button, summary, input, textarea, select, label";

export const tapMark = (doc: Document, utterances: ReadonlyArray<Utterance>, tap: MouseEvent): Mark | null => {
  const target = tap.target;
  const control = target instanceof Element && target.closest(CONTROLS) !== null;
  const selecting = !(doc.defaultView?.getSelection()?.isCollapsed ?? true);
  if (tap.defaultPrevented || control || selecting) return null;
  const caret = caretAt(doc, tap.clientX, tap.clientY);
  return caret === null ? null : markAt(utterances, caret);
};
