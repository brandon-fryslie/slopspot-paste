// [LAW:decomposition] The speech script: the utterances deriveUtterances() decided to say,
// cut into the units the model synthesizes one at a time. One sentence, no "and" — this
// module decides HOW the said text is handed to the model: where one generation ends and
// the next begins, and what the exact string fed to it is. It does not decide what is said
// (speech.ts), it does not tokenize (the SentencePiece tokenizer is an injected function —
// the real one lives in the synthesis worker, a fixture one in the check), and it produces
// no audio. Every rule here is a pure function of an utterance and a token count, which is
// what lets the check drive it with no mocks at all [LAW:effects-at-boundaries].
//
// WHY THIS IS THE ONE CHUNKER. Pocket TTS is trained on single sentences. Kyutai's own
// pocket_tts/models/text_chunking.py splits a long input at sentence-ending tokens, sub-
// splits an oversized sentence at , ; : and packs sentences greedily under a token budget;
// each chunk is generated from a fresh copy of the voice state, so no audio or attention
// state carries across a chunk boundary. The jax-js runtime the q35.1 spike chose feeds
// whatever text it is given as ONE chunk and has no chunker of its own. So the cut is
// ours to make, exactly once, here, and the units we schedule ARE the model's chunks
// [LAW:one-source-of-truth]. The rules below mirror upstream's by intent, with the
// divergences named where they occur.
//
// WHY UNITS ARE CONTIGUOUS SPANS OF THE UTTERANCE TEXT. Word timing (q35.v70) must map a
// word the model said back onto the utterance it came from, so a unit carries its char
// range [start, end) into Utterance.text, and the text fed to the model is derived from
// that slice together with a map back into it: `sourceSpans[i]` is the stretch of the
// slice fed character i was made from. Preparation collapses every whitespace run to one
// space as the reference does, so the map is a table, not an offset — and the same fold
// that writes each fed character writes its entry, so the two cannot disagree
// [LAW:types-are-the-program] [LAW:one-source-of-truth].
//
// Audio remains a derived, disposable projection: nothing here is persisted. The rendition
// hash names a rendition client-side and never server state, and a unit's hash names the
// audio the device keeps of it (keptAudio.ts) [LAW:one-way-deps].

import { contentHash } from "./contentHash";
import { MAX_UNIT_TOKENS, MODEL_ASSETS, VOICE_IDS, assetVersion, type ModelAssetManifest, type VoiceId } from "./modelAssets";
import type { Utterance, Voice } from "./speech";

// Bump when any rule in this file changes what text a unit is fed or where units are cut:
// an old resume position or per-device cache keyed on the previous rules is then simply
// unused, never misapplied [LAW:no-ambient-temporal-coupling].
export const PIPELINE_VERSION = "2";

// Bump when a change to generation makes the audio or the word times of the same fed text in
// the same voice come out differently: the runtime's sampling (pocketTtsRuntime.ts: seed,
// temperature, frame caps, the vendored model code) or the word read-out (wordAlignment.ts).
// A unit the device kept under the previous generation is then simply missed, never played
// as this one's [LAW:no-ambient-temporal-coupling].
export const GENERATION_VERSION = "1";

// [LAW:types-are-the-program] The tokenizer seam: how many text tokens the model would
// see for this exact string. The real answer needs the SentencePiece model, which lives
// in the worker; this module only ever asks the question.
export type TokenCount = (text: string) => number;

// A half-open range of UTF-16 offsets into a string; which string is the holder's to say.
export interface TextSpan {
  readonly begin: number;
  readonly end: number;
}

// The exact string the model is fed for a slice of text, and where each of its characters
// came from in that slice (see the header): one character of the slice, a whitespace run
// for a space, or an empty span for the period preparation appends. Plain data, so it
// crosses into the synthesis worker as it is.
export interface PreparedText {
  readonly text: string;
  readonly sourceSpans: ReadonlyArray<TextSpan>;
}

