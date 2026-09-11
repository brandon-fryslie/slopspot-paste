// The speech script: how the utterances the Listen tool decided to say are cut into the
// units the in-browser model synthesizes, and what exact text each unit feeds it
// (slopspot-read-along-q35.3). Run: `tsx scripts/speech-script-check.ts`.
//
// Two kinds of assertion, kept apart on purpose:
//
//   1. Invariants that hold for ANY utterances under ANY tokenizer — nothing dropped, no
//      unit over budget, unit order is utterance order, the character map is an offset.
//      These run over the fixture paste twice: under a word-ish tokenizer that behaves
//      like SentencePiece on prose, and under a one-token-per-character tokenizer that
//      forces every refinement rule (weak punctuation, whitespace, single characters).
//   2. The rules themselves, each on a constructed utterance whose expected units can be
//      written down: sentence ends, the decimal point, repeated sentences, and the text
//      preparation upstream's model needs.
//
// [LAW:behavior-not-structure] Every assertion is about an observable: the text a unit
// feeds the model, its char range into the utterance, the hash. A different implementation
// of the same contract passes.

import { readFileSync } from "node:fs";
import { deriveDialogue, plainView } from "../src/dialogue";
import { MAX_UNIT_TOKENS, MODEL_ASSETS, type ModelAsset } from "../src/modelAssets";
import { parseChatgptShare } from "../src/parsers/chatgpt-share";
import { deriveUtterances, type Utterance, type Voice } from "../src/speech";
import { wordish } from "./speechFixtures";
import {
  CLOSERS,
  TERMINAL,
  deriveSpeechScript,
  prepareText,
  renditionHash,
  renditionVersions,
  RENDITION_VERSIONS,
  type SynthesisUnit,
  type TokenCount,
  type VoiceMap,
} from "../src/speechScript";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const perCharacter: TokenCount = (text) => text.length;
// The cutter's own mark sets, as the regex classes the sentence-end rules below use.
const charClass = (set: ReadonlySet<string>): string => `[${[...set].map((c) => c.replace(/[\]\\^-]/g, "\\$&")).join("")}]`;
const TERMINAL_MARK = charClass(TERMINAL);
const CLOSER_RUN = `${charClass(CLOSERS)}*`;
const wellFormed = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

const utter = (text: string, voice: Voice = "assistant", index = 0): Utterance => ({
  index,
  anchor: `t${index}`,
  voice,
  text,
});
const texts = (units: ReadonlyArray<SynthesisUnit>): ReadonlyArray<string> => units.map((u) => u.text);
const sourceOf = (u: SynthesisUnit): string => u.utterance.text.slice(u.start, u.end);
const endsSentence = (s: string): boolean => new RegExp(`${TERMINAL_MARK}${CLOSER_RUN}$`, "u").test(s);

const assertInvariants = (label: string, utterances: ReadonlyArray<Utterance>, count: TokenCount): void => {
  const units = deriveSpeechScript(utterances, count);
  const spoken = utterances.filter((u) => /\S/u.test(u.text));

  // Order: the utterances, in order, each contributing a contiguous run of units.
  const runs: Utterance[] = [];
  for (const u of units) if (runs[runs.length - 1] !== u.utterance) runs.push(u.utterance);
  assert(
    `${label}: unit order equals utterance order and every spoken utterance yields units`,
    runs.length === spoken.length && runs.every((u, i) => u === spoken[i]),
  );

  // Coverage: within one utterance the units are ordered, disjoint, in bounds, and the
  // only characters outside every unit are whitespace — nothing said is dropped.
  let covered = true;
  for (const u of spoken) {
    const own = units.filter((x) => x.utterance === u);
    const hits = new Array<number>(u.text.length).fill(0);
    let prevEnd = 0;
    for (const x of own) {
      if (x.start < prevEnd || x.end > u.text.length || x.start >= x.end) covered = false;
      for (let i = x.start; i < x.end; i++) hits[i] = (hits[i] ?? 0) + 1;
      prevEnd = x.end;
    }
    for (let i = 0; i < u.text.length; i++) {
      const h = hits[i] ?? 0;
      if (h > 1 || (h === 0 && /\S/u.test(u.text.charAt(i)))) covered = false;
    }
  }
  assert(`${label}: every non-whitespace character of every utterance lands in exactly one unit`, covered);

  assert(
    `${label}: no unit exceeds the model's budget of ${MAX_UNIT_TOKENS} tokens`,
    units.every((u) => count(u.text) <= MAX_UNIT_TOKENS),
  );

  // The character map is an offset: the fed text is the source slice, character for
  // character, plus at most one appended period.
  assert(
    `${label}: unit text is its source slice plus at most one appended character`,
    units.every((u) => {
      const extra = u.text.length - (u.end - u.start);
      return (extra === 0 && endsSentence(u.text)) || (extra === 1 && u.text.endsWith("."));
    }),
  );
  assert(`${label}: every unit ends with sentence-final punctuation`, units.every((u) => endsSentence(u.text)));
};

