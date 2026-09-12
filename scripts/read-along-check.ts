// The read-along painter and its reverse, the tap, driven under jsdom
// (slopspot-read-along-q35.9, slopspot-read-along-a35.2).
// Run: `tsx scripts/read-along-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is what a reader could see: which words
// in the card are lit for a given cursor, that the card reads the same before, during
// and after painting, that leaving a card puts its DOM back as the renderer left it, and
// which place in the speech a caret on the page names.
// Nothing here asserts how the match is implemented beyond its contract: monotone,
// punctuation-blind, honest about what it cannot place.

import { JSDOM } from "jsdom";
import type { Mark } from "../src/performer";
import {
  alignWords,
  caretSource,
  createPainter,
  CURSOR_CLASS,
  markAt,
  pageWords,
  SEGMENT_CLASS,
  TURN_CLASS,
  WORD_CLASS,
  type Caret,
  type Painted,
  type ReadAlongAt,
} from "../src/readAlong";
import type { Utterance } from "../src/speech";
import { wordSpans, type WordSpan } from "../src/speechManifest";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── the pure match ────────────────────────────────────────────────────────────────────

console.log("alignWords");
{
  const same = ["Hello", "world"];
  assert("identical sequences match position for position", alignWords(same, same).join() === "0,1");
  assert(
    "case and attached punctuation do not separate a word from itself",
    alignWords(["hello,", "World."], ["Hello", "world"]).join() === "0,1",
  );
  const withAnnouncement = alignWords(["Here", "is", "Code", "block,", "two", "lines.", "Then", "more"], ["Here", "is", "Then", "more"]);
  assert(
    "words with no page counterpart are unmatched and do not consume page words",
    withAnnouncement.map((m) => (m === undefined ? "-" : String(m))).join() === "0,1,-,-,-,-,2,3",
  );
  const skipped = alignWords(["a", "b"], ["a", "x", "y", "b"]);
  assert("page words speech never said are stepped over", skipped.join() === "0,3");
  assert("a page word beyond the window is out of reach, not guessed at", alignWords(["a", "b"], ["a", "x", "y", "b"], 2)[1] === undefined);
  const monotone = alignWords(["b", "a"], ["a", "b"]);
  assert("matches never run backwards", monotone[0] === 1 && monotone[1] === undefined);
}

// ── the page's words ──────────────────────────────────────────────────────────────────

// A turn card in the renderer's shape: prose with inline markup, a fenced block the
// speech announces, a detail fold, and the usage aside — three things never read aloud.
const CARD = `
  <article class="bubble bubble-assistant" id="t3" data-index="3">
    <div class="turn-text"><p>Here is the <strong>fix</strong>, in <code>parser.ts</code>:</p>
    <pre><code>const x = 1;\nreturn x;</code></pre>
    <p>Then it works. Ship it.</p></div>
    <details class="condensed"><summary>2 tool calls</summary><div>Bash ls -la</div></details>
    <aside class="bubble-turn-summary">Then it summarized.</aside>
    <aside class="bubble-usage">1,024 tokens</aside>
  </article>
  <article class="bubble bubble-user" id="t4" data-index="4"><p>Thanks!</p></article>`;

const dom = new JSDOM(`<!DOCTYPE html><body>${CARD}</body>`);
const doc = dom.window.document;
const card = doc.getElementById("t3");
if (card === null) throw new Error("fixture: no card");

console.log("pageWords");
{
  const words = pageWords(card).map((w) => w.node.data.slice(w.start, w.end));
  assert(
    "prose and inline code are words; fenced code, folds, the turn summary and the usage aside are not",
    // The comma and colon sit in their own text nodes beside the inline elements, so they
    // are punctuation runs, not words — exactly the manifest's rule.
    words.join(" ") === "Here is the fix in parser.ts Then it works. Ship it.",
  );
}

// ── the painter ───────────────────────────────────────────────────────────────────────

// The utterances speech.ts derives from that card: two quoted paragraphs around one
// announcement, all on anchor t3; and the next card's one line.
const say = (index: number, voice: Utterance["voice"], text: string): Utterance => ({ index, anchor: `t${index}`, voice, text });
const first = say(3, "assistant", "Here is the fix, in parser.ts:");
const announced = say(3, "narrator", "Code block, 2 lines.");
const second = say(3, "assistant", "Then it works. Ship it.");
const turn = [first, announced, second];
const thanks = say(4, "user", "Thanks!");
const page = [first, announced, second, thanks];

