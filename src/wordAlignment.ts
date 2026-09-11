// [LAW:decomposition] Word alignment: from the model's own attention, when each word of a
// unit was said. One sentence, no "and": this module turns a per-frame attention row over
// the unit's text tokens into a start and end time for every word the manifest knows. It
// runs no model (pocketTtsRuntime hands it one logits row and one PCM frame at a time), it
// cuts no text (the words are the manifest's own `wordSpans` over the unit's source) and it
// paints nothing. Every function here is pure over plain numbers, which is what lets the check
// replay streams captured from the reference implementation with no model at all
// [LAW:effects-at-boundaries] [LAW:verifiable-goals].
//
// WHAT IS PORTED, AND FROM WHERE. dpm63/pocket-tts-timestamped (MIT) found that one head
// of the FlowLM transformer — layer 3 head 8 for the english checkpoints — attends, at
// each generated frame, to the text tokens of the word being said. No trained weights are
// involved: the read-out is the softmax of that head's query for the new frame over the
// cached keys at the text positions, summed per text unit by the token-to-unit map, and a
// small state machine turns the per-frame scores plus a voiced/silent bit into word
// boundaries at frame edges. Its measured accuracy (49 ms mean error against
// CrisperWhisper on english_2026-04, zero skips) belongs to THAT algorithm exactly, so
// everything below mirrors pocket_tts_timestamped/timestamps/{text,alignment}.py line for
// line — the units it builds, the fractional token map, the silence threshold, the
// "next word dominates" rule — and the check asserts equality with its captured output.
// Deviating anywhere would mean re-measuring against a speech recogniser we do not run.
//
// WHY TWO NOTIONS OF WORD. The reference segments text into LEXICAL words (runs of
// letters and digits, joined across a hyphen or apostrophe) and separate punctuation
// units, because the attention moves to a comma or a period during the pause after a
// word, and that move is what closes the word on time. The manifest's word is the thing
// the cursor paints: a whitespace-delimited run, punctuation attached ("world.", "(ok)").
// So the state machine runs over lexical units, faithfully, and its result is projected
// onto the manifest's words at the end: a manifest word spans from its first lexical
// word's start to its last one's end. Every lexical word lies inside exactly one
// manifest word, because a lexical word has a letter or digit and no whitespace
// [LAW:one-source-of-truth].
//
// WHY THE PLAN IS BUILT OVER THE FED TEXT. The model sees `unit.text` (prepared:
// straightened quotes, capitalised, terminal punctuation appended); its tokens and their
// positions are facts about that string, so units and the token map are computed in its
// coordinates. The speech script's character-map theorem — the fed text is the utterance
// slice character for character, plus at most one appended character — is what makes a
// lexical word at [a, b) of the fed text the same word at [a, b) of the source, and what
// makes the appended punctuation `synthetic` in the reference's sense: punctuation the
// model was given that the source never had.
//
// A WORD THE MODEL SKIPPED. The reference emits no timestamp for a word its state
// machine never opened (the tiny model does skip words, rarely). The manifest wants one
// timing per word, so a skipped word is reported as an empty interval at the boundary
// where it should have been: start = end = the previous word's end. A said word is never
// shorter than one frame, so an empty interval IS the skip, readable from the data, and
// the cursor — which paints the last word STARTED by a time — never lands on it
// [LAW:no-silent-failure].

import { wordSpans, type WordTiming } from "./speechManifest";
import type { UnitText } from "./speechScript";

// [LAW:parse-dont-validate] The element at `i` of a sequence whose length was established
// by construction (a word index into the plan's own word list, a token row of the map).
// A miss is a broken plan, not a case to skip.
const at = <T>(xs: ArrayLike<T>, i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`wordAlignment: index ${i} out of ${xs.length}`);
  return x;
};

// ── text units ──────────────────────────────────────────────────────────────────────

export interface Span {
  readonly begin: number;
  readonly end: number;
}

// A unit of the fed text as the reference sees it: a lexical word, numbered in text order,
// or a run of punctuation, `synthetic` when the model was given it and the source had none.
export type TextUnit =
  | (Span & { readonly kind: "word"; readonly word: number })
  | (Span & { readonly kind: "punctuation"; readonly synthetic: boolean });

const WORD_CHAR = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;
const PUNCTUATION = /\p{P}/u;
// A hyphen or apostrophe joins two word characters into one lexical word ("well-known",
// "didn't"); the reference's set, verbatim.
const CONTINUATIONS = new Set(["-", "‐", "‑", "'", "’"]);

// The text as code points with each one's UTF-16 offset: the reference indexes Python
// strings by code point, and every span this module hands out is in UTF-16 units, the
// coordinates of `wordSpans` and of every cursor.
interface CodePoint {
  readonly char: string;
  readonly at: number;
}

