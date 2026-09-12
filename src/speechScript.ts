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
// that slice by a LENGTH-PRESERVING preparation plus at most one appended character:
// `text.charAt(i)` was `utterance.text.charAt(start + i)` for every i < end - start, and
// anything past that is ours. The character map is an offset, not a table, and it cannot
// drift because it is not stored [LAW:types-are-the-program].
//
// Audio remains a derived, disposable projection: nothing here is persisted and no audio
// is ever cached. The rendition hash names a rendition client-side (resume position,
// presets) and never server state [LAW:one-way-deps].

import { contentHash } from "./contentHash";
import { MAX_UNIT_TOKENS, MODEL_ASSETS, VOICE_IDS, assetVersion, type ModelAssetManifest, type VoiceId } from "./modelAssets";
import type { Utterance, Voice } from "./speech";

// Bump when any rule in this file changes what text a unit is fed or where units are cut:
// an old resume position or per-device cache keyed on the previous rules is then simply
// unused, never misapplied [LAW:no-ambient-temporal-coupling].
export const PIPELINE_VERSION = "1";

// [LAW:types-are-the-program] The tokenizer seam: how many text tokens the model would
// see for this exact string. The real answer needs the SentencePiece model, which lives
// in the worker; this module only ever asks the question.
export type TokenCount = (text: string) => number;

// One generation. `text` is the exact string the model is fed; [start, end) is where it
// came from in `utterance.text` (see the header for the character map). The utterance is
// held by reference: its index, anchor and voice are read from it, never copied where
// they could disagree [LAW:one-source-of-truth].
export interface SynthesisUnit {
  readonly utterance: Utterance;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

// What the worker reads of a unit: the text the model is fed and the utterance slice it
// covers. The utterance itself stays on the page.
export interface UnitText {
  readonly text: string;
  readonly source: string;
}

export const unitText = ({ utterance, start, end, text }: SynthesisUnit): UnitText => ({
  text,
  source: utterance.text.slice(start, end),
});

// Which model voice speaks each role. A VALUE the reader picks (voiceChoice.ts derives it
// from the pick kept on the device); changing it re-derives every rendition rather than
// re-deploying an asset.
export type VoiceMap = Readonly<Record<Voice, VoiceId>>;

// ── text preparation ────────────────────────────────────────────────────────────────
//
// Mirrors upstream prepare_text_prompt + _ensure_terminal_punctuation under the options
// the released model runs with (no space padding, semicolons kept, terminal punctuation
// appended), restricted to length-preserving edits so the character map stays an offset.
// The one non-preserving edit — a "." appended when the text has no sentence-final
// punctuation — is the last character, past the mapped range. Upstream's reason for it,
// verbatim: "Without one, the last word is often mispronounced or repeated."

export const TERMINAL: ReadonlySet<string> = new Set(".!?…");
// A trailing comma, colon or dash is replaced by a period (upstream's rule); a hyphen is
// in the set because upstream's is, and it can only ever be the LAST character here.
const WEAK = new Set(",;:-–—");
// Closing quotes and brackets that may legitimately follow a sentence's final period.
// Curly forms are included because they occur in the raw utterance text, which is what
// the sentence cutter sees; preparation straightens them afterwards.
export const CLOSERS: ReadonlySet<string> = new Set("\"')]»”’");

// The q35.1 spike heard every voice mangle the curly apostrophe in "isn’t" while reading
// the straight one in "it's" correctly, so curly quotes are straightened along with the
// newline flattening upstream does. Every replacement is one UTF-16 code unit for one.
const straightened = (slice: string): string =>
  slice
    .replace(/[\n\r]/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');

// Upper-cases the first character only when its upper-case form is the same length (ß →
// SS would shift every offset after it), which is the length-preserving theorem stated
// as a rule rather than assumed.
const capitalised = (text: string): string => {
  const first = text.charAt(0);
  const upper = first.toUpperCase();
  return (upper.length === first.length ? upper : first) + text.slice(1);
};

const isWhitespace = (c: string): boolean => /\s/.test(c);

// The index just past the "core": the text minus any trailing closers and spaces.
const endOfCore = (text: string): number => {
  let i = text.length;
  while (i > 0 && (CLOSERS.has(text.charAt(i - 1)) || isWhitespace(text.charAt(i - 1)))) i--;
  return i;
};

const withTerminalPunctuation = (text: string): string => {
  const core = endOfCore(text);
  const last = text.charAt(core - 1);
  if (TERMINAL.has(last)) return text;
  if (WEAK.has(last)) return text.slice(0, core - 1) + "." + text.slice(core);
  return text + ".";
};

// The exact string the model is fed for a trimmed slice of utterance text. Exported so
// the check can state the character-map theorem against it directly.
export const prepareText = (slice: string): string =>
  withTerminalPunctuation(capitalised(straightened(slice)));

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
// fits. The joined span is contiguous, so the original whitespace between the pieces is
// what separates them in the fed text. One rule of ours on top: a sentence whose text was
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
  const fed = (span: Span): string => prepareText(text.slice(span.start, span.end));
  const fits: Fits = (span) => countTokens(fed(span)) <= MAX_UNIT_TOKENS;
  const sentences: readonly Sentence[] = trimmed(text, 0, text.length)
    .flatMap((whole) => cut(text, whole, atSentenceEnd))
    .map((span) => ({ span, said: fed(span) }));
  const pieces = sentences.flatMap((of) => refine(text, of.span, fits, REFINEMENTS).map((span) => ({ span, of })));
  return pack(pieces, fits).map((span) => ({ utterance, start: span.start, end: span.end, text: fed(span) }));
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
// a unit can carry the version of the one voice it is spoken in.
export interface RenditionVersions {
  readonly pipeline: string;
  readonly model: string;
  readonly voices: Readonly<Record<VoiceId, string>>;
}

export const renditionVersions = (manifest: ModelAssetManifest): RenditionVersions => ({
  pipeline: PIPELINE_VERSION,
  model: [manifest.weights, manifest.tokenizer].map(assetVersion).join(","),
  voices: Object.fromEntries(VOICE_IDS.map((id) => [id, assetVersion(manifest.voices[id])])) as Record<VoiceId, string>,
});

export const RENDITION_VERSIONS: RenditionVersions = renditionVersions(MODEL_ASSETS);

// [LAW:one-source-of-truth] The ONE identity of a rendition: which model, under which
// rules, said exactly which text in which voice, unit by unit. It hashes the version of
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
    model: versions.model,
    units: units.map((u) => [u.utterance.index, versions.voices[voiceMap[u.utterance.voice]], u.text]),
  });