const texts = (cls: string): string => Array.from(doc.querySelectorAll(`.${cls}`), (el) => el.textContent ?? "").join(" ");
const lit = (): string => texts(CURSOR_CLASS);
const inSegment = (): string => texts(SEGMENT_CLASS);
const wrapped = (): number => doc.querySelectorAll(`.${WORD_CLASS}`).length;
const speaking = (): string => Array.from(doc.querySelectorAll(`.${TURN_CLASS}`), (el) => el.id).join();
const wordOf = (u: Utterance, n: number): WordSpan => {
  const span = wordSpans(u.text, 0)[n];
  if (span === undefined) throw new Error(`fixture: no word ${n} in "${u.text}"`);
  return span;
};
const whole = (u: Utterance): WordSpan => ({ charStart: 0, charEnd: u.text.length });
const at = (utterance: Utterance, turnOf: ReadonlyArray<Utterance>, segment: WordSpan, word: WordSpan | null): ReadAlongAt => ({ utterance, turn: turnOf, segment, word });
const painted = (p: Painted | null): string => (p === null ? "null" : `${p.anchor} ${p.el.tagName.toLowerCase()} ${p.el.textContent?.trim().split(/\s+/)[0] ?? ""}`);

console.log("createPainter");
{
  const original = card.innerHTML;
  const text = card.textContent;
  const painter = createPainter(doc);

  const onFix = painter.paint(at(first, turn, whole(first), wordOf(first, 3)));
  assert("the word tier lights exactly that word in the card, however it is punctuated", lit() === "fix");
  assert("the segment tier covers every matched word of the segment", inSegment() === "Here is the fix in parser.ts");
  assert("the card carries the turn class", speaking() === "t3");
  assert("what was painted names the card and the lit word", painted(onFix) === "t3 span fix");
  assert("the card still reads the same", card.textContent === text);
  assert("every matched word of the card is wrapped once", wrapped() === 11);

  const onCode = painter.paint(at(first, turn, whole(first), wordOf(first, 5)));
  assert("moving the cursor moves the light: the code span's word", lit() === "parser.ts" && painted(onCode) === "t3 span parser.ts");

  const onAnnouncement = painter.paint(at(announced, turn, whole(announced), null));
  assert("an announcement has no words on the page: nothing lit, nothing thrown", lit() === "" && inSegment() === "");
  assert("with no word to stand on, what was painted is the card itself", painted(onAnnouncement) === "t3 article Here");

  const onSentence = painter.paint(at(second, turn, whole(second), null));
  assert("a segment with no word lights no word and covers the whole sentence group", lit() === "" && inSegment() === "Then it works. Ship it.");
  assert("what was painted is then the segment's first word", painted(onSentence) === "t3 span Then");

  const ship = { charStart: second.text.indexOf("Ship"), charEnd: second.text.length };
  const onShip = painter.paint(at(second, turn, ship, wordOf(second, 3)));
  assert("a segment narrower than the utterance covers only its words", inSegment() === "Ship it." && lit() === "Ship" && painted(onShip) === "t3 span Ship");

  const onThanks = painter.paint(at(thanks, [thanks], whole(thanks), wordOf(thanks, 0)));
  assert("entering another card unwraps the last: its markup is exactly as rendered", card.innerHTML === original);
  assert("and the new card is lit and carries the turn class alone", lit() === "Thanks!" && speaking() === "t4" && painted(onThanks) === "t4 span Thanks!");

  const cleared = painter.paint(null);
  assert("paint(null) clears: nothing painted, no span or turn class remains anywhere", cleared === null && wrapped() === 0 && lit() === "" && speaking() === "" && doc.getElementById("t4")?.innerHTML === "<p>Thanks!</p>");

  const elsewhere = say(9, "user", "Not on this page.");
  const offPage = painter.paint(at(elsewhere, [elsewhere], whole(elsewhere), wordOf(elsewhere, 0)));
  assert("an utterance whose card is not in the document paints nothing, returns nothing to follow, does not throw", offPage === null && wrapped() === 0);
  painter.paint(null);

  // A narrator utterance whose wording shares a word with the prose: it is not in the
  // spoken pool, so the prose word stays with the prose utterance that says it.
  const decoy = say(3, "narrator", "Then a code block.");
  const decoyed = [first, decoy, second];
  painter.paint(at(decoy, decoyed, whole(decoy), null));
  assert("a narrator utterance sharing a word with the prose paints nothing", lit() === "" && inSegment() === "");
  painter.paint(at(second, decoyed, whole(second), null));
  assert("and the prose utterance keeps its every word", inSegment() === "Then it works. Ship it.");
  painter.paint(null);
  assert("unwrapped exactly as rendered", card.innerHTML === original);
}