// One generation: the prepared text of `utterance.text` over [start, end). The utterance is
// held by reference: its index, anchor and voice are read from it, never copied where
// they could disagree [LAW:one-source-of-truth].
export interface SynthesisUnit extends PreparedText {
  readonly utterance: Utterance;
  readonly start: number;
  readonly end: number;
}

// What the worker reads of a unit: the prepared text and the utterance slice its map points
// into. The utterance itself stays on the page.
export interface UnitText extends PreparedText {
  readonly source: string;
}

export const unitText = ({ utterance, start, end, text, sourceSpans }: SynthesisUnit): UnitText => ({
  text,
  sourceSpans,
  source: utterance.text.slice(start, end),
});

// [LAW:parse-dont-validate] The stretch of source a non-empty run [begin, end) of the fed
// text was made from: its first character's source to its last one's. A run outside the
// fed text is a span of some other string, thrown [LAW:no-silent-failure].
export const sourceSpanOf = ({ sourceSpans }: PreparedText, fed: TextSpan): TextSpan => {
  const first = sourceSpans[fed.begin];
  const last = sourceSpans[fed.end - 1];
  if (first === undefined || last === undefined || fed.end <= fed.begin) {
    throw new RangeError(`fed span ${fed.begin}..${fed.end} is not a run of ${sourceSpans.length} fed characters`);
  }
  return { begin: first.begin, end: last.end };
};

// Which model voice speaks each role. A VALUE the reader picks (voiceChoice.ts derives it
// from the pick kept on the device); changing it re-derives every rendition rather than
// re-deploying an asset.
export type VoiceMap = Readonly<Record<Voice, VoiceId>>;

// ── text preparation ────────────────────────────────────────────────────────────────
//
// Mirrors upstream prepare_text_prompt + _ensure_terminal_punctuation under the options
// the released model runs with (no space padding, semicolons kept, terminal punctuation
// appended). Every step maps a list of fed characters, each carrying its source span, so an
// edit changes what a character says and never where it came from. Upstream's reason for
// the appended period, verbatim: "Without one, the last word is often mispronounced or
// repeated."

export const TERMINAL: ReadonlySet<string> = new Set(".!?…");
// A trailing comma, colon or dash is replaced by a period (upstream's rule); a hyphen is
// in the set because upstream's is, and it can only ever be the LAST character here.
const WEAK = new Set(",;:-–—");
// Closing quotes and brackets that may legitimately follow a sentence's final period.
// Curly forms are included because they occur in the raw utterance text, which is what
// the sentence cutter sees; preparation straightens them afterwards.
export const CLOSERS: ReadonlySet<string> = new Set("\"')]»”’");

// One UTF-16 unit of fed text and the stretch of the slice it was made from.
interface FedChar {
  readonly char: string;
  readonly source: TextSpan;
}

const isWhitespace = (c: string): boolean => /\s/.test(c);

// The q35.1 spike heard every voice mangle the curly apostrophe in "isn’t" while reading
// the straight one in "it's" correctly, so curly quotes are straightened.
const STRAIGHT: Readonly<Record<string, string>> = { "’": "'", "‘": "'", "“": '"', "”": '"' };

// The slice trimmed, every whitespace run one space, every other unit itself, straightened.
// Divergence, deliberate: upstream strips, flattens newlines and then replaces "  " with
// " " in a single pass, which leaves three spaces as two and a tab as a tab. Both
// leftovers reach the model as text it never saw in training — a boundary piece per
// space, a byte-fallback token for the tab — so here a run of any whitespace is one space,
// which agrees with upstream on every text its pass does collapse.
const collapsed = (slice: string): ReadonlyArray<FedChar> => {
  const lead = slice.length - slice.trimStart().length;
  return Array.from(slice.trim().matchAll(/\s+|\S/g), (match) => {
    const begin = lead + match.index;
    const run = match[0];
    return { char: isWhitespace(run) ? " " : (STRAIGHT[run] ?? run), source: { begin, end: begin + run.length } };
  });
};

