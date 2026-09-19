// The passage a reader reads aloud to clone their voice (slopspot-voices-9p4): that every sound
// it claims is really in the text, that the inventory is whole, that it fits inside the
// recording, and that it is made of characters a reader will not trip over. Run:
// `tsx scripts/clone-passage-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what a reader reading the passage aloud
// puts into the microphone — never how clonePassage.ts lays its table out. Rewrite the passage
// however you like: this check tells you which sound you just dropped.

import { CLONE_SECONDS } from "../src/clonedVoice";
import { CLONE_PASSAGE, CLONE_PASSAGE_SOUNDS, CONSONANT_SOUNDS, LEAD_IN_SECONDS, READING_WORDS_PER_MINUTE, VOWEL_SOUNDS, passageWords } from "../src/clonePassage";

// [LAW:one-source-of-truth] The sounds of General American English, which is a fact about the
// language and not about this passage — so it is declared here, against which the module's table
// is held, rather than read back out of the table it is meant to check. Counting rows cannot
// catch a mistyped symbol: `ʐ` for `ʒ` keeps the count at 24 and the duplicate check green while
// the sound the passage was built to carry is asserted nowhere.
const CONSONANTS = "p b t d k g f v θ ð s z ʃ ʒ h tʃ dʒ m n ŋ l r w j".split(" ");
const VOWELS = "i ɪ eɪ ɛ æ ɑ ɔ oʊ ʊ u ʌ ɜr aɪ aʊ ɔɪ ə".split(" ");

const sameSet = (got: ReadonlyArray<string>, want: ReadonlyArray<string>): boolean => got.length === want.length && [...want].sort().join() === [...got].sort().join();

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
  // Both sides go through the one parser, so a row written `mile.` or `Garage,` matches exactly
  // as `mile` and `garage` do — the table cannot disagree with the passage over punctuation.
  const bare = ({ word }: { readonly word: string }): string => passageWords(word).join(" ");
  const missing = CLONE_PASSAGE_SOUNDS.filter((sound) => !spoken.has(bare(sound)));
  const named = missing.map(({ phoneme, word }) => `/${phoneme}/ wants ${word}`).join("; ");
  assert(`all ${CLONE_PASSAGE_SOUNDS.length} sounds name a word the reader actually says${missing.length === 0 ? "" : ` — ${named}`}`, missing.length === 0);
  assert("every row names exactly one word, so a row can never half-match the passage", CLONE_PASSAGE_SOUNDS.every((sound) => passageWords(sound.word).length === 1));
}

console.log("the inventory is whole and says each sound once");
{
  const consonants = CONSONANT_SOUNDS.map(({ phoneme }) => phoneme);
  const vowels = VOWEL_SOUNDS.map(({ phoneme }) => phoneme);
  assert(`the 24 consonants of the language, each one carried (found ${consonants.length}${sameSet(consonants, CONSONANTS) ? "" : `, off by ${CONSONANTS.filter((p) => !consonants.includes(p)).map((p) => `/${p}/`).join(" ") || "none missing"}`})`, sameSet(consonants, CONSONANTS));
  assert(`the 16 vowels, each one carried (found ${vowels.length}${sameSet(vowels, VOWELS) ? "" : `, off by ${VOWELS.filter((p) => !vowels.includes(p)).map((p) => `/${p}/`).join(" ") || "none missing"}`})`, sameSet(vowels, VOWELS));
  const phonemes = CLONE_PASSAGE_SOUNDS.map(({ phoneme }) => phoneme);
  const twice = phonemes.filter((p, i) => phonemes.indexOf(p) !== i);
  assert(`no sound is listed twice${twice.length === 0 ? "" : ` — ${[...new Set(twice)].map((p) => `/${p}/`).join(", ")}`}`, twice.length === 0);
  assert("every row names a sound and a word, neither blank", CLONE_PASSAGE_SOUNDS.every(({ phoneme, word }) => phoneme.trim() !== "" && word.trim() !== ""));
}

console.log("the passage fits inside the recording");
{
  // The recording's clock starts when the microphone opens, not at the reader's first word, and
  // the capture keeps the FIRST ten seconds — so the lead-in is spent out of the same budget and
  // anything still unread when the cap fires is cut off with no sign to the reader. Budget both.
  const reading = (words.length / READING_WORDS_PER_MINUTE) * 60;
  const spoken = reading + LEAD_IN_SECONDS;
  assert(`${words.length} words at ${READING_WORDS_PER_MINUTE} wpm is ${reading.toFixed(1)} s, and ${spoken.toFixed(1)} s with the ${LEAD_IN_SECONDS} s lead-in — inside the ${CLONE_SECONDS} s recording`, spoken <= CLONE_SECONDS);
  // A passage that fits with seconds to spare is one that could be carrying more sounds in more
  // contexts; this floor says it is not wastefully short.
  assert(`and long enough to be worth the recording (${spoken.toFixed(1)} s of ${CLONE_SECONDS} s used)`, spoken >= CLONE_SECONDS * 0.7);
}

console.log("the passage is plain enough to read cold");
{
  assert("letters, spaces and ordinary punctuation only — no typographic quote or dash to pause at", /^[A-Za-z ,.']+$/.test(CLONE_PASSAGE));
  assert("one line: the reader is handed a sentence, not a document", !CLONE_PASSAGE.includes("\n") && CLONE_PASSAGE.trim() === CLONE_PASSAGE);
  assert("it ends in a full stop, so it is read with a statement's falling prosody", CLONE_PASSAGE.endsWith("."));
}
