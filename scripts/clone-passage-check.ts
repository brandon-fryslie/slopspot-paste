// The passage a reader reads aloud to clone their voice (slopspot-voices-9p4): that every sound
// it claims is really in the text, that the inventory is whole, that it fits inside the
// recording, and that it is made of characters a reader will not trip over. Run:
// `tsx scripts/clone-passage-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what a reader reading the passage aloud
// puts into the microphone — never how clonePassage.ts lays its table out. Rewrite the passage
// however you like: this check tells you which sound you just dropped.

import { CLONE_SECONDS } from "../src/clonedVoice";
import { LEAD_IN_SECONDS } from "../src/voiceCapture";
import { CLONE_PASSAGE, CLONE_PASSAGE_SOUNDS, CONSONANT_SOUNDS, SLOWEST_READING_WORDS_PER_MINUTE, VOWEL_SOUNDS, passageWords } from "../src/clonePassage";

// [LAW:one-source-of-truth] The sounds of General American English, which is a fact about the
// language and not about this passage — so it is declared here, against which the module's table
// is held, rather than read back out of the table it is meant to check. Counting rows cannot
// catch a mistyped symbol: `ʐ` for `ʒ` keeps the count at 24 and the duplicate check green while
// the sound the passage was built to carry is asserted nowhere.
const CONSONANTS = "p b t d k g f v θ ð s z ʃ ʒ h tʃ dʒ m n ŋ l r w j".split(" ");
const VOWELS = "i ɪ eɪ ɛ æ ɑ ɔ oʊ ʊ u ʌ ɜr aɪ aʊ ɔɪ ə".split(" ");

// [LAW:one-source-of-truth] The function words of English, which is a fact about the language
// rather than about this passage. Said at speed these reduce — `from` is [frəm], `that` as a
// complementizer is [ðət], `it` is [ət] — and the vowel they were carrying simply is not in the
// recording. A vowel row naming one of them claims a sound the microphone never heard, and every
// other assertion here stays green, because the WORD is in the passage.
const REDUCIBLE = "a an and are as at be been but by can could did do does for from had has have he her his how i if in is it its me my of on or our she should so than that the their them then there they this to was we were what when will with would you your".split(" ");

const sameSet = (got: ReadonlyArray<string>, want: ReadonlyArray<string>): boolean => got.length === want.length && [...want].sort().join() === [...got].sort().join();

// [LAW:no-silent-failure] Why a discrepancy names BOTH sides: a row for a sound the language does
// not have is as wrong as a missing one, and reporting only what is missing can print a reason
// that contradicts itself — a duplicated or extra row fails `sameSet` on length while nothing at
// all is missing, which used to read `off by none missing` and named nothing to go and fix.
const offBy = (got: ReadonlyArray<string>, want: ReadonlyArray<string>): string =>
  [
    ...want.filter((p) => !got.includes(p)).map((p) => `/${p}/ missing`),
    ...got.filter((p) => !want.includes(p)).map((p) => `/${p}/ is not one of them`),
  ].join(", ") || "one of them listed twice";

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
  assert(`the 24 consonants of the language, each one carried (found ${consonants.length}${sameSet(consonants, CONSONANTS) ? "" : `, off by ${offBy(consonants, CONSONANTS)}`})`, sameSet(consonants, CONSONANTS));
  assert(`the 16 vowels, each one carried (found ${vowels.length}${sameSet(vowels, VOWELS) ? "" : `, off by ${offBy(vowels, VOWELS)}`})`, sameSet(vowels, VOWELS));
  const phonemes = CLONE_PASSAGE_SOUNDS.map(({ phoneme }) => phoneme);
  const twice = phonemes.filter((p, i) => phonemes.indexOf(p) !== i);
  assert(`no sound is listed twice${twice.length === 0 ? "" : ` — ${[...new Set(twice)].map((p) => `/${p}/`).join(", ")}`}`, twice.length === 0);
  assert("every row names a sound and a word, neither blank", CLONE_PASSAGE_SOUNDS.every(({ phoneme, word }) => phoneme.trim() !== "" && word.trim() !== ""));
}