const codePoints = (text: string): ReadonlyArray<CodePoint> => {
  const points: CodePoint[] = [];
  let at = 0;
  for (const char of text) {
    points.push({ char, at });
    at += char.length;
  }
  return points;
};

// Port of `_lexical_word_spans`: a run of word characters (combining marks stay with
// their base), extended across a continuation character that is followed by another word
// character.
export const lexicalWords = (text: string): ReadonlyArray<Span> => {
  const points = codePoints(text);
  // Past the end is the empty string, which is no kind of character, and the text's
  // length, which is where the last span ends [LAW:dataflow-not-control-flow].
  const charAt = (i: number): string => points[i]?.char ?? "";
  const offsetOf = (i: number): number => points[i]?.at ?? text.length;
  const isWord = (i: number): boolean => WORD_CHAR.test(charAt(i));
  const spans: Span[] = [];
  let i = 0;
  while (i < points.length) {
    if (!isWord(i)) {
      i++;
      continue;
    }
    const begin = offsetOf(i);
    for (;;) {
      while (isWord(i) || MARK.test(charAt(i))) i++;
      if (CONTINUATIONS.has(charAt(i)) && isWord(i + 1)) {
        i++;
        continue;
      }
      break;
    }
    spans.push({ begin, end: offsetOf(i) });
  }
  return spans;
};

// Port of `_build_units` for the case where the fed text IS the source (no re-chunking
// between them): lexical words, then every maximal run of punctuation outside them, in
// text order. `sourceLength` is how much of `text` the source had; a punctuation run
// after the last word is synthetic when the source's own text after that word — which
// is the fed text's up to `sourceLength`, character for character — holds no punctuation.
export const textUnits = (text: string, sourceLength: number): ReadonlyArray<TextUnit> => {
  const words = lexicalWords(text);
  const covered = new Uint8Array(text.length);
  for (const word of words) covered.fill(1, word.begin, word.end);
  const lastWord = words.at(-1);
  const trailing = lastWord === undefined ? "" : text.slice(lastWord.end, sourceLength);
  const synthetic = (span: Span): boolean =>
    lastWord !== undefined && span.begin >= lastWord.end && !PUNCTUATION.test(trailing);
  const punctuation: Span[] = [];
  for (const point of codePoints(text)) {
    const open = punctuation.at(-1);
    if (covered[point.at] === 1 || !PUNCTUATION.test(point.char)) continue;
    if (open !== undefined && open.end === point.at) {
      punctuation[punctuation.length - 1] = { begin: open.begin, end: point.at + point.char.length };
    } else {
      punctuation.push({ begin: point.at, end: point.at + point.char.length });
    }
  }
  const units: TextUnit[] = [
    ...words.map((span, word): TextUnit => ({ kind: "word", ...span, word })),
    ...punctuation.map((span): TextUnit => ({ kind: "punctuation", ...span, synthetic: synthetic(span) })),
  ];
  return units.sort((a, b) => a.begin - b.begin || a.end - b.end);
};

// ── token spans ─────────────────────────────────────────────────────────────────────

// The SentencePiece pieces of the fed text, in token order, as the tokenizer's model file
// spells them: "▁" for a word boundary, "<0xNN>" for one byte of a character the
// vocabulary lacks.
const BOUNDARY = "▁";
const BYTE_PIECE = /^<0x[0-9A-Fa-f]{2}>$/;

const utf8Length = (char: string): number => new TextEncoder().encode(char).length;

