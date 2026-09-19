// [LAW:decomposition] The words a reader reads aloud to make a clone of their own voice. One
// sentence, no "and": this module is that passage and the record of which sound each of its
// words carries — the text and its specification, not two jobs. It records nothing
// (voiceCapture.ts is the microphone), makes no voice (clonedVoice.ts) and draws nothing
// (voicePicker.ts shows it).
//
// WHY A PASSAGE AT ALL. A clone is ten seconds of speech and the encoder can only reproduce
// sounds it actually heard, so what the reader happens to say decides what the voice can ever
// say. Left to improvise, a reader says "uh, testing, one two three" — and that sample holds
// no /ʒ/, no /ɔɪ/, no /aʊ/, no /ŋ/, so the clone is thin in every sound those words missed and
// there is nothing downstream that can put them back. Handing the reader a passage is the
// difference between cloning a voice and cloning whichever corner of it got practised.
//
// [LAW:one-source-of-truth] CLONE_PASSAGE is the text. CONSONANT_SOUNDS and VOWEL_SOUNDS are
// what it claims to cover — one row per phoneme, each naming the word of the passage that puts
// that sound in the reader's mouth. The claim cannot drift from the text, because
// scripts/clone-passage-check.ts fails unless every named word is really in the passage: so
// rewriting the passage and dropping a sound is a failed check that names the sound, never a
// quietly worse clone [LAW:verifiable-goals].
//
// WHAT STAYS JUDGEMENT. That `beige` carries /ʒ/ is read off the word by someone who knows how
// it is said, and no check here re-derives it — the project ships a text tokenizer, not a
// pronunciation dictionary, so there is nothing to re-derive it from. The check verifies the
// half that is mechanical (the word is in the passage, the inventory is whole, it fits the
// recording) and leaves the pairing where a reviewer can see it, rather than dressing a guess
// up as a proof.

// Read aloud at an unhurried pace, this is what the reader records. It is ordinary English a
// person can read cold, because a tongue-twister is read in a tongue-twister's voice and the
// prosody is part of what gets cloned.
export const CLONE_PASSAGE = "She walked home from Joyce's huge beige garage, chanting proudly that it looked worth every mile.";

// The slowest reader the passage must survive — a bound, not an average, and the difference is
// the whole point. A fluent adult reads prose aloud nearer 150 wpm, but the typical rate is not
// the number that matters here, because the two ways of being wrong cost wildly different
// amounts [LAW:no-silent-failure]: budget generously and a slower reader is cut off mid-sentence,
// which is silent and takes whichever sounds live in the tail out of the clone for good; budget
// tightly and a quicker reader leaves a second of room tone on the end, which costs nothing. So
// the passage is held to the slow edge, and the check reports the rate below which the tail is
// actually lost rather than a pass against an assumed pace.
export const SLOWEST_READING_WORDS_PER_MINUTE = 120;

// [LAW:no-ambient-temporal-coupling] The recording's clock does NOT start at the reader's first
// word. voiceCapture.ts arms the cap when the microphone opens and keeps the FIRST
// CLONE_SAMPLES, so the seconds a reader spends moving their eyes to the passage and drawing
// breath are spent out of the same ten — and whatever is still unread when the cap fires is cut
// off silently. The tail is the worst thing to lose: the sounds that appear once appear
// wherever they appear, and a truncated read drops them with no sign to the reader.
//
// So the budget the passage is held to is reading time PLUS this allowance, not reading time
// alone. It is stated here, and enforced in scripts/clone-passage-check.ts, rather than left as
// the margin that happens to be lying around after the reading time is counted.
export const LEAD_IN_SECONDS = 1.5;