console.log("every vowel rides a word the reader stresses");
{
  // Consonants are exempt on purpose: reduction takes the vowel out of a function word and
  // leaves the consonants standing, so `from` still puts an /f/ in the microphone and `that`
  // still puts a /ð/ there. It is only the vowel rows that go silent [LAW:no-silent-failure].
  const reduced = VOWEL_SOUNDS.filter(({ word }) => REDUCIBLE.includes(passageWords(word).join(" ")));
  const named = reduced.map(({ phoneme, word }) => `/${phoneme}/ rests on ${word}`).join("; ");
  assert(`no vowel is carried only by a word English says without stressing${reduced.length === 0 ? "" : ` — ${named}`}`, reduced.length === 0);
}

console.log("the passage fits inside the recording");
{
  // The whole of the clone's length is the reader's to read in, because the recording's clock
  // starts at their first word: voiceCapture.ts records past the cap and `clonePrompt` takes
  // CLONE_SAMPLES from where the voice begins, so the seconds spent moving eyes to the passage and
  // drawing breath are no longer spent out of this budget. It was not always so — the window used
  // to be the clone's length MINUS a lead-in allowance, and slopspot-voices-4f5 is what removed
  // the subtraction [LAW:no-ambient-temporal-coupling].
  const readingWindow = CLONE_SECONDS;
  const reading = (words.length / SLOWEST_READING_WORDS_PER_MINUTE) * 60;
  // [LAW:verifiable-goals] The rate below which the tail is really lost — one derived number, and
  // the only one a human can argue with, so the check states it either way instead of reporting
  // pass/fail against an assumed pace. Both bounds below read off this same reading time
  // [LAW:one-source-of-truth]: one quantity, two edges, no second constant to drift.
  const cutOffBelow = (words.length / readingWindow) * 60;
  assert(`${words.length} words at ${SLOWEST_READING_WORDS_PER_MINUTE} wpm is ${reading.toFixed(1)} s of the ${readingWindow.toFixed(1)} s the reader gets from their first word — so the tail is lost only below ${cutOffBelow.toFixed(0)} wpm`, reading <= readingWindow);
  // [LAW:verifiable-goals] That window is the clone's WHOLE length only while the reader begins
  // inside the allowance voiceCapture.ts looks through; past it `speechStart` clamps, and every
  // further second they take comes off the reading. So the honest figure is not the allowance alone
  // but the allowance plus whatever the passage leaves spare — the moment the tail starts to go.
  // Stated here because the bound above is the one a reader would otherwise believe unconditionally.
  const grace = LEAD_IN_SECONDS + (readingWindow - reading);
  assert(`and they have ${grace.toFixed(1)} s from the tap before any of it is at risk: the ${LEAD_IN_SECONDS} s the capture looks through, plus the ${(readingWindow - reading).toFixed(1)} s the passage leaves spare`, grace > LEAD_IN_SECONDS);
  // A passage that leaves most of the window empty is one that could be carrying more sounds in
  // more contexts; this floor says it is not wastefully short.
  assert(`and long enough to be worth the recording (${((reading / readingWindow) * 100).toFixed(0)}% of that window used)`, reading >= readingWindow * 0.7);
}

console.log("the passage is plain enough to read cold");
{
  assert("letters, spaces and ordinary punctuation only — no typographic quote or dash to pause at", /^[A-Za-z ,.']+$/.test(CLONE_PASSAGE));
  assert("one line: the reader is handed a sentence, not a document", !CLONE_PASSAGE.includes("\n") && CLONE_PASSAGE.trim() === CLONE_PASSAGE);
  assert("it ends in a full stop, so it is read with a statement's falling prosody", CLONE_PASSAGE.endsWith("."));
}