// Upper-cases the first character only when its upper-case form is one UTF-16 unit too:
// ß → SS would be two fed characters made from one, which the map has no entry shape for.
const capitalised = (chars: ReadonlyArray<FedChar>): ReadonlyArray<FedChar> =>
  chars.map((c, i) => (i === 0 && c.char.toUpperCase().length === 1 ? { ...c, char: c.char.toUpperCase() } : c));

const charOf = (chars: ReadonlyArray<FedChar>, i: number): string => chars[i]?.char ?? "";

// The index just past the "core": the text minus any trailing closers and spaces.
const endOfCore = (chars: ReadonlyArray<FedChar>): number => {
  let i = chars.length;
  while (i > 0 && (CLOSERS.has(charOf(chars, i - 1)) || isWhitespace(charOf(chars, i - 1)))) i--;
  return i;
};

// A weak mark ending the core becomes the period in place and keeps its source; an
// appended period was made from nothing, so its span is empty, where the text ends.
const withTerminalPunctuation = (chars: ReadonlyArray<FedChar>): ReadonlyArray<FedChar> => {
  const core = endOfCore(chars);
  const last = charOf(chars, core - 1);
  if (TERMINAL.has(last)) return chars;
  if (WEAK.has(last)) return chars.map((c, i) => (i === core - 1 ? { ...c, char: "." } : c));
  const end = chars.at(-1)?.source.end ?? 0;
  return [...chars, { char: ".", source: { begin: end, end } }];
};

// The exact string the model is fed for a slice of utterance text, with its map back into
// the slice. Exported so the check can state the map's theorem against it directly.
export const prepareText = (slice: string): PreparedText => {
  const chars = withTerminalPunctuation(capitalised(collapsed(slice)));
  return { text: chars.map((c) => c.char).join(""), sourceSpans: chars.map((c) => c.source) };
};

// ── cutting ─────────────────────────────────────────────────────────────────────────

interface Span {
  readonly start: number;
  readonly end: number;
}

// [LAW:one-type-per-behavior] Every level of cutting is the same operation with a different
// rule for where a piece may end: may the text be cut at position i (so that one piece
// ends at i and the next begins there), given the piece began at `start`?
type CutRule = (text: string, start: number, i: number) => boolean;

// A run of one or more `marks`, optionally followed by closers, followed by whitespace.
// "Followed by whitespace" is what upstream's token-level rule amounts to in characters
// and it subsumes upstream's decimal-period exception ("3.5" is not cut) without a second
// rule [LAW:polishing-by-subtraction]. Divergence, deliberate: upstream cuts BEFORE a
// closing quote that follows a period, so the quote becomes a chunk of its own (its own
// docstring says so); here the closers stay with the sentence they close.
const afterRunOf =
  (marks: ReadonlySet<string>): CutRule =>
  (text, start, i) => {
    if (!isWhitespace(text.charAt(i))) return false;
    let j = i;
    while (j > start && CLOSERS.has(text.charAt(j - 1))) j--;
    let marked = 0;
    while (j > start && marks.has(text.charAt(j - 1))) {
      j--;
      marked++;
    }
    return marked > 0;
  };

const atSentenceEnd: CutRule = afterRunOf(TERMINAL);
const atWeakPunctuation: CutRule = afterRunOf(WEAK);
const atWhitespace: CutRule = (text, _start, i) => isWhitespace(text.charAt(i));
// Between code points: a low surrogate is the second half of one character, not a position.
const atCodePoint: CutRule = (text, _start, i) => !isLowSurrogate(text.charCodeAt(i));
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