// [LAW:parse-dont-validate] The passage as bare comparable words: lowercased, and stripped of
// everything that is not a letter at either end of a word — so `garage,` is `garage`, `(home)`
// is `home`, and `'wow'` is `wow`.
//
// An apostrophe survives only where it sits *between* letters, which is the only place it is
// part of a word a reader says: `Joyce's` stays whole, while the same character used as a
// quotation mark is stripped like any other punctuation. That falls out of anchoring at the
// ends rather than naming the apostrophe as a special case — an edge class of `[^a-z]` cannot
// reach inside a word, so there is no rule here to get wrong twice.
export const passageWords = (text: string): ReadonlyArray<string> =>
  text
    .split(/\s+/)
    .map((word) =>
      word
        .toLowerCase()
        .replace(/^[^a-z]+/, "")
        .replace(/[^a-z]+$/, ""),
    )
    .filter((word) => word !== "");

// [LAW:types-are-the-program] A sound and the word that carries it. Both are required, so a
// half-written row is not representable and there is no "covered, example pending" state.
export interface Sound {
  // The phoneme, in IPA.
  readonly phoneme: string;
  // The word of CLONE_PASSAGE that carries it, as a bare word — the passage's own spelling
  // minus whatever punctuation happens to sit against it there, since `garage` ends a clause in
  // the text and `garage,` is not a word anybody says. The check reads both sides through
  // `passageWords`, so writing it either way matches [LAW:single-enforcer].
  readonly word: string;
}

// The 24 consonants of General American English. Several share a word on purpose: `huge` is
// the passage's only /j/, and one short syllable of it answers for /j/, /dʒ/ and /u/ — which is
// why it is there at all.
export const CONSONANT_SOUNDS: ReadonlyArray<Sound> = [
  { phoneme: "p", word: "proudly" },
  { phoneme: "b", word: "beige" },
  { phoneme: "t", word: "walked" },
  { phoneme: "d", word: "proudly" },
  { phoneme: "k", word: "looked" },
  { phoneme: "g", word: "garage" },
  { phoneme: "f", word: "from" },
  { phoneme: "v", word: "every" },
  { phoneme: "θ", word: "worth" },
  { phoneme: "ð", word: "that" },
  { phoneme: "s", word: "Joyce's" },
  { phoneme: "z", word: "Joyce's" },
  { phoneme: "ʃ", word: "she" },
  { phoneme: "ʒ", word: "beige" },
  { phoneme: "h", word: "home" },
  { phoneme: "tʃ", word: "chanting" },
  { phoneme: "dʒ", word: "huge" },
  { phoneme: "m", word: "mile" },
  { phoneme: "n", word: "chanting" },
  { phoneme: "ŋ", word: "chanting" },
  { phoneme: "l", word: "proudly" },
  { phoneme: "r", word: "proudly" },
  { phoneme: "w", word: "walked" },
  { phoneme: "j", word: "huge" },
];

// The 16 vowels, the half improvised speech misses most: an unscripted ten seconds routinely
// holds no /ʊ/, no /ɔɪ/ and no /aʊ/ at all.
export const VOWEL_SOUNDS: ReadonlyArray<Sound> = [
  { phoneme: "i", word: "she" },
  { phoneme: "ɪ", word: "it" },
  { phoneme: "eɪ", word: "beige" },
  { phoneme: "ɛ", word: "every" },
  { phoneme: "æ", word: "that" },
  { phoneme: "ɑ", word: "garage" },
  { phoneme: "ɔ", word: "walked" },
  { phoneme: "oʊ", word: "home" },
  { phoneme: "ʊ", word: "looked" },
  { phoneme: "u", word: "huge" },
  { phoneme: "ʌ", word: "from" },
  { phoneme: "ɜr", word: "worth" },
  { phoneme: "aɪ", word: "mile" },
  { phoneme: "aʊ", word: "proudly" },
  { phoneme: "ɔɪ", word: "Joyce's" },
  { phoneme: "ə", word: "garage" },
];

export const CLONE_PASSAGE_SOUNDS: ReadonlyArray<Sound> = [...CONSONANT_SOUNDS, ...VOWEL_SOUNDS];