console.log("\nSpeech script — invariants over the fixture paste (slopspot-read-along-q35.3):");
{
  const gpt = parseChatgptShare(readFileSync("test/fixtures/chatgpt-share.md", "utf8"));
  assert("chatgpt-share: fixture parses", gpt !== null);
  if (gpt !== null) {
    const utterances = deriveUtterances(plainView(deriveDialogue(gpt)));
    const units = deriveSpeechScript(utterances, wordish);
    console.log(`  (${utterances.length} utterances → ${units.length} units under the word-ish tokenizer)`);
    assert("fixture yields a non-trivial script", utterances.length > 1 && units.length > utterances.length);
    assertInvariants("chatgpt-share/wordish", utterances, wordish);
    assertInvariants("chatgpt-share/per-character", utterances, perCharacter);

    // Sentence boundaries are respected: a cut inside an utterance falls at a sentence
    // end — unless the sentence containing it is over budget on its own, which is the one
    // licence to cut inside a sentence. The fixture has such sentences (table rows and
    // image URLs read as one run-on), so the containing sentence is located here by the
    // same observable rule: it runs from the previous sentence end to the next.
    const sentenceAround = (u: SynthesisUnit): string => {
      const text = u.utterance.text;
      let from = 0;
      for (const m of text.matchAll(new RegExp(`${TERMINAL_MARK}${CLOSER_RUN}(\\s+|$)`, "gu"))) {
        const to = m.index + m[0].length;
        if (to >= u.end) return text.slice(from, to);
        from = to;
      }
      return text.slice(from);
    };
    const inside = units.filter((u, i) => units[i + 1]?.utterance === u.utterance);
    assert(
      "chatgpt-share/wordish: every cut inside an utterance is at a sentence end or inside an oversized sentence",
      inside.every((u) => endsSentence(sourceOf(u)) || wordish(prepareText(sentenceAround(u))) > MAX_UNIT_TOKENS),
    );
    assert(
      "chatgpt-share/wordish: at least one utterance is cut into several units at sentence ends",
      inside.some((u) => endsSentence(sourceOf(u))),
    );
  }
}

console.log("\nText preparation (mirrors upstream prepare_text_prompt, length-preserving):");
{
  assert("curly apostrophe is straightened (the spike heard every voice mangle it)", prepareText("isn’t it") === "Isn't it.");
  assert("curly double quotes are straightened", prepareText("“quoted”") === '"quoted".');
  assert("newlines are flattened to spaces, one for one", prepareText("line one\nline two.") === "Line one line two.");
  assert("the first letter is capitalised", prepareText("hello world.") === "Hello world.");
  assert("a period is appended when the text has no sentence-final punctuation", prepareText("hello world") === "Hello world.");
  assert("a trailing comma becomes a period in place", prepareText("hello world,") === "Hello world.");
  assert("a trailing dash becomes a period in place", prepareText("hello world —") === "Hello world .");
  assert("a period is appended after a closing quote", prepareText('he said "hi"') === 'He said "hi".');
  assert("a trailing comma inside a closing quote becomes a period", prepareText('he said "hi,"') === 'He said "hi."');
  assert("existing terminal punctuation is left alone", prepareText("Done!") === "Done!" && prepareText("wait…") === "Wait…");
  assert("terminal punctuation followed by a closer is left alone", prepareText('she asked "why?"') === 'She asked "why?"');
  assert("a first letter whose upper case changes length is left alone", prepareText("ßtraße") === "ßtraße.");
  assert("a piece that is only closers still ends in a period", prepareText(")") === ")." && prepareText('")') === '").');
}

