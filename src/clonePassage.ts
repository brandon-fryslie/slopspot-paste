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
export const CLONE_PASSAGE = "She found the huge beige garage, took one good look, then proudly walked home singing that Joyce's church visit was worth every mile.";

// The pace the passage is budgeted against. Conversation runs nearer 190 wpm, but a reader
// reading a sentence off a screen into a microphone slows down, and the passage has to fit
// inside the recording rather than nearly fit: the capture stops at CLONE_SECONDS whether the
// reader has finished or not, and a truncated tail is precisely the sounds at the end going
// missing — the failure this module exists to prevent. 150 leaves the margin that buys.
export const READING_WORDS_PER_MINUTE = 150;

// [LAW:parse-dont-validate] The passage as bare comparable words: lowercased, and stripped of
// the punctuation that sits *around* a word but never of what sits inside one, so `garage,` is
// `garage` while `Joyce's` stays `Joyce's` — the apostrophe is part of the word a reader says.
export const passageWords = (text: string): ReadonlyArray<string> =>
  text
    .split(/\s+/)
    .map((word) =>
      word
        .toLowerCase()
        .replace(/^[^a-z']+/, "")
        .replace(/[^a-z']+$/, ""),
    )
    .filter((word) => word !== "");

// [LAW:types-are-the-program] A sound and the word that carries it. Both are required, so a
// half-written row is not representable and there is no "covered, example pending" state.
export interface Sound {
  // The phoneme, in IPA.
  readonly phoneme: string;
  // The word of CLONE_PASSAGE that carries it, spelled as the passage spells it.
  readonly word: string;
}

// The 24 consonants of General American English. Several share a word on purpose: `huge` is
// the passage's only /j/, and carrying /h/, /j/, /u/ and /dʒ/ in one syllable is why it is
// there at all.
export const CONSONANT_SOUNDS: ReadonlyArray<Sound> = [
  { phoneme: "p", word: "proudly" },
  { phoneme: "b", word: "beige" },
  { phoneme: "t", word: "took" },
  { phoneme: "d", word: "good" },
  { phoneme: "k", word: "look" },
  { phoneme: "g", word: "garage" },
  { phoneme: "f", word: "found" },
  { phoneme: "v", word: "visit" },
  { phoneme: "θ", word: "worth" },
  { phoneme: "ð", word: "the" },
  { phoneme: "s", word: "singing" },
  { phoneme: "z", word: "Joyce's" },
  { phoneme: "ʃ", word: "she" },
  { phoneme: "ʒ", word: "beige" },
  { phoneme: "h", word: "home" },
  { phoneme: "tʃ", word: "church" },
  { phoneme: "dʒ", word: "huge" },
  { phoneme: "m", word: "mile" },
  { phoneme: "n", word: "one" },
  { phoneme: "ŋ", word: "singing" },
  { phoneme: "l", word: "look" },
  { phoneme: "r", word: "proudly" },
  { phoneme: "w", word: "walked" },
  { phoneme: "j", word: "huge" },
];

// The 16 vowels, the half improvised speech misses most: an unscripted ten seconds routinely
// holds no /ʊ/, no /ɔɪ/ and no /aʊ/ at all.
export const VOWEL_SOUNDS: ReadonlyArray<Sound> = [
  { phoneme: "i", word: "she" },
  { phoneme: "ɪ", word: "visit" },
  { phoneme: "eɪ", word: "beige" },
  { phoneme: "ɛ", word: "then" },
  { phoneme: "æ", word: "that" },
  { phoneme: "ɑ", word: "garage" },
  { phoneme: "ɔ", word: "walked" },
  { phoneme: "oʊ", word: "home" },
  { phoneme: "ʊ", word: "took" },
  { phoneme: "u", word: "huge" },
  { phoneme: "ʌ", word: "one" },
  { phoneme: "ɜr", word: "worth" },
  { phoneme: "aɪ", word: "mile" },
  { phoneme: "aʊ", word: "found" },
  { phoneme: "ɔɪ", word: "Joyce's" },
  { phoneme: "ə", word: "garage" },
];

export const CLONE_PASSAGE_SOUNDS: ReadonlyArray<Sound> = [...CONSONANT_SOUNDS, ...VOWEL_SOUNDS];