// [LAW:parse-dont-validate] Where each token came from in the fed text, recovered by
// walking the pieces over the tokenizer's normalised form of it — whitespace runs
// collapsed to one boundary, a boundary prepended — and mapping every normalised
// character back to the source character it came from. The byte pieces of one character
// all get that character's span, as in the reference. A piece that does not match the
// text at its position is a tokenizer whose pieces do not spell its input, and is thrown,
// never skipped [LAW:no-silent-failure].
export const tokenSpans = (text: string, pieces: ReadonlyArray<string>): ReadonlyArray<Span> => {
  // The normalised text as (character, source span) pairs; the dummy prefix has an empty
  // span, and a collapsed whitespace run stands for its first character.
  const normalised: Array<{ readonly char: string; readonly span: Span }> = [{ char: BOUNDARY, span: { begin: 0, end: 0 } }];
  let pendingSpace: Span | undefined;
  for (const point of codePoints(text.trim())) {
    const at = point.at + (text.length - text.trimStart().length);
    if (/\s/u.test(point.char)) {
      pendingSpace ??= { begin: at, end: at + point.char.length };
      continue;
    }
    if (pendingSpace !== undefined) normalised.push({ char: BOUNDARY, span: pendingSpace });
    pendingSpace = undefined;
    normalised.push({ char: point.char, span: { begin: at, end: at + point.char.length } });
  }
  const spans: Span[] = [];
  let pos = 0;
  let bytesLeft = 0;
  for (const [index, piece] of pieces.entries()) {
    const mismatch = (): Error => new Error(`token ${index} (${JSON.stringify(piece)}) does not spell the text at ${pos} of ${JSON.stringify(text)}`);
    if (BYTE_PIECE.test(piece)) {
      const point = normalised[pos];
      if (point === undefined) throw mismatch();
      if (bytesLeft === 0) bytesLeft = utf8Length(point.char);
      spans.push(point.span);
      if (--bytesLeft === 0) pos++;
      continue;
    }
    if (bytesLeft !== 0) throw mismatch();
    const chars = Array.from(piece);
    const covered = normalised.slice(pos, pos + chars.length);
    if (covered.length !== chars.length || covered.some((point, i) => point.char !== chars[i])) throw mismatch();
    const real = covered.filter((point) => point.span.end > point.span.begin);
    const first = real[0];
    const last = real.at(-1);
    spans.push(first === undefined || last === undefined ? { begin: 0, end: 0 } : { begin: first.span.begin, end: last.span.end });
    pos += chars.length;
  }
  if (pos !== normalised.length || bytesLeft !== 0) throw new Error(`${pieces.length} tokens spell ${pos} of ${normalised.length} normalised characters of ${JSON.stringify(text)}`);
  return spans;
};

// Port of `_token_to_unit_mapping`: row t is token t's share of each unit — its overlap
// with the unit over its overlap with all units — or all zeros for a token in no unit.
export const tokenToUnit = (tokens: ReadonlyArray<Span>, units: ReadonlyArray<Span>): ReadonlyArray<Float64Array> =>
  tokens.map((token) => {
    const overlaps = Float64Array.from(units, (unit) => Math.max(0, Math.min(token.end, unit.end) - Math.max(token.begin, unit.begin)));
    const total = overlaps.reduce((sum, x) => sum + x, 0);
    return total > 0 ? overlaps.map((x) => x / Math.max(total, 1)) : overlaps;
  });

// ── the plan ────────────────────────────────────────────────────────────────────────

// Everything the per-frame arithmetic needs, derived once per unit: the text units, the
// token map, and which manifest word each lexical word belongs to.
export interface AlignmentPlan {
  readonly units: ReadonlyArray<TextUnit>;
  readonly tokenToUnit: ReadonlyArray<Float64Array>;
  // Lexical word index → index into `wordsOf(unit)`.
  readonly wordOf: ReadonlyArray<number>;
  readonly wordCount: number;
}

// [LAW:parse-dont-validate] A lexical word that lies in no manifest word contradicts the
// theorem in the header — thrown, so the manifest never receives a count it cannot stamp.
export const planAlignment = (unit: UnitText, pieces: ReadonlyArray<string>): AlignmentPlan => {
  const units = textUnits(unit.text, unit.source.length);
  const words = wordSpans(unit.source, 0);
  const wordOf = units
    .filter((u): u is Extract<TextUnit, { kind: "word" }> => u.kind === "word")
    .map((lexical) => {
      const at = words.findIndex((word) => word.charStart <= lexical.begin && lexical.end <= word.charEnd);
      if (at === -1) throw new Error(`lexical word at ${lexical.begin}..${lexical.end} of ${JSON.stringify(unit.text)} lies in no manifest word`);
      return at;
    });
  return { units, tokenToUnit: tokenToUnit(tokenSpans(unit.text, pieces), units), wordOf, wordCount: words.length };
};

// ── per-frame arithmetic ────────────────────────────────────────────────────────────

// Port of `SelectedAttentionCapture`: the head's attention over the text tokens, summed
// into unit scores. `logits` is q_h · K_text / sqrt(d) for the new frame, one per token.
export const unitScores = (plan: AlignmentPlan, logits: ArrayLike<number>): Float64Array => {
  if (logits.length !== plan.tokenToUnit.length) {
    throw new Error(`${logits.length} attention logits for ${plan.tokenToUnit.length} text tokens`);
  }
  const row = Float64Array.from(logits);
  const max = row.reduce((m, x) => Math.max(m, x), -Infinity);
  const weights = row.map((x) => Math.exp(x - max));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const scores = new Float64Array(plan.units.length);
  for (const [t, shares] of plan.tokenToUnit.entries()) {
    const attention = at(weights, t) / total;
    for (const [u, share] of shares.entries()) scores[u] = at(scores, u) + attention * share;
  }
  return scores;
};