// ── the reverse: a caret to a mark ────────────────────────────────────────────────────

// The text node under `root` holding `snippet`: where a tap's caret lands, as the
// browser would report it.
const textNodeWith = (root: Node, snippet: string): Text => {
  const walker = doc.createTreeWalker(root, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node as Text).data.includes(snippet)) return node as Text;
  }
  throw new Error(`fixture: no text node holding "${snippet}"`);
};
const caret = (node: Node, offset: number): Caret => ({ node, offset });
const markOf = (m: Mark | null): string => (m === null ? "none" : `${m.utterance}:${m.char}`);
const charOf = (u: Utterance, snippet: string): number => u.text.indexOf(snippet);

console.log("markAt");
{
  const mark = (node: Node, offset: number): string => markOf(markAt(page, caret(node, offset)));
  const opening = textNodeWith(card, "Here is the");
  assert("a caret inside a word names that word", mark(opening, 6) === `0:${charOf(first, "is")}`);
  assert("a caret on the space after a word names the next word, across an element boundary", mark(opening, opening.data.length) === `0:${charOf(first, "fix")}`);
  assert("a caret on punctuation between words names the word after it", mark(textNodeWith(card, ", in"), 0) === `0:${charOf(first, "in ")}`);
  assert("a caret in an inline code span names its word", mark(textNodeWith(card, "parser.ts"), 3) === `0:${charOf(first, "parser.ts")}`);
  assert("a caret in the second paragraph names a word of the second utterance", mark(textNodeWith(card, "Ship it"), 15) === `2:${charOf(second, "Ship")}`);
  assert("a caret in a fenced code block names nothing: the block is announced, not read", mark(textNodeWith(card, "const x"), 2) === "none");
  assert("a caret in a fold's summary names nothing", mark(textNodeWith(card, "2 tool calls"), 1) === "none");
  const afterProse = card.querySelector(".turn-text")?.nextSibling;
  assert("a caret past the last spoken word of the card names nothing", afterProse !== null && afterProse !== undefined && mark(afterProse, 0) === "none");
  assert("a caret in another card names that card's utterance", mark(textNodeWith(doc.getElementById("t4") ?? card, "Thanks"), 2) === "3:0");
  doc.body.append("stray body text");
  assert("a caret in text outside every card names nothing", mark(textNodeWith(doc.body, "stray body"), 3) === "none");
  assert("a caret in an element, not text, names nothing", mark(card, 0) === "none");

  const painter = createPainter(doc);
  painter.paint(at(first, turn, whole(first), wordOf(first, 3)));
  const inSpan = doc.querySelector(`.${CURSOR_CLASS}`)?.firstChild;
  assert("while the card is wrapped, a caret in a word span's text still names the word", inSpan !== null && inSpan !== undefined && mark(inSpan, 1) === `0:${charOf(first, "fix")}`);
  painter.paint(null);
}

console.log("caretSource");
{
  // jsdom places no caret from a point; each spelling is stubbed onto a fresh document,
  // so what is asserted is which spelling the source reads and what it hands back.
  const fresh = (): Document => new JSDOM("<!DOCTYPE html><body><p>text</p></body>").window.document;
  const bare = fresh();
  let refused = false;
  try {
    caretSource(bare);
  } catch {
    refused = true;
  }
  assert("a document with neither spelling is refused when the source is parsed, before any tap", refused);
  const node = bare.querySelector("p")?.firstChild ?? null;
  const describe = (c: Caret | null): string => (c === null ? "null" : `${c.node === node ? "p-text" : "other"}@${c.offset}`);

  const standard = Object.assign(fresh(), {
    caretPositionFromPoint: (x: number, _y: number) => (x < 0 ? null : { offsetNode: node, offset: 2 }),
  });
  const viaPosition = caretSource(standard);
  assert("the standard spelling yields the node and offset, and null where the browser places none", describe(viaPosition(10, 10)) === "p-text@2" && describe(viaPosition(-1, 0)) === "null");

  const webkit = Object.assign(fresh(), {
    caretRangeFromPoint: (x: number, _y: number) => (x < 0 ? null : { startContainer: node, startOffset: 3 }),
  });
  const viaRange = caretSource(webkit);
  assert("WebKit's spelling yields the same shape", describe(viaRange(10, 10)) === "p-text@3" && describe(viaRange(-1, 0)) === "null");
}

console.log(process.exitCode === 1 ? "read-along-check: FAILED" : "read-along-check: ok");