// The order oversized text is cut in: upstream sub-splits an oversized sentence at , ; :
// and then merely WARNS when a piece still exceeds the budget ("generation may skip
// words"). A skipped word is a silent failure, so the recursion continues to whitespace
// and finally to single code points, where the budget always holds [LAW:no-silent-failure].
const REFINEMENTS: readonly CutRule[] = [atWeakPunctuation, atWhitespace, atCodePoint];

// The span with surrounding whitespace removed, as a list so an all-whitespace span is
// simply no span rather than a special case [LAW:dataflow-not-control-flow].
const trimmed = (text: string, start: number, end: number): readonly Span[] => {
  let s = start;
  let e = end;
  while (s < e && isWhitespace(text.charAt(s))) s++;
  while (e > s && isWhitespace(text.charAt(e - 1))) e--;
  return s < e ? [{ start: s, end: e }] : [];
};

const cut = (text: string, span: Span, rule: CutRule): readonly Span[] => {
  const pieces: Span[] = [];
  let from = span.start;
  for (let i = span.start + 1; i < span.end; i++) {
    if (rule(text, from, i)) {
      pieces.push(...trimmed(text, from, i));
      from = i;
    }
  }
  pieces.push(...trimmed(text, from, span.end));
  return pieces;
};

type Fits = (span: Span) => boolean;

// A span that fits is a piece; one that does not is cut by the next rule and each part is
// refined by the rules after it (a part has no cut points of the rule that produced it).
// The list of rules IS the recursion's bound: with none left the span is a single code
// point, which fits.
const refine = (text: string, span: Span, fits: Fits, rules: readonly CutRule[]): readonly Span[] => {
  const [rule, ...rest] = rules;
  return fits(span) || rule === undefined
    ? [span]
    : cut(text, span, rule).flatMap((piece) => refine(text, piece, fits, rest));
};

// One sentence occurrence and the text the model would be fed for it. Pieces of one
// oversized sentence share the same object, which is what lets "the same sentence again"
// be told apart from "another piece of this sentence" by identity alone
// [LAW:types-are-the-program].
interface Sentence {
  readonly span: Span;
  readonly said: string;
}

interface Piece {
  readonly span: Span;
  readonly of: Sentence;
}

// Greedy packing, as upstream: a piece joins the open unit when the joined text still
// fits. The joined span is contiguous, so the original whitespace between the pieces,
// collapsed, is what separates them in the fed text. One rule of ours on top: a sentence whose text was
// already said by a DIFFERENT sentence in the open unit starts a new one — the q35.1
// spike heard five identical "code block, 2 lines." sentences in one chunk come out as
// one to three, so identical sentences never share a generation.
const pack = (pieces: readonly Piece[], fits: Fits): readonly Span[] => {
  const [first, ...rest] = pieces;
  if (first === undefined) return [];
  const units: Span[] = [];
  let open = first.span;
  let said = new Map([[first.of.said, first.of]]);
  for (const piece of rest) {
    const earlier = said.get(piece.of.said);
    const repeats = earlier !== undefined && earlier !== piece.of;
    const joined = { start: open.start, end: piece.span.end };
    if (!repeats && fits(joined)) {
      open = joined;
      said.set(piece.of.said, piece.of);
    } else {
      units.push(open);
      open = piece.span;
      said = new Map([[piece.of.said, piece.of]]);
    }
  }
  units.push(open);
  return units;
};

const unitsOf = (utterance: Utterance, countTokens: TokenCount): readonly SynthesisUnit[] => {
  const text = utterance.text;
  const fed = (span: Span): PreparedText => prepareText(text.slice(span.start, span.end));
  const fits: Fits = (span) => countTokens(fed(span).text) <= MAX_UNIT_TOKENS;
  const sentences: readonly Sentence[] = trimmed(text, 0, text.length)
    .flatMap((whole) => cut(text, whole, atSentenceEnd))
    .map((span) => ({ span, said: fed(span).text }));
  const pieces = sentences.flatMap((of) => refine(text, of.span, fits, REFINEMENTS).map((span) => ({ span, of })));
  return pack(pieces, fits).map((span) => ({ utterance, start: span.start, end: span.end, ...fed(span) }));
};

