// [LAW:decomposition] The read-along painter: it marks, inside the turn card the reader is
// looking at, the words the neural voice is saying. One sentence, no "and": this module
// finds the utterance's words in the page and paints a span of them. It decides nothing
// about WHAT is said (speech.ts), WHERE playback is (unitPlayer.ts) or WHICH span to paint
// (speechManifest.cursorAt) — it is handed an utterance, its turn-mates and a span in
// utterance-text coordinates, and paints.
//
// WHY A WORD MAP EXISTS AT ALL. An utterance is derived from the stored dialogue with the
// markdown stripped and whitespace collapsed; the card is that same markdown rendered to
// HTML. Neither knows the other's character offsets, so a cursor in utterance coordinates
// has no address in the page until the words are matched up. The match is on WORDS, the
// one unit both texts share: the utterance's words in order (the manifest's own rule,
// `wordSpans`, so a painted word is exactly a timed word [LAW:one-source-of-truth]) against
// the card's words in document order, with fenced code, folded details and usage asides
// left out because speech.ts never reads those aloud — it announces them, and an
// announcement has no words on the page to paint.
//
// [LAW:no-silent-failure] The match is honest about what it cannot place. `alignWords` is a
// monotone scan inside a window: a spoken word with no page word in reach is unmatched and
// stays unpainted, never snapped to the nearest lookalike; the turn highlight (the caller's
// `speaking` class on the card) still says where we are. Cost, stated once: a run of page
// words longer than the window that speech skipped (an image's alt text, say) desyncs the
// rest of that card, which shows as no word paint until the next card.
//
// HOW IT PAINTS. On first entry to a card, every matched word of that card is wrapped in a
// span — the ticket's "wrap the utterance's words in spans at play time" — and painting a
// cursor is toggling one class on the spans whose word intersects it. Leaving the card
// unwraps: each span becomes its text again and the card's text nodes are re-merged, so
// the DOM the renderer produced is restored. The Custom Highlight API would paint without
// touching the DOM; that refinement is the UX epic's [LAW:carrying-cost].

import type { Utterance } from "./speech";
import { wordSpans, type WordSpan } from "./speechManifest";

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

export const pageWords = (card: Element): ReadonlyArray<PageWord> => {
  const walker = card.ownerDocument.createTreeWalker(card, SHOW_TEXT);
  const words: PageWord[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    // A text node reached from the card has an element parent; `?? card` states the
    // type's one impossible arm as the card itself, which the same selector then judges.
    if ((text.parentElement ?? card).closest(UNSPOKEN) !== null) continue;
    for (const span of wordSpans(text.data, 0)) words.push({ node: text, start: span.charStart, end: span.charEnd });
  }
  return words;
};

const textOf = (word: PageWord): string => word.node.data.slice(word.start, word.end);

// ── the painter ─────────────────────────────────────────────────────────────────────

// What the panel hands the painter: the utterance being said, every utterance of the same
// turn in order (the match runs over the whole card, so a cursor in the third paragraph
// lands in the third paragraph), and the span to paint in utterance-text coordinates.
export interface ReadAlongAt {
  readonly utterance: Utterance;
  readonly turn: ReadonlyArray<Utterance>;
  readonly span: WordSpan;
}

export interface Painter {
  readonly paint: (at: ReadAlongAt) => void;
  // Unwraps whatever card is wrapped; the page is as the renderer left it.
  readonly clear: () => void;
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

const intersects = (a: WordSpan, b: WordSpan): boolean => a.charStart < b.charEnd && b.charStart < a.charEnd;

// Wrap every matched word of the card. Page words are grouped by text node and each node
// is rebuilt once — text, span, text, span, … — so no offset goes stale mid-pass.
const wrapCard = (doc: Document, anchor: string, turn: ReadonlyArray<Utterance>): WrappedCard => {
  const card = doc.getElementById(anchor);
  const byUtterance = new Map<Utterance, Wrapped[]>(turn.map((u) => [u, []]));
  // An utterance whose card is not in this document (the page rendered a slice) has no
  // words to paint: an empty map, not an error — the turn highlight still follows.
  if (card === null) return { anchor, card, byUtterance };

  // Narrator utterances — announcements, folded-detail counts, the turn summary — are
  // exactly the text `pageWords` leaves out (UNSPOKEN, above), so they are not in the
  // spoken pool: a word they share with the prose ("code", "then") must not pull that prose
  // word to them [LAW:one-source-of-truth]. Each keeps its (empty) entry in the map and
  // paints nothing.
  const spoken = turn
    .filter((utterance) => utterance.voice !== "narrator")
    .flatMap((utterance) => wordSpans(utterance.text, 0).map((word) => ({ utterance, word })));
  const page = pageWords(card);
  const matched = alignWords(
    spoken.map(({ utterance, word }) => utterance.text.slice(word.charStart, word.charEnd)),
    page.map(textOf),
  );

  // Which spoken word each page word became, grouped by the node it lives in.
  const byNode = new Map<Text, { readonly page: PageWord; readonly spokenIndex: number }[]>();
  matched.forEach((pageIndex, spokenIndex) => {
    if (pageIndex === undefined) return;
    const word = page[pageIndex];
    if (word === undefined) throw new Error(`read-along: matched page word ${pageIndex} of ${page.length}`);
    const group = byNode.get(word.node) ?? [];
    group.push({ page: word, spokenIndex });
    byNode.set(word.node, group);
  });

  for (const [node, group] of byNode) {
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (const { page: word, spokenIndex } of group) {
      fragment.append(node.data.slice(cursor, word.start));
      const el = doc.createElement("span");
      el.className = WORD_CLASS;
      el.textContent = textOf(word);
      fragment.append(el);
      cursor = word.end;
      const said = spoken[spokenIndex];
      if (said === undefined) throw new Error(`read-along: matched spoken word ${spokenIndex} of ${spoken.length}`);
      const words = byUtterance.get(said.utterance);
      if (words === undefined) throw new Error(`read-along: a spoken word of a turn-mate not in the turn (${said.utterance.anchor})`);
      words.push({ word: said.word, text: textOf(word), el });
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
  wrapped.card?.normalize();
};

export const createPainter = (doc: Document): Painter => {
  // [LAW:no-shared-mutable-globals] The one card wrapped at a time; owned here.
  let current: WrappedCard | null = null;

  const clear = (): void => {
    if (current !== null) unwrapCard(doc, current);
    current = null;
  };

  return {
    paint: ({ utterance, turn, span }) => {
      if (current === null || current.anchor !== utterance.anchor) {
        clear();
        current = wrapCard(doc, utterance.anchor, turn);
      }
      for (const [said, words] of current.byUtterance) {
        for (const { word, el } of words) el.classList.toggle(CURSOR_CLASS, said === utterance && intersects(word, span));
      }
    },
    clear,
  };
};