console.log("\nCutting rules:");
{
  assert("whitespace-only utterance yields no units", deriveSpeechScript([utter("   \n ")], wordish).length === 0);
  assert(
    "a short utterance is one unit, prepared",
    texts(deriveSpeechScript([utter("hello world")], wordish)).join("|") === "Hello world.",
  );
  assert(
    "short sentences pack into one unit with their original spacing",
    texts(deriveSpeechScript([utter("One. Two!  Three?")], wordish)).join("|") === "One. Two!  Three?",
  );
  assert(
    "a closing quote after a period stays with its sentence",
    texts(deriveSpeechScript([utter('He said "Go." She left.')], (t) => (t.match(/[.!?]/g) ?? []).length * 30)).join("|") ===
      'He said "Go."|She left.',
  );

  // A tokenizer that weighs every sentence end at 30 tokens forces one sentence per unit,
  // which makes the sentence cutter itself observable through the units.
  const heavy: TokenCount = (t) => (t.match(new RegExp(`${TERMINAL_MARK}(?=${CLOSER_RUN}(\\s|$))`, "gu")) ?? []).length * 30;
  assert(
    "a decimal point is not a sentence end",
    texts(deriveSpeechScript([utter("It took 3.5 seconds. Then 4.")], heavy)).join("|") === "It took 3.5 seconds.|Then 4.",
  );
  assert(
    "an ellipsis ends a sentence",
    texts(deriveSpeechScript([utter("Well… maybe. No.")], heavy)).join("|") === "Well…|Maybe.|No.",
  );

  const repeated = deriveSpeechScript([utter("code block, 2 lines. ".repeat(5), "narrator")], wordish);
  assert(
    "identical consecutive sentences never share a unit (the model collapses repeats)",
    texts(repeated).join("|") === Array(5).fill("Code block, 2 lines.").join("|"),
  );
  assertInvariants("repeated", [utter("code block, 2 lines. ".repeat(5), "narrator")], wordish);

  // An oversized sentence is cut at weak punctuation, each piece ending in a period.
  const clause = "a".repeat(30);
  const clauses = [utter(`${clause}, ${clause}, ${clause}.`)];
  assert(
    "an oversized sentence is cut at commas, each piece given a period",
    texts(deriveSpeechScript(clauses, perCharacter)).join("|") === Array(3).fill(`A${"a".repeat(29)}.`).join("|"),
  );
  assertInvariants("clauses/per-character", clauses, perCharacter);

  // No punctuation at all: cut at whitespace and repacked greedily under the budget.
  const words = [utter(Array(20).fill("abcde").join(" "))];
  const wordUnits = deriveSpeechScript(words, perCharacter);
  assert("an unpunctuated run is cut at whitespace into several units", wordUnits.length > 1);
  assertInvariants("words/per-character", words, perCharacter);

  // A single token longer than the budget: cut into code points, never fed over budget.
  const blob = [utter("x".repeat(120))];
  assert("a single oversized token is cut into budget-sized units", deriveSpeechScript(blob, perCharacter).length === 3);
  assertInvariants("blob/per-character", blob, perCharacter);
  // An astral run over budget: cut between code points, never inside a surrogate pair.
  const astral = [utter("🙂".repeat(60))];
  const astralUnits = deriveSpeechScript(astral, perCharacter);
  assert("an oversized astral run is cut into budget-sized, well-formed units", astralUnits.length === 3 && astralUnits.every((u) => wellFormed(u.text)));
  assertInvariants("astral/per-character", astral, perCharacter);

  // Units never span utterances, and each carries its own utterance by reference.
  const two = deriveSpeechScript([utter("Hi.", "user", 3), utter("Hello.", "assistant", 4)], wordish);
  assert(
    "units never span utterances",
    two.length === 2 && two[0]?.utterance.index === 3 && two[1]?.utterance.index === 4,
  );
}

console.log("\nRendition hash:");
{
  const voices: VoiceMap = { user: "alba", assistant: "marius", system: "javert", narrator: "fantine" };
  const units = deriveSpeechScript([utter("Hi there.", "user", 0), utter("Hello.", "assistant", 1)], wordish);
  const rehashed = <A extends ModelAsset>(asset: A): A => ({ ...asset, sha256: "f".repeat(64) });
  const [same, again, assistantChanged, unusedChanged, pipelineChanged, modelChanged, usedVoiceRehashed, unusedVoiceRehashed, textChanged] = await Promise.all([
    renditionHash(units, voices),
    renditionHash(units, voices),
    renditionHash(units, { ...voices, assistant: "eponine" }),
    renditionHash(units, { ...voices, narrator: "azelma" }),
    renditionHash(units, voices, { ...RENDITION_VERSIONS, pipeline: `${RENDITION_VERSIONS.pipeline}-next` }),
    renditionHash(units, voices, renditionVersions({ ...MODEL_ASSETS, weights: rehashed(MODEL_ASSETS.weights) })),
    renditionHash(units, voices, renditionVersions({ ...MODEL_ASSETS, voices: { ...MODEL_ASSETS.voices, alba: rehashed(MODEL_ASSETS.voices.alba) } })),
    renditionHash(units, voices, renditionVersions({ ...MODEL_ASSETS, voices: { ...MODEL_ASSETS.voices, fantine: rehashed(MODEL_ASSETS.voices.fantine) } })),
    renditionHash(deriveSpeechScript([utter("Hi there.", "user", 0), utter("Hello!", "assistant", 1)], wordish), voices),
  ]);
  assert("the same script under the same voices hashes the same", same === again);
  assert("changing the voice of a role that speaks changes the hash", same !== assistantChanged);
  assert("changing the voice of a role that never speaks keeps the hash", same === unusedChanged);
  assert("changing the pipeline version changes the hash", same !== pipelineChanged);
  assert("new weight bytes change the hash", same !== modelChanged);
  assert("new bytes for a voice that speaks change the hash", same !== usedVoiceRehashed);
  assert("new bytes for a voice that never speaks keep the hash", same === unusedVoiceRehashed);
  assert("changing what is said changes the hash", same !== textChanged);
  assert("the hash is a SHA-256 hex digest", /^[0-9a-f]{64}$/.test(same));
}
