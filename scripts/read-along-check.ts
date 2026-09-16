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
import { enhanceClampBlocks } from "../src/clampBlocks";
import type { ViewableDialogue } from "../src/dialogue";
import type { Place } from "../src/performer";
import {
  alignWords,
  caretSource,
  createPainter,
  CURSOR_CLASS,
  pageWords,
  placeOfCaret,
  RANGE_CLASS,
  TURN_CLASS,
  WORD_CLASS,
  type Caret,
  type Painted,
  type ReadAlongAt,
  turnOf,
  wordKey,
} from "../src/readAlong";
import { renderDialogueHtml } from "../src/renderDialogue";
import { deriveUtterances, type Utterance } from "../src/speech";
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
// speech announces, a detail fold and the usage aside — three things never read aloud —
// and the turn summary, which the narrator reads as it stands.
const CARD = `
  <article class="bubble bubble-assistant" id="t3" data-index="3">
    <div class="turn-text"><p>Here is the <strong>fix</strong>, in <code>parser.ts</code>:</p>
    <pre><code>const x = 1;\nreturn x;</code></pre>
    <p>Then it works. Ship it.</p></div>
    <details class="condensed"><summary>2 tool calls</summary><div>Bash ls -la</div></details>
    <aside class="bubble-turn-summary"><span>Then it summarized.</span></aside>
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
    "prose, inline code and the turn summary are words; fenced code, folds and the usage aside are not",
    // The comma and colon sit in their own text nodes beside the inline elements, so they
    // are punctuation runs, not words — exactly the manifest's rule.
    words.join(" ") === "Here is the fix in parser.ts Then it works. Ship it. Then it summarized.",
  );
}

// ── the painter ───────────────────────────────────────────────────────────────────────

// The utterances speech.ts derives from that card: two quoted paragraphs around one
// announcement, then the turn summary in the narrator's voice, all on anchor t3; and the
// next card's one line.
const say = (index: number, voice: Utterance["voice"], text: string): Utterance => ({ index, anchor: `t${index}`, origin: "page", voice, text });
const announce = (index: number, text: string): Utterance => ({ index, anchor: `t${index}`, origin: "announcement", voice: "narrator", text });
const first = say(3, "assistant", "Here is the fix, in parser.ts:");
const announced = announce(3, "Code block, 2 lines.");
const second = say(3, "assistant", "Then it works. Ship it.");
const summary = say(3, "narrator", "Then it summarized.");
const turn = [first, announced, second, summary];
const thanks = say(4, "user", "Thanks!");
const page = [first, announced, second, summary, thanks];

const texts = (cls: string): string => Array.from(doc.querySelectorAll(`.${cls}`), (el) => el.textContent ?? "").join(" ");
const lit = (): string => texts(CURSOR_CLASS);
const inRange = (): string => texts(RANGE_CLASS);
const wrapped = (): number => doc.querySelectorAll(`.${WORD_CLASS}`).length;
const speaking = (): string => Array.from(doc.querySelectorAll(`.${TURN_CLASS}`), (el) => el.id).join();
const wordOf = (u: Utterance, n: number): WordSpan => {
  const span = wordSpans(u.text, 0)[n];
  if (span === undefined) throw new Error(`fixture: no word ${n} in "${u.text}"`);
  return span;
};
const whole = (u: Utterance): WordSpan => ({ charStart: 0, charEnd: u.text.length });
const at = (utterance: Utterance, turnOf: ReadonlyArray<Utterance>, range: WordSpan, word: WordSpan | null): ReadAlongAt => ({ utterance, turn: turnOf, range, word });
const painted = (p: Painted | null): string => (p === null ? "null" : `${p.anchor} ${p.el.tagName.toLowerCase()} ${p.el.textContent?.trim().split(/\s+/)[0] ?? ""}`);

console.log("createPainter");
{
  const original = card.innerHTML;
  const text = card.textContent;
  const painter = createPainter(doc);

  const onFix = painter.paint(at(first, turn, whole(first), wordOf(first, 3)));
  assert("the word tier lights exactly that word in the card, however it is punctuated", lit() === "fix");
  assert("the segment tier covers every matched word of the segment", inRange() === "Here is the fix in parser.ts");
  assert("the card carries the turn class", speaking() === "t3");
  assert("what was painted names the card and the lit word", painted(onFix) === "t3 span fix");
  assert("the card still reads the same", card.textContent === text);
  assert("every matched word of the card is wrapped once", wrapped() === 14);

  const onCode = painter.paint(at(first, turn, whole(first), wordOf(first, 5)));
  assert("moving the cursor moves the light: the code span's word", lit() === "parser.ts" && painted(onCode) === "t3 span parser.ts");

  const onAnnouncement = painter.paint(at(announced, turn, whole(announced), null));
  assert("an announcement has no words on the page: nothing lit, nothing thrown", lit() === "" && inRange() === "");
  assert("with no word to stand on, what was painted is the card itself", painted(onAnnouncement) === "t3 article Here");

  const onSentence = painter.paint(at(second, turn, whole(second), null));
  assert("a segment with no word lights no word and covers the whole sentence group", lit() === "" && inRange() === "Then it works. Ship it.");
  assert("what was painted is then the segment's first word", painted(onSentence) === "t3 span Then");

  const ship = { charStart: second.text.indexOf("Ship"), charEnd: second.text.length };
  const onShip = painter.paint(at(second, turn, ship, wordOf(second, 3)));
  assert("a segment narrower than the utterance covers only its words", inRange() === "Ship it." && lit() === "Ship" && painted(onShip) === "t3 span Ship");

  const summarized = wordOf(summary, 2);
  const onSummary = painter.paint(at(summary, turn, whole(summary), summarized));
  assert(
    "the turn summary, the page's own words in the narrator's voice, lights its word in the summary aside",
    lit() === "summarized." && inRange() === "Then it summarized." && painted(onSummary)?.startsWith("t3 span") === true && doc.querySelector(`.bubble-turn-summary .${CURSOR_CLASS}`) !== null,
  );

  const onThanks = painter.paint(at(thanks, [thanks], whole(thanks), wordOf(thanks, 0)));
  assert("entering another card unwraps the last: its markup is exactly as rendered", card.innerHTML === original);
  assert("and the new card is lit and carries the turn class alone", lit() === "Thanks!" && speaking() === "t4" && painted(onThanks) === "t4 span Thanks!");

  const cleared = painter.paint(null);
  assert("paint(null) clears: nothing painted, no span or turn class remains anywhere", cleared === null && wrapped() === 0 && lit() === "" && speaking() === "" && doc.getElementById("t4")?.innerHTML === "<p>Thanks!</p>");

  const elsewhere = say(9, "user", "Not on this page.");
  const offPage = painter.paint(at(elsewhere, [elsewhere], whole(elsewhere), wordOf(elsewhere, 0)));
  assert("an utterance whose card is not in the document paints nothing, returns nothing to follow, does not throw", offPage === null && wrapped() === 0);
  painter.paint(null);

  // An announcement whose wording shares a word with the prose: it is not in the spoken
  // pool, so the prose word stays with the prose utterance that says it.
  const decoy = announce(3, "Then a code block.");
  const decoyed = [first, decoy, second];
  painter.paint(at(decoy, decoyed, whole(decoy), wordOf(decoy, 0)));
  assert("an announcement sharing a word with the prose paints nothing", lit() === "" && inRange() === "");
  painter.paint(at(second, decoyed, whole(second), null));
  assert("and the prose utterance keeps its every word", inRange() === "Then it works. Ship it.");
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
const placeOf = (m: Place | null): string => (m === null ? "none" : `${m.utterance}:${m.char}`);
const charOf = (u: Utterance, snippet: string): number => u.text.indexOf(snippet);

console.log("placeOfCaret");
{
  const mark = (node: Node, offset: number): string => placeOf(placeOfCaret(page, caret(node, offset)));
  const opening = textNodeWith(card, "Here is the");
  assert("a caret inside a word names that word", mark(opening, 6) === `0:${charOf(first, "is")}`);
  assert("a caret on the space after a word names the next word, across an element boundary", mark(opening, opening.data.length) === `0:${charOf(first, "fix")}`);
  assert("a caret on punctuation between words names the word after it", mark(textNodeWith(card, ", in"), 0) === `0:${charOf(first, "in ")}`);
  assert("a caret in an inline code span names its word", mark(textNodeWith(card, "parser.ts"), 3) === `0:${charOf(first, "parser.ts")}`);
  assert("a caret in the second paragraph names a word of the second utterance", mark(textNodeWith(card, "Ship it"), 15) === `2:${charOf(second, "Ship")}`);
  assert("a caret in a fenced code block names nothing: the block is announced, not read", mark(textNodeWith(card, "const x"), 2) === "none");
  assert("a caret in a fold's summary names nothing", mark(textNodeWith(card, "2 tool calls"), 1) === "none");
  assert("a caret in the turn summary names its word: the narrator reads it as the page shows it", mark(textNodeWith(card, "it summarized"), 8) === `3:${charOf(summary, "summarized")}`);
  const afterSpoken = card.querySelector(".bubble-usage")?.nextSibling;
  assert("a caret past the last spoken word of the card names nothing", afterSpoken !== null && afterSpoken !== undefined && mark(afterSpoken, 0) === "none");
  assert("a caret in another card names that card's utterance", mark(textNodeWith(doc.getElementById("t4") ?? card, "Thanks"), 2) === "4:0");
  doc.body.append("stray body text");
  assert("a caret in text outside every card names nothing", mark(textNodeWith(doc.body, "stray body"), 3) === "none");
  assert("a caret in an element, not text, names nothing", mark(card, 0) === "none");

  const painter = createPainter(doc);
  painter.paint(at(first, turn, whole(first), wordOf(first, 3)));
  const inSpan = doc.querySelector(`.${CURSOR_CLASS}`)?.firstChild;
  assert("while the card is wrapped, a caret in a word span's text still names the word", inSpan !== null && inSpan !== undefined && mark(inSpan, 1) === `0:${charOf(first, "fix")}`);
  painter.paint(null);
}

// ── the page's hidden prose: a folded turn and a clamped message ─────────────────────

// Rendered by the page's own renderer, clamped by the page's own enhancer, spoken by the
// page's own speech: what is proved is what a reader of a real page would meet.
console.log("folds and clamps");
{
  const view: ViewableDialogue = [
    {
      index: 0,
      node: { kind: "spoken", role: "user", content: "Why does the parser stall?\n\nIt reads every line twice.\n\nThe second pass never ends." },
      collapsed: false,
    },
    {
      index: 1,
      node: {
        kind: "assistant",
        blocks: [
          { kind: "text", content: "The loop never *advances* its cursor.\n\n```ts\nwhile (i < n) {}\n```\n\nMove the increment inside." },
          { kind: "turn-summary", text: "Fixed the `loop` in one edit." },
        ],
      },
      collapsed: true,
    },
  ];
  const foldDom = new JSDOM(`<!DOCTYPE html><body><section class="conversation">${renderDialogueHtml(view)}</section></body>`);
  const foldDoc = foldDom.window.document;
  const conversation = foldDoc.querySelector<HTMLElement>(".conversation");
  if (conversation === null) throw new Error("fixture: no conversation");
  // jsdom lays nothing out, so the clamp's one measured fact — the prose overflows its
  // height — is stated for the message's prose; the enhancer then clamps it for real.
  Object.assign(globalThis, { window: foldDom.window, document: foldDoc });
  for (const content of conversation.querySelectorAll(".clamp-content")) Object.defineProperty(content, "scrollHeight", { value: 1000 });
  enhanceClampBlocks(conversation);

  const clamp = foldDoc.querySelector("#t0 .clampable");
  const fold = foldDoc.querySelector<HTMLDetailsElement>("details#t1");
  const toggle = foldDoc.querySelector("#t0 .clamp-toggle");
  if (clamp === null || fold === null || toggle === null) throw new Error("fixture: no clamped message, fold or toggle");
  assert("the fixture starts hidden: the message is clamped and the turn is folded", clamp.classList.contains("is-collapsed") && !fold.open);

  const utterances = deriveUtterances(view);
  assert("the folded turn is spoken as its prose, never as its label", turnOf(utterances, "t1").some((u) => u.text.includes("Move the increment")) && !utterances.some((u) => u.text.startsWith("Folded")));

  const foldWords = (root: Element): string => pageWords(root).map((w) => w.node.data.slice(w.start, w.end)).join(" ");
  assert(
    "a fold's summary label and a clamp's toggle are not words of the page; the fold's body and the clamped prose are",
    foldWords(fold) === "Assistant The loop never advances its cursor. Move the increment inside. Fixed the `loop` in one edit." &&
      foldWords(clamp) === "Why does the parser stall? It reads every line twice. The second pass never ends.",
  );

  const foldPainter = createPainter(foldDoc);
  const hidden = (el: Element): boolean => el.closest("details:not([open])") !== null || el.closest(".clampable.is-collapsed") !== null;
  const unpaintable: string[] = [];
  const unshown: string[] = [];
  for (const utterance of utterances) {
    const turn = turnOf(utterances, utterance.anchor);
    const words = wordSpans(utterance.text, 0);
    // An announcement is ours — standing in for a code block — and is deliberately not on
    // the page; it paints the card, which must be shown all the same.
    const cursors: ReadonlyArray<WordSpan | null> = utterance.origin === "announcement" ? [null] : words;
    for (const word of cursors) {
      const painted = foldPainter.paint(at(utterance, turn, whole(utterance), word));
      const lit = Array.from(foldDoc.querySelectorAll(`.${CURSOR_CLASS}`), (el) => wordKey(el.textContent ?? "")).join(" ");
      const said = word === null ? "" : wordKey(utterance.text.slice(word.charStart, word.charEnd));
      if (lit !== said) unpaintable.push(`${utterance.anchor} "${said}" lit "${lit}"`);
      if (painted === null || hidden(painted.el)) unshown.push(`${utterance.anchor} "${said}"`);
    }
  }
  assert(
    "the turn summary is spoken as the page's own words in the narrator's voice",
    utterances.some((u) => u.origin === "page" && u.voice === "narrator" && u.text === "Fixed the `loop` in one edit."),
  );
  assert(`every spoken word of the clamped message, the folded turn and its summary lights its own word on the page${unpaintable.length === 0 ? "" : `: ${unpaintable.join("; ")}`}`, unpaintable.length === 0);
  assert(`and what is painted is never inside a closed fold or a collapsed clamp${unshown.length === 0 ? "" : `: ${unshown.join("; ")}`}`, unshown.length === 0);
  assert("the clamp the voice read through is open, pinned, and its toggle says so", !clamp.classList.contains("is-collapsed") && clamp.classList.contains("clamp-pinned") && toggle.textContent === "Show less" && toggle.getAttribute("aria-expanded") === "true");
  assert("the fold the voice read through is open", fold.open);

  foldPainter.paint(null);
  assert("both stay open once the voice has left: nothing above the reader moves", fold.open && !clamp.classList.contains("is-collapsed"));

  // The reader closes what the voice is in: the next word is painted, and the choice stands
  // until the voice enters the card again.
  const [message, reply] = [turnOf(utterances, "t0"), turnOf(utterances, "t1")];
  const said = (u: Utterance | undefined, n: number): ReadAlongAt => {
    if (u === undefined) throw new Error("fixture: no utterance");
    return at(u, turnOf(utterances, u.anchor), whole(u), wordOf(u, n));
  };
  foldPainter.paint(said(message[0], 0));
  if (!(toggle instanceof foldDom.window.HTMLButtonElement)) throw new Error("fixture: the toggle is not a button");
  toggle.click();
  foldPainter.paint(said(message[0], 1));
  assert("a clamp the reader collapses while the voice reads it stays collapsed at the next word", clamp.classList.contains("is-collapsed") && toggle.textContent === "Show more");
  foldPainter.paint(said(reply[0], 0));
  fold.open = false;
  foldPainter.paint(said(reply[0], 1));
  assert("a fold the reader closes while the voice reads it stays closed at the next word", !fold.open);
  foldPainter.paint(said(message[0], 2));
  foldPainter.paint(said(reply[0], 2));
  assert("entering the card again opens both again", fold.open && !clamp.classList.contains("is-collapsed"));
  foldPainter.paint(null);

  const inFold = (snippet: string): Text => {
    const walker = foldDoc.createTreeWalker(fold, 4);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if ((node as Text).data.includes(snippet)) return node as Text;
    throw new Error(`fixture: no text node in the fold holding "${snippet}"`);
  };
  const increment = utterances.findIndex((u) => u.text.includes("Move the increment"));
  const incrementUtterance = utterances[increment];
  if (incrementUtterance === undefined) throw new Error("fixture: no increment utterance");
  assert(
    "a tap in an opened fold names the place it shows",
    placeOf(placeOfCaret(utterances, caret(inFold("Move the increment"), "Move the incr".length))) === `${increment}:${incrementUtterance.text.indexOf("increment")}`,
  );
  assert("a tap on the fold's summary label names nothing", placeOf(placeOfCaret(utterances, caret(inFold(fold.dataset["topic"] ?? "\u0000"), 1))) === "none");
}

console.log("spoken notation (slopspot-read-along-a35.5jv)");
{
  // The voice says "9 times 10 equals 90"; the page keeps "9 x 10 = 90". The "=" is a word
  // because it is said: the cursor lights it, and a tap on it names it.
  const mathDoc = new JSDOM(`<!DOCTYPE html><body><article class="bubble bubble-assistant" id="t0"><p>So 9 x 10 = 90, and a + b is 3 -> done.</p></article></body>`).window.document;
  const mathCard = mathDoc.getElementById("t0");
  if (mathCard === null) throw new Error("fixture: no notation card");
  const said = say(0, "assistant", "So 9 x 10 = 90, and a + b is 3 -> done.");
  const words = pageWords(mathCard).map((w) => w.node.data.slice(w.start, w.end));
  assert("a said symbol is a page word; a symbol read as written would not be", words.join(" ") === "So 9 x 10 = 90, and a + b is 3 done.");
  assert("a symbol matches only itself", alignWords(["=", "+"], ["+", "="]).map(String).join() === "1,undefined");
  assert("a symbol is itself whatever punctuation it wears; a symbol word is not punctuation", wordKey("∞,") === "∞" && wordKey("(=)") === "=" && wordKey("/") === "/");
  const painter = createPainter(mathDoc);
  const equals = wordSpans(said.text, 0).findIndex((w) => said.text.slice(w.charStart, w.charEnd) === "=");
  painter.paint(at(said, [said], whole(said), wordOf(said, equals)));
  assert("the cursor on the said \"equals\" lights the page's \"=\"", Array.from(mathDoc.querySelectorAll(`.${CURSOR_CLASS}`), (el) => el.textContent).join() === "=");
  const lit = Array.from(mathDoc.querySelectorAll(`.${CURSOR_CLASS}`), (el) => el.firstChild);
  const litNode = lit[0];
  assert(
    "while the card is painted and \"=\" sits in a span of its own, a tap on it still names it",
    litNode !== null && litNode !== undefined && placeOf(placeOfCaret([said], caret(litNode, 0))) === `0:${said.text.indexOf("=")}`,
  );
  painter.paint(null);
  const node = textNodeWith(mathCard, "= 90");
  assert("a tap on the page's \"=\" names it", placeOf(placeOfCaret([said], caret(node, node.data.indexOf("=")))) === `0:${said.text.indexOf("=")}`);
  const marked = new JSDOM(`<!DOCTYPE html><body><article id="t1"><p>Keep <code>n</code> <= 10, so 2</p><pre><code>code</code></pre><p> + 3.</p></article></body>`).window.document.getElementById("t1");
  assert(
    "notation beside inline markup is a word; unspoken text between two nodes is no operand",
    marked !== null && pageWords(marked).map((w) => w.node.data.slice(w.start, w.end)).join(" ") === "Keep n <= 10, so 2 3.",
  );
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