// Utterances in, units out, in the same order; a unit never spans two utterances because
// each has its own voice and anchor.
export const deriveSpeechScript = (
  utterances: ReadonlyArray<Utterance>,
  countTokens: TokenCount,
): ReadonlyArray<SynthesisUnit> => utterances.flatMap((utterance) => unitsOf(utterance, countTokens));

// ── identity ────────────────────────────────────────────────────────────────────────

// The versions a rendition depends on, split the way units depend on them: `model` is
// what every unit shares (weights and tokenizer); `voices` is each voice's own asset, so
// a unit can carry the version of the one voice it is spoken in; `tokenizer` alone is what
// the cut of a script depends on, since the budget is counted in its tokens.
export interface RenditionVersions {
  readonly pipeline: string;
  readonly generation: string;
  readonly model: string;
  readonly tokenizer: string;
  readonly voices: Readonly<Record<VoiceId, string>>;
}

export const renditionVersions = (manifest: ModelAssetManifest): RenditionVersions => ({
  pipeline: PIPELINE_VERSION,
  generation: GENERATION_VERSION,
  model: [manifest.weights, manifest.tokenizer].map(assetVersion).join(","),
  tokenizer: assetVersion(manifest.tokenizer),
  voices: Object.fromEntries(VOICE_IDS.map((id) => [id, assetVersion(manifest.voices[id])])) as Record<VoiceId, string>,
});

export const RENDITION_VERSIONS: RenditionVersions = renditionVersions(MODEL_ASSETS);

// [LAW:one-source-of-truth] The ONE identity of a rendition: which model, under which
// rules and generation, said exactly which text in which voice, unit by unit. It hashes the version of
// the voice each unit is actually spoken in rather than the whole voice map or the whole
// manifest, so changing — or re-recording — a voice no unit of this paste uses does not
// orphan a listener's resume position. Client-side only — resume position, presets, an
// optional per-device cache — never a server key.
export const renditionHash = (
  units: ReadonlyArray<SynthesisUnit>,
  voiceMap: VoiceMap,
  versions: RenditionVersions = RENDITION_VERSIONS,
): Promise<string> =>
  contentHash({
    pipeline: versions.pipeline,
    generation: versions.generation,
    model: versions.model,
    units: units.map((u) => [u.utterance.index, versions.voices[voiceMap[u.utterance.voice]], u.text]),
  });

// [LAW:one-source-of-truth] One unit's identity: the rendition hash's term for a single
// generation, over exactly what a synthesize request carries — the fed text with the source
// its words are timed against, and the voice — under the same versions. The device keeps a
// unit's audio under it (keptAudio.ts), so an edit, another voice, a new model or new rules
// is another key and simply misses; and the same sentence in the same voice is one entry
// wherever it is said.
export const unitHash = (text: UnitText, voice: VoiceId, versions: RenditionVersions = RENDITION_VERSIONS): Promise<string> =>
  contentHash({ pipeline: versions.pipeline, generation: versions.generation, model: versions.model, voice: versions.voices[voice], text });

// [LAW:one-source-of-truth] A script's identity: exactly what `deriveSpeechScript` reads — each
// utterance's index, anchor, voice and text — under the rules that cut it and the tokenizer
// that counts its budget. The device keeps a paste's script under it (keptAudio.ts), so an
// edit, new rules or a new tokenizer is another key and simply misses. The voices a reader
// picks are not in it: a script is cut the same whoever speaks it.
export const scriptHash = (utterances: ReadonlyArray<Utterance>, versions: RenditionVersions = RENDITION_VERSIONS): Promise<string> =>
  contentHash({ pipeline: versions.pipeline, tokenizer: versions.tokenizer, utterances: utterances.map((u) => [u.index, u.anchor, u.voice, u.text]) });
