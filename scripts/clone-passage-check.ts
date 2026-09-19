// The passage a reader reads aloud to clone their voice (slopspot-voices-9p4): that every sound
// it claims is really in the text, that the inventory is whole, that it fits inside the
// recording, and that it is made of characters a reader will not trip over. Run:
// `tsx scripts/clone-passage-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what a reader reading the passage aloud
// puts into the microphone — never how clonePassage.ts lays its table out. Rewrite the passage
// however you like: this check tells you which sound you just dropped.

import { CLONE_SECONDS } from "../src/clonedVoice";
import { CLONE_PASSAGE, CLONE_PASSAGE_SOUNDS, CONSONANT_SOUNDS, READING_WORDS_PER_MINUTE, VOWEL_SOUNDS, passageWords } from "../src/clonePassage";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const words = passageWords(CLONE_PASSAGE);
const spoken = new Set(words);

console.log("the words the passage is read as");
{
  assert("punctuation around a word is not part of it: a trailing comma is not read", passageWords("garage,").join() === "garage");
  assert("an apostrophe between letters is part of the word: a possessive is one word, not two", passageWords("Joyce's").join() === "joyce's");
  // The same character does both jobs in English, and only its position tells them apart: a
  // word quoted with straight apostrophes must still match its row in the sounds table.
  assert("an apostrophe at a word's edge is punctuation: a quoted word comes back bare", passageWords("'wow'").join() === "wow");
  assert("both jobs at once, in one line", passageWords("'Joyce's' walked").join() === "joyce's,walked");
  assert("the quoted, the bracketed and the dashed come back bare", passageWords("(home) —mile— church!").join() === "home,mile,church");
  assert("case is not a difference: the passage's first word matches its table row", passageWords("She").join() === "she");
  assert("whitespace of any width separates words, and no empty word survives", passageWords("  took \n  one\tgood  ").join() === "took,one,good");
}

console.log("every sound the passage claims is really in the passage");
{
  const missing = CLONE_PASSAGE_SOUNDS.filter(({ word }) => !spoken.has(word.toLowerCase()));
  const named = missing.map(({ phoneme, word }) => `/${phoneme}/ wants ${word}`).join("; ");
  assert(`all ${CLONE_PASSAGE_SOUNDS.length} sounds name a word the reader actually says${missing.length === 0 ? "" : ` — ${named}`}`, missing.length === 0);
}

console.log("the inventory is whole and says each sound once");
{
  assert(`24 consonants, one row each (found ${CONSONANT_SOUNDS.length})`, CONSONANT_SOUNDS.length === 24);
  assert(`16 vowels, one row each (found ${VOWEL_SOUNDS.length})`, VOWEL_SOUNDS.length === 16);
  const phonemes = CLONE_PASSAGE_SOUNDS.map(({ phoneme }) => phoneme);
  const twice = phonemes.filter((p, i) => phonemes.indexOf(p) !== i);
  assert(`no sound is listed twice${twice.length === 0 ? "" : ` — ${[...new Set(twice)].map((p) => `/${p}/`).join(", ")}`}`, twice.length === 0);
  assert("every row names a sound and a word, neither blank", CLONE_PASSAGE_SOUNDS.every(({ phoneme, word }) => phoneme.trim() !== "" && word.trim() !== ""));
}

console.log("the passage fits inside the recording");
{
  // The capture stops at CLONE_SECONDS whether the reader has finished or not, so a passage
  // that overruns loses its own tail — the sounds at the end, silently.
  const seconds = (words.length / READING_WORDS_PER_MINUTE) * 60;
  assert(`${words.length} words read at ${READING_WORDS_PER_MINUTE} wpm is ${seconds.toFixed(1)} s, inside the ${CLONE_SECONDS} s recording`, seconds <= CLONE_SECONDS);
  // A passage that fits with seconds to spare is one that could be carrying more sounds in more
  // contexts; this floor says it is not wastefully short.
  assert(`and long enough to be worth the recording (${seconds.toFixed(1)} s of ${CLONE_SECONDS} s)`, seconds >= CLONE_SECONDS * 0.7);
}

console.log("the passage is plain enough to read cold");
{
  assert("letters, spaces and ordinary punctuation only — no typographic quote or dash to pause at", /^[A-Za-z ,.']+$/.test(CLONE_PASSAGE));
  assert("one line: the reader is handed a sentence, not a document", !CLONE_PASSAGE.includes("\n") && CLONE_PASSAGE.trim() === CLONE_PASSAGE);
  assert("it ends in a full stop, so it is read with a statement's falling prosody", CLONE_PASSAGE.endsWith("."));
}
