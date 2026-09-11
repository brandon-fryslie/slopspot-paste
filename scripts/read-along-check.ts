// The read-along painter, driven under jsdom (slopspot-read-along-q35.9).
// Run: `tsx scripts/read-along-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is what a reader could see: which words
// in the card are lit for a given cursor, that the card reads the same before, during
// and after painting, and that leaving a card puts its DOM back as the renderer left it.
// Nothing here asserts how the match is implemented beyond its contract: monotone,
// punctuation-blind, honest about what it cannot place.

import { JSDOM } from "jsdom";
import { alignWords, createPainter, CURSOR_CLASS, pageWords, WORD_CLASS } from "../src/readAlong";
import type { Utterance } from "../src/speech";
import { wordSpans } from "../src/speechManifest";

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
    "prose and inline code are words; fenced code, folds and the usage aside are not",
    // The comma and colon sit in their own text nodes beside the inline elements, so they
    // are punctuation runs, not words — exactly the manifest's rule.
    words.join(" ") === "Here is the fix in parser.ts Then it works. Ship it.",
  );
}

// ── the painter ───────────────────────────────────────────────────────────────────────

// The utterances speech.ts derives from that card: two quoted paragraphs around one
// announcement, all on anchor t3.
const say = (index: number, voice: Utterance["voice"], text: string): Utterance => ({ index, anchor: `t${index}`, voice, text });
const first = say(3, "assistant", "Here is the fix, in parser.ts:");
const announced = say(3, "narrator", "Code block, 2 lines.");
const second = say(3, "assistant", "Then it works. Ship it.");
const turn = [first, announced, second];
const thanks = say(4, "user", "Thanks!");

const lit = (): string[] => Array.from(doc.querySelectorAll(`.${CURSOR_CLASS}`), (el) => el.textContent ?? "");
const wrapped = (): number => doc.querySelectorAll(`.${WORD_CLASS}`).length;
const wordOf = (u: Utterance, n: number): { charStart: number; charEnd: number } => {
  const span = wordSpans(u.text, 0)[n];
  if (span === undefined) throw new Error(`fixture: no word ${n} in "${u.text}"`);
  return span;
};

console.log("createPainter");
{
  const original = card.innerHTML;
  const text = card.textContent;
  const painter = createPainter(doc);

  painter.paint({ utterance: first, turn, span: wordOf(first, 3) });
  assert("one word cursor lights exactly that word in the card, however it is punctuated", lit().join() === "fix");
  assert("the card still reads the same", card.textContent === text);
  assert("every matched word of the card is wrapped once", wrapped() === 11);

  painter.paint({ utterance: first, turn, span: wordOf(first, 5) });
  assert("moving the cursor moves the light: the code span's word", lit().join() === "parser.ts");

  painter.paint({ utterance: announced, turn, span: { charStart: 0, charEnd: announced.text.length } });
  assert("an announcement has no words on the page: nothing lit, nothing thrown", lit().length === 0);

  painter.paint({ utterance: second, turn, span: { charStart: 0, charEnd: second.text.length } });
  assert("a unit-precision span lights the whole sentence group", lit().join(" ") === "Then it works. Ship it.");

  painter.paint({ utterance: thanks, turn: [thanks], span: wordOf(thanks, 0) });
  assert("entering another card unwraps the last: its markup is exactly as rendered", card.innerHTML === original);
  assert("and the new card is lit", lit().join() === "Thanks!");

  painter.clear();
  assert("clear: no span remains anywhere", wrapped() === 0 && lit().length === 0 && doc.getElementById("t4")?.innerHTML === "<p>Thanks!</p>");

  const elsewhere = say(9, "user", "Not on this page.");
  painter.paint({ utterance: elsewhere, turn: [elsewhere], span: wordOf(elsewhere, 0) });
  assert("an utterance whose card is not in the document paints nothing and does not throw", wrapped() === 0);
  painter.clear();

  // A narrator utterance whose wording shares a word with the prose: it is not in the
  // spoken pool, so the prose word stays with the prose utterance that says it.
  const decoy = say(3, "narrator", "Then a code block.");
  const decoyed = [first, decoy, second];
  painter.paint({ utterance: decoy, turn: decoyed, span: { charStart: 0, charEnd: decoy.text.length } });
  assert("a narrator utterance sharing a word with the prose paints nothing", lit().length === 0);
  painter.paint({ utterance: second, turn: decoyed, span: { charStart: 0, charEnd: second.text.length } });
  assert("and the prose utterance keeps its every word", lit().join(" ") === "Then it works. Ship it.");
  painter.clear();
  assert("unwrapped exactly as rendered", card.innerHTML === original);
}

console.log(process.exitCode === 1 ? "read-along-check: FAILED" : "read-along-check: ok");