// Port of `is_voiced`: a frame whose RMS exceeds the silence threshold.
const SILENCE_RMS = 1e-3;

export const isVoiced = (pcm: Float32Array): boolean => {
  const energy = pcm.reduce((sum, x) => sum + x * x, 0);
  return pcm.length > 0 && energy > SILENCE_RMS * SILENCE_RMS * pcm.length;
};

// ── the state machine ───────────────────────────────────────────────────────────────

// What the machine emits, in lexical-word terms, exactly as the reference does; the
// check compares these to its captured events.
export type AlignmentEvent =
  | { readonly kind: "start"; readonly word: number; readonly at: number }
  | { readonly kind: "end"; readonly word: number; readonly start: number; readonly at: number };

export interface WordAligner {
  // The events of one frame: `scores` is `unitScores` for it, `voiced` is `isVoiced` of
  // its PCM, `frameStart` is where it begins in the unit's audio.
  readonly frame: (scores: Float64Array, voiced: boolean, frameStart: number) => ReadonlyArray<AlignmentEvent>;
  // Closes the open word at the end of the audio and returns every word's timing in
  // manifest-word order — the report the manifest admits.
  readonly finish: (audioEnd: number) => ReadonlyArray<WordTiming>;
}

// Below this score, a word the model is no longer attending to may be closed by ANY
// later word dominating it, not only the next one; the reference's constant.
const NON_NEXT_ATTENTION_THRESHOLD = 0.001;

// Port of `WordAlignment`. Words open in order and only one is open at a time; a voiced
// frame opens the next word when the open word's attention has been overtaken, and a
// silent frame closes the open word when attention has moved past it (or, for the last
// word with nothing real left to say, at once).
export const createWordAligner = (plan: AlignmentPlan): WordAligner => {
  const wordUnits = plan.units.flatMap((unit, index) => (unit.kind === "word" ? [index] : []));
  const ends = new Map<number, { readonly start: number; readonly end: number }>();
  let next = 0;
  let open: { readonly position: number; readonly start: number } | null = null;

  const openNext = (at: number): AlignmentEvent => {
    open = { position: next, start: at };
    next++;
    return { kind: "start", word: open.position, at };
  };
  const close = (opened: { readonly position: number; readonly start: number }, at: number): AlignmentEvent => {
    ends.set(opened.position, { start: opened.start, end: at });
    open = null;
    return { kind: "end", word: opened.position, start: opened.start, at };
  };
  const futureWordDominates = (scores: Float64Array, currentUnit: number): boolean => {
    const current = at(scores, currentUnit);
    if (at(scores, at(wordUnits, next)) > current) return true;
    if (current >= NON_NEXT_ATTENTION_THRESHOLD) return false;
    return wordUnits.slice(next + 1).some((unit) => at(scores, unit) > current);
  };

  const frame: WordAligner["frame"] = (scores, voiced, frameStart) => {
    if (scores.length !== plan.units.length) throw new Error(`${scores.length} unit scores for ${plan.units.length} units`);
    if (!voiced) {
      if (open === null) return [];
      const currentUnit = at(wordUnits, open.position);
      const future = scores.subarray(currentUnit + 1);
      const shouldClose = future.length > 0 && Math.max(...future) > at(scores, currentUnit);
      const isFinalWord = open.position === wordUnits.length - 1;
      const hasLaterPunctuation = plan.units.slice(currentUnit + 1).some((unit) => unit.kind === "punctuation" && !unit.synthetic);
      return shouldClose || (isFinalWord && !hasLaterPunctuation) ? [close(open, frameStart)] : [];
    }
    if (open === null) return next >= wordUnits.length ? [] : [openNext(frameStart)];
    if (next >= wordUnits.length) return [];
    return futureWordDominates(scores, at(wordUnits, open.position)) ? [close(open, frameStart), openNext(frameStart)] : [];
  };

  const finish: WordAligner["finish"] = (audioEnd) => {
    if (open !== null) close(open, audioEnd);
    next = wordUnits.length;
    const timings: WordTiming[] = [];
    for (let word = 0; word < plan.wordCount; word++) {
      const floor = timings.at(-1)?.endMs ?? 0;
      const own = [...ends.entries()].filter(([lexical]) => plan.wordOf[lexical] === word).map(([, timing]) => timing);
      const first = own[0];
      const last = own.at(-1);
      timings.push(first === undefined || last === undefined ? { startMs: floor, endMs: floor } : { startMs: first.start, endMs: last.end });
    }
    return timings;
  };

  return { frame, finish };
};
