// The Listen tool: what gets spoken, in whose voice, and how the player moves through it
// (slopspot-speech-ins). Run: `tsx scripts/speech-check.ts`.
//
// Three layers, and each is here because a silent regression in it would be inaudible to
// every other check in the repo:
//
//   1. speakableSegments — the markdown→speech rules. This is the layer with real
//      judgement in it: a fenced diff must be ANNOUNCED and never read, a link must lose
//      its URL and keep its label. Getting one rule wrong produces audio that is merely
//      unpleasant rather than broken, so nothing but assertions will catch it.
//   2. deriveUtterances — that speech is a projection of the SAME viewable dialogue the
//      renderer draws: carried indices, spine-only prose, folded detail announced.
//   3. advance / createPlayer — the position machine. Its whole reason to exist is that
//      the browser's own queue cannot be trusted with position, so the cases that matter
//      are the awkward ones (a late `end` from a cancelled sentence, finishing the last
//      utterance) which a hand-driven browser session will never reliably reproduce.
//
// [LAW:behavior-not-structure] Every assertion is about an observable: the text handed to
// the synthesizer, the voice on an utterance, the state after an event. A different
// implementation of the same contract passes.

import { JSDOM } from "jsdom";
import { plainView, spineNodeLabel, type Dialogue, type SpineNode } from "../src/dialogue";
import { deriveUtterances, speakableSegments, type Utterance } from "../src/speech";
import { advance, assignVoices, createPlayer, type PlayerState } from "../src/speechPlayer";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// The two things every rule below is really asking: what does a listener HEAR, and what
// did we say ON THEIR BEHALF. Spoken text is the concatenation of the quoted segments;
// announcements are ours.
const heard = (markdown: string): string =>
  speakableSegments(markdown)
    .filter((s) => s.kind === "quoted")
    .map((s) => s.text)
    .join(" ");
const announced = (markdown: string): ReadonlyArray<string> =>
  speakableSegments(markdown)
    .filter((s) => s.kind === "announced")
    .map((s) => s.text);

console.log("\nMarkdown → speech (slopspot-speech-ins):");
{
  // ── code is announced, never read ──
  const withCode = "Here is the fix:\n\n```python\nx = 1\ny = 2\n```\n\nand then it works.";
  assert("a fenced block's contents never reach the synthesizer", !heard(withCode).includes("x = 1"));
  assert("a fenced block is announced with its language and line count", announced(withCode).includes("python code block, 2 lines"));
  assert("prose on both sides of a block survives", heard(withCode) === "Here is the fix: and then it works.");
  // Order is the point: an announcement that drifted to the end would tell the listener
  // the code came after the sentence that follows it.
  assert(
    "the announcement keeps its place between the two prose runs",
    speakableSegments(withCode).map((s) => s.kind).join(",") === "quoted,announced,quoted",
  );

  assert("an unlabelled fence announces without inventing a language", announced("```\na\n```") [0] === "code block, 1 line");
  assert("one line is singular, not '1 lines'", announced("```\na\n```")[0]?.endsWith("1 line") === true);
  assert("a tilde fence is a fence too", announced("~~~js\na\nb\n~~~")[0] === "js code block, 2 lines");
  assert("an empty block says so rather than claiming zero lines", announced("```\n```")[0] === "code block, empty");
  // A truncated transcript genuinely contains these; refusing to speak the paste would be
  // a worse answer than announcing the block that was opened.
  assert("an unclosed fence is still announced", announced("text\n```sh\nls\nwc")[0] === "sh code block, 2 lines");

  // ── inline surfaces ──
  assert("inline code is read, without its backticks", heard("use `--force` here") === "use --force here");
  assert("a link keeps its label", heard("see [the docs](https://example.com/x)") === "see the docs");
  assert("a link's URL is never read aloud", !heard("see [the docs](https://example.com/x)").includes("example.com"));
  assert("a bare autolink becomes the word 'link'", heard("at <https://example.com/a/b>") === "at link");
  assert("an image is described by its alt text", heard("![a chart](/x.png)") === "image, a chart");
  assert("bold markers do not reach the synthesizer", heard("that is **very** bad") === "that is very bad");
  assert("italic markers do not either", heard("that is *very* bad") === "that is very bad");
  assert("bold-italic leaves no stray star", heard("that is ***very*** bad") === "that is very bad");
  assert("underscore emphasis is stripped", heard("that is __very__ bad") === "that is very bad");
  assert("strikethrough markers are stripped", heard("that is ~~very~~ bad") === "that is very bad");
  assert("stray html is not spoken", heard("a <br> b") === "a b");

  // ── line-leading structure ──
  assert("heading hashes are not spoken", heard("## The Plan") === "The Plan");
  assert("bullets are not spoken as dashes", heard("- one\n- two") === "one two");
  assert("ordered markers are not spoken as numbers", heard("1. one\n2. two") === "one two");
  assert("blockquote markers are stripped", heard("> quoted thing") === "quoted thing");
  assert("a horizontal rule has no spoken form", heard("a\n\n---\n\nb") === "a b");
  assert("a table's divider row is not spoken", !heard("| a | b |\n| --- | --- |\n| 1 | 2 |").includes("---"));
  assert("table cells are read, separated", heard("| a | b |\n| --- | --- |\n| 1 | 2 |") === "a, b 1, 2");

  // ── a bare pipe outside a real table is punctuation, not a cell boundary ──
  // Nothing here is adjacent to a divider row, so none of it is table-shaped.
  assert("a shell pipe in prose keeps its meaning", heard("run `ls | grep foo`") === "run ls | grep foo");
  assert("a boolean-or in prose is not rewritten", heard("use `a || b` for OR") === "use a || b for OR");
  assert("absolute-value bars are not read as a table row", heard("the distance is |x - y|") === "the distance is |x - y|");

  // ── fenced blocks close only on a matching, at-least-as-long delimiter (CommonMark) ──
  const nestedTilde = "```python\ndef f():\n    pass\n~~~\nstill code\n```\nafter";
  assert("a nested ~~~ line inside a backtick fence does not close it early", announced(nestedTilde)[0] === "python code block, 4 lines");
  assert("prose after the real close is still spoken", heard(nestedTilde) === "after");

  const shorterInner = "````\nouter\n```\nstill inside\n````\nafter";
  assert("a shorter run of the same character does not close a longer fence", announced(shorterInner)[0] === "code block, 3 lines");

  // ── inline code is protected from every other inline rule ──
  assert("a link written inside a code span is not turned into a link", heard("say `[text](url)`") === "say [text](url)");
  assert("emphasis markers inside a code span survive", heard("write `**bold**` literally") === "write **bold** literally");
  assert("a literal pipe inside a code span is not a table boundary", heard("the flag is `a|b`") === "the flag is a|b");

  assert("empty input yields nothing to say", speakableSegments("").length === 0);
  assert("whitespace-only input yields nothing to say", speakableSegments("   \n\n  ").length === 0);

  // ── GFM's actual divider requirement is 1+ hyphens per cell, not 2+ ──
  assert("a single-hyphen divider is still a real table", heard("| a | b |\n| - | - |\n| 1 | 2 |") === "a, b 1, 2");

  // ── a fence opener may carry more than a bare language ──
  assert("an info string with trailing annotation is still recognized as a fence", announced("```js twoslash\nx\n```")[0] === "js code block, 1 line");
  assert("only the first info-string token is spoken as the language", announced("```js {1,3}\nx\n```")[0] === "js code block, 1 line");
  assert("the fenced content itself never reaches the synthesizer", !heard("```js twoslash\nx\n```").includes("x"));
  assert("trailing whitespace alone still yields a bare language", announced("```python   \nx\n```")[0] === "python code block, 1 line");

  // ── a closing fence must carry NO info string, even if char/length match (CommonMark) ──
  const nestedSameChar = "```md\nExample:\n```js\nx\n```\n```\nend";
  assert(
    "a nested opener sharing the outer delimiter's char and length does not close it early",
    announced(nestedSameChar)[0] === "md code block, 3 lines",
  );

  // ── nested leading markers are stripped to a fixpoint, not just the outermost one ──
  assert("a heading quoted inside a blockquote loses both markers", heard("> ## Heading") === "Heading");
  assert("a bullet inside a blockquote loses both markers", heard("> - item") === "item");
}

console.log("\nDialogue → utterances (slopspot-speech-ins):");
{
  const dialogue: Dialogue = [
    { kind: "spoken", role: "user", content: "What does this do?" },
    {
      kind: "assistant",
      blocks: [
        { kind: "text", content: "It sorts the list." },
        { kind: "thinking", content: "SECRET REASONING" },
        { kind: "tool-call", tool: "Bash", args: "UNSPEAKABLE_ARGS", output: null },
        { kind: "tool-call", tool: "Read", args: "a.ts", output: null },
        { kind: "usage", usage: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 } },
      ],
    },
  ];
  const utterances = deriveUtterances(plainView(dialogue));
  const textOf = (u: Utterance): string => u.text;

  assert("the user's words are spoken in the user voice", utterances[0]?.voice === "user");
  assert("the user's words are spoken verbatim", utterances[0]?.text === "What does this do?");
  assert("an assistant's prose is spoken in the assistant voice", utterances[1]?.voice === "assistant");

  // The visual renderer folds thinking and tool calls behind a disclosure; the audio does
  // the same, which is the whole reason it reads the SPINE rather than every turn.
  const all = utterances.map(textOf).join(" | ");
  assert("collapsed thinking is not read aloud", !all.includes("SECRET REASONING"));
  // A distinctive sentinel, not a short token: "ls" would match the announcement's own
  // "tool calls" and pass for the wrong reason.
  assert("a tool call's arguments are not read aloud", !all.includes("UNSPEAKABLE_ARGS"));
  // …but the listener is told the conversation had a shape the audio abridged, including
  // the token-usage widget — a numeric readout, unspeakable the same way a diff is.
  assert(
    "folded detail is announced by count, usage included",
    all.includes("2 tool calls, 1 thinking block, a token usage note not read aloud"),
  );
  assert("the detail announcement is narrated, not attributed to the assistant", utterances.at(-1)?.voice === "narrator");

  // [LAW:one-source-of-truth] The anchor is the renderer's own t<N>, and the index is the
  // node's CARRIED index — so a view that omitted an earlier node still points each
  // utterance at the turn actually on the page.
  assert("each utterance anchors to its turn's rendered id", utterances[0]?.anchor === "t0");
  assert("assistant utterances anchor to their own turn", utterances[1]?.anchor === "t1");
  const sliced = deriveUtterances([{ index: 7, node: dialogue[0]!, collapsed: false }]);
  assert("a carried index is used verbatim, never the array position", sliced[0]?.anchor === "t7");
  assert("the carried index rides on the utterance too", sliced[0]?.index === 7);

  const system = deriveUtterances(plainView([{ kind: "spoken", role: "system", content: "Be brief." }]));
  assert("a system message speaks in the system voice", system[0]?.voice === "system");

  // A turn whose visible prose is empty contributes nothing rather than an empty utterance
  // the synthesizer would spend a beat of silence on.
  const silent = deriveUtterances(plainView([{ kind: "assistant", blocks: [{ kind: "text", content: "   " }] }]));
  assert("a node with no speakable prose yields no utterance", silent.length === 0);

  // Code inside a real message is announced through the same rules, in place.
  const coded = deriveUtterances(
    plainView([{ kind: "assistant", blocks: [{ kind: "text", content: "Try:\n```sh\nls -la\n```" }] }]),
  );
  assert("code inside an assistant message is announced", coded.some((u) => u.text === "sh code block, 1 line"));
  assert("the announcement inside a message is narrated", coded.find((u) => u.text.includes("code block"))?.voice === "narrator");
  assert("the prose around it stays the assistant's", coded[0]?.voice === "assistant");

  // A turn-summary block is real, page-visible prose (renderDialogueHtml draws it as a
  // visible <aside>, never folded) — so it is SPOKEN, not merely counted like the folded
  // detail above. Silently dropping it would violate this module's own no-silent-failure
  // claim, since the reader can see it on the page.
  const summarized = deriveUtterances(
    plainView([
      {
        kind: "assistant",
        blocks: [
          { kind: "text", content: "Done." },
          { kind: "turn-summary", text: "Session compacted at 40k tokens." },
        ],
      },
    ]),
  );
  assert("a turn-summary's text is spoken, not silently dropped", summarized.some((u) => u.text === "Session compacted at 40k tokens."));
  assert("turn-summary speaks in the narrator voice", summarized.find((u) => u.text.includes("compacted"))?.voice === "narrator");
  assert("the assistant's own text still comes first", summarized[0]?.text === "Done.");

  // A usage-only turn (no thinking/tool-calls at all) still gets its own announcement —
  // the detail count and the usage note are independent, not one gating the other.
  const usageOnly = deriveUtterances(
    plainView([{ kind: "assistant", blocks: [{ kind: "usage", usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } }] }]),
  );
  assert("a bare usage block still yields an announcement", usageOnly.some((u) => u.text === "a token usage note not read aloud"));
  assert("raw token counts are never read as digits", !usageOnly.some((u) => /\d/.test(u.text)));

  // [LAW:one-source-of-truth] A collapsed spine node (an authored feature/highlight-reel
  // fold) sits behind a native <details>, shown only on demand — the SAME fold the
  // rendered page applies. Speech mirrors it: announced by the node's own label rather
  // than read in full, exactly like folded detail inside a turn.
  const longContent =
    "This is a much longer message than the label truncation length allows, so the full " +
    "text would run well past what a folded turn's summary line is meant to show, and it " +
    "keeps going for a while yet.";
  const foldedNode: SpineNode = { kind: "spoken", role: "user", content: longContent };
  const folded = deriveUtterances([{ index: 3, node: foldedNode, collapsed: true }]);
  assert("a collapsed node yields exactly one utterance, not its full content", folded.length === 1);
  assert("a collapsed node's announcement is truncated, not the full text", folded[0]!.text.length < longContent.length);
  assert("a collapsed node is announced by its own rendered label", folded[0]?.text === `Folded: ${spineNodeLabel(foldedNode)}.`);
  assert("the fold announcement is narrated, not attributed to the folded speaker", folded[0]?.voice === "narrator");
  assert("a collapsed node still anchors to its own carried index", folded[0]?.anchor === "t3");
}

console.log("\nPlayer position machine (slopspot-speech-ins):");
{
  const N = 3;
  const idle: PlayerState = { kind: "idle" };

  assert("play from idle starts at the top", advance(idle, { kind: "play" }, N).kind === "speaking");
  assert("play from idle starts at 0", JSON.stringify(advance(idle, { kind: "play" }, N)) === JSON.stringify({ kind: "speaking", at: 0 }));
  assert("pause holds the position", JSON.stringify(advance({ kind: "speaking", at: 1 }, { kind: "pause" }, N)) === JSON.stringify({ kind: "paused", at: 1 }));
  assert("play from paused resumes where it stopped", JSON.stringify(advance({ kind: "paused", at: 1 }, { kind: "play" }, N)) === JSON.stringify({ kind: "speaking", at: 1 }));
  assert("stop returns to idle", advance({ kind: "speaking", at: 2 }, { kind: "stop" }, N).kind === "idle");
  assert("finishing advances one utterance", JSON.stringify(advance({ kind: "speaking", at: 0 }, { kind: "finished" }, N)) === JSON.stringify({ kind: "speaking", at: 1 }));
  assert("finishing the last utterance ends the session", advance({ kind: "speaking", at: N - 1 }, { kind: "finished" }, N).kind === "idle");

  // The case the whole design exists for: cancel() makes the browser fire `end` on a
  // sentence we abandoned. Acting on it would skip a turn the listener never heard.
  assert("a finish arriving while paused is ignored", JSON.stringify(advance({ kind: "paused", at: 1 }, { kind: "finished" }, N)) === JSON.stringify({ kind: "paused", at: 1 }));
  assert("a finish arriving while idle is ignored", advance(idle, { kind: "finished" }, N).kind === "idle");

  assert("jumping moves and plays", JSON.stringify(advance(idle, { kind: "jump", to: 2 }, N)) === JSON.stringify({ kind: "speaking", at: 2 }));
  assert("jumping while paused stays paused at the new place", JSON.stringify(advance({ kind: "paused", at: 0 }, { kind: "jump", to: 2 }, N)) === JSON.stringify({ kind: "paused", at: 2 }));

  // [LAW:no-silent-failure] An out-of-range jump is a caller bug; clamping it would play a
  // turn nobody asked for while reporting success.
  const throwsOn = (to: number): boolean => {
    try {
      advance(idle, { kind: "jump", to }, N);
      return false;
    } catch {
      return true;
    }
  };
  assert("jumping past the end throws rather than clamping", throwsOn(N));
  assert("jumping to a negative index throws", throwsOn(-1));
  assert("jumping to a fractional index throws", throwsOn(1.5));

  assert("a conversation with nothing to say cannot be played", advance(idle, { kind: "play" }, 0).kind === "idle");

  // [LAW:one-source-of-truth] send()'s no-op short-circuit is a REFERENCE check
  // (`after === before`), not a value check — so every arm that is conceptually already
  // there must return the SAME state object, not merely an equal-looking one.
  const pausedAt1: PlayerState = { kind: "paused", at: 1 };
  assert("jumping to the position already paused at is a true no-op", advance(pausedAt1, { kind: "jump", to: 1 }, N) === pausedAt1);
  const speakingAt1: PlayerState = { kind: "speaking", at: 1 };
  assert("jumping to the position already speaking at is a true no-op", advance(speakingAt1, { kind: "jump", to: 1 }, N) === speakingAt1);
  assert("stopping while already idle is a true no-op", advance(idle, { kind: "stop" }, N) === idle);
}

console.log("\nVoice assignment (slopspot-speech-ins):");
{
  const voice = (name: string, lang: string): SpeechSynthesisVoice =>
    ({ name, lang, default: false, localService: true, voiceURI: name }) as SpeechSynthesisVoice;

  const none = assignVoices([]);
  assert("a browser with no voices yields the synthesizer's default everywhere", none.user === null && none.narrator === null);

  const many = assignVoices([voice("Fr", "fr-FR"), voice("A", "en-US"), voice("B", "en-GB"), voice("C", "en-AU"), voice("D", "en-IE")]);
  assert("English voices are preferred over others", many.user?.lang.startsWith("en") === true);
  const picked = [many.user?.name, many.assistant?.name, many.system?.name, many.narrator?.name];
  assert("each of our voices gets a distinct synthesizer voice", new Set(picked).size === 4);

  // Fewer voices than we have roles is a real browser (mobile Safari), not an error: the
  // assignment wraps rather than handing back nulls it did not need to.
  const one = assignVoices([voice("Only", "en-US")]);
  assert("a single-voice browser still assigns every role", one.user?.name === "Only" && one.narrator?.name === "Only");
}

console.log("\nPlayer against a synthesizer (slopspot-speech-ins):");
{
  // A stub standing exactly where the browser's synthesizer stands. It records what it was
  // asked to say and, crucially, lets the check fire `end` by hand — including the LATE end
  // a real cancel() produces, which is the event no hand-driven browser session can be
  // relied on to reproduce.
  class StubUtterance {
    text: string;
    voice: SpeechSynthesisVoice | null = null;
    rate = 1;
    pitch = 1;
    onend: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }
  interface Synth {
    spoken: StubUtterance[];
    cancels: number;
    pauses: number;
    resumes: number;
  }
  const stand = (): { window: Window & typeof globalThis; synth: Synth } => {
    const dom = new JSDOM(`<!DOCTYPE html><body></body>`);
    const w = dom.window as unknown as Window & typeof globalThis;
    const synth: Synth = { spoken: [], cancels: 0, pauses: 0, resumes: 0 };
    Object.defineProperty(w, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => [],
        speak: (u: StubUtterance) => synth.spoken.push(u),
        cancel: () => {
          synth.cancels += 1;
        },
        pause: () => {
          synth.pauses += 1;
        },
        resume: () => {
          synth.resumes += 1;
        },
      },
    });
    Object.defineProperty(w, "SpeechSynthesisUtterance", { configurable: true, value: StubUtterance });
    return { window: w, synth };
  };

  const utterances: ReadonlyArray<Utterance> = [
    { index: 0, anchor: "t0", voice: "user", text: "first" },
    { index: 1, anchor: "t1", voice: "assistant", text: "second" },
    { index: 2, anchor: "t2", voice: "narrator", text: "third" },
  ];

  // [LAW:no-silent-failure] A browser with no speech synthesis yields no player, which is
  // what lets the page omit the Listen tool entirely instead of showing a dead button.
  {
    const dom = new JSDOM(`<!DOCTYPE html><body></body>`);
    const bare = dom.window as unknown as Window & typeof globalThis;
    const player = createPlayer({ window: bare, utterances, onUtterance: () => {}, onState: () => {} });
    assert("a browser without speech synthesis yields no player", player === null);
  }

  {
    const { window, synth } = stand();
    const seen: (Utterance | null)[] = [];
    const player = createPlayer({ window, utterances, onUtterance: (u) => seen.push(u), onState: () => {} });
    if (player === null) throw new Error("speech-check: stub synthesizer did not yield a player");

    player.send({ kind: "play" });
    assert("playing speaks the first utterance", synth.spoken[0]?.text === "first");
    assert("playing reports which utterance is speaking", seen[0]?.anchor === "t0");

    // The synthesizer finishing is what advances the conversation — the player never
    // queues ahead of itself.
    synth.spoken[0]?.onend?.();
    assert("finishing one utterance speaks the next", synth.spoken[1]?.text === "second");
    assert("the reported utterance follows along", seen[1]?.anchor === "t1");

    // Deltas, not totals: starting playback legitimately cancels first, to take ownership
    // of a queue the page shares with anything else that speaks. What matters is that
    // PAUSE adds no cancel of its own — a cancelled sentence could not be resumed mid-word.
    const cancelsBeforePause = synth.cancels;
    player.send({ kind: "pause" });
    assert("pausing pauses the synthesizer", synth.pauses === 1);
    assert("pausing does not cancel the sentence it is holding", synth.cancels === cancelsBeforePause);
    assert("pausing holds the position", player.state().kind === "paused");

    player.send({ kind: "play" });
    assert("resuming resumes rather than re-speaking the sentence", synth.resumes === 1 && synth.spoken.length === 2);

    const cancelsBeforeStop = synth.cancels;
    player.send({ kind: "stop" });
    assert("stopping cancels the sentence in progress", synth.cancels === cancelsBeforeStop + 1);
    assert("stopping reports that nothing is speaking", seen.at(-1) === null);
    assert("stopping returns to idle", player.state().kind === "idle");
  }

  // The bug this design exists to prevent: cancel() fires `end` on the abandoned sentence.
  // A player that trusted that event would advance past a turn nobody heard.
  {
    const { window, synth } = stand();
    const player = createPlayer({ window, utterances, onUtterance: () => {}, onState: () => {} });
    if (player === null) throw new Error("speech-check: stub synthesizer did not yield a player");

    player.send({ kind: "play" });
    const abandoned = synth.spoken[0];
    player.send({ kind: "stop" });
    abandoned?.onend?.(); // the late end, arriving after the cancel
    assert("a late 'end' from a cancelled sentence does not restart playback", player.state().kind === "idle");
    assert("a late 'end' speaks nothing further", synth.spoken.length === 1);
  }

  // Jumping is how the page will wire "listen from this turn".
  {
    const { window, synth } = stand();
    const player = createPlayer({ window, utterances, onUtterance: () => {}, onState: () => {} });
    if (player === null) throw new Error("speech-check: stub synthesizer did not yield a player");

    player.send({ kind: "jump", to: 2 });
    assert("jumping speaks the utterance jumped to", synth.spoken.at(-1)?.text === "third");
    assert("jumping abandons whatever was mid-sentence", synth.cancels === 1);

    synth.spoken.at(-1)?.onend?.();
    assert("finishing the last utterance ends the session", player.state().kind === "idle");
  }

  // Delivery differs by voice, which is how a listener tells our narration from the
  // author's words without us saying the word "narrator" on every announcement.
  {
    const { window, synth } = stand();
    const player = createPlayer({ window, utterances, onUtterance: () => {}, onState: () => {} });
    if (player === null) throw new Error("speech-check: stub synthesizer did not yield a player");
    player.send({ kind: "jump", to: 2 });
    const narrated = synth.spoken.at(-1);
    assert("narration is delivered differently from speech", narrated?.rate !== 1 || narrated?.pitch !== 1);
  }

  // The bug this design exists to prevent: jumping while paused cancels the live sentence
  // without requeuing it (advance()'s pure spec says "stay paused at the new place", and
  // nothing SHOULD speak yet) — so a naive "same index => resume" shortcut on the
  // subsequent Play would call synth.resume() on a synthesizer holding nothing at all,
  // producing silence with the transport stuck reporting "speaking" forever.
  {
    const { window, synth } = stand();
    const states: PlayerState[] = [];
    const player = createPlayer({ window, utterances, onUtterance: () => {}, onState: (s) => states.push(s) });
    if (player === null) throw new Error("speech-check: stub synthesizer did not yield a player");

    player.send({ kind: "play" }); // speaking at 0
    player.send({ kind: "pause" }); // paused at 0
    player.send({ kind: "jump", to: 2 }); // paused at 2 — nothing queued for index 2
    assert("jumping while paused does not resume the synthesizer", synth.resumes === 0);
    assert("jumping while paused reports the player still paused", states.at(-1)?.kind === "paused");

    const resumesBeforePlay = synth.resumes;
    const spokenBeforePlay = synth.spoken.length;
    player.send({ kind: "play" });
    assert("playing after a paused jump speaks fresh rather than resuming stale state", synth.resumes === resumesBeforePlay);
    assert("playing after a paused jump actually queues the jumped-to utterance", synth.spoken.length === spokenBeforePlay + 1);
    assert("the utterance queued is the one jumped to, not the one abandoned before pausing", synth.spoken.at(-1)?.text === "third");
    assert("the player is genuinely speaking, not stuck silent", player.state().kind === "speaking");
  }

  // Redundant events that advance() itself treats as no-ops must not touch the
  // synthesizer at all — the general branch would otherwise cancel a sentence that was
  // never asked to stop, for an event that changed nothing.
  {
    const { window, synth } = stand();
    const states: PlayerState[] = [];
    const player = createPlayer({ window, utterances, onUtterance: () => {}, onState: (s) => states.push(s) });
    if (player === null) throw new Error("speech-check: stub synthesizer did not yield a player");

    player.send({ kind: "play" });
    player.send({ kind: "pause" });
    const cancelsBeforeRedundant = synth.cancels;
    const statesBeforeRedundant = states.length;
    player.send({ kind: "pause" }); // already paused — advance() returns the same state
    assert("a redundant pause does not cancel the held sentence", synth.cancels === cancelsBeforeRedundant);
    assert("a redundant pause reports no new state change", states.length === statesBeforeRedundant);
  }

  // The header comment's stated invariant: voices are assigned FRESH per utterance, never
  // cached at construction. A stub whose getVoices() answer changes mid-session is the
  // only way to observe that — every earlier stub returned the same (empty) list for its
  // whole lifetime, which cannot distinguish "recomputed every time" from "read once".
  {
    const dom = new JSDOM(`<!DOCTYPE html><body></body>`);
    const w = dom.window as unknown as Window & typeof globalThis;
    const voice = (name: string): SpeechSynthesisVoice =>
      ({ name, lang: "en-US", default: false, localService: true, voiceURI: name }) as SpeechSynthesisVoice;
    let available: SpeechSynthesisVoice[] = [];
    const spoken: StubUtterance[] = [];
    Object.defineProperty(w, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => available,
        speak: (u: StubUtterance) => spoken.push(u),
        cancel: () => {},
        pause: () => {},
        resume: () => {},
      },
    });
    Object.defineProperty(w, "SpeechSynthesisUtterance", { configurable: true, value: StubUtterance });

    const player = createPlayer({ window: w, utterances, onUtterance: () => {}, onState: () => {} });
    if (player === null) throw new Error("speech-check: stub synthesizer did not yield a player");

    player.send({ kind: "play" }); // getVoices() still returns [] here
    assert("no voice is assigned while the browser has none to offer", spoken[0]?.voice === null);

    available = [voice("Late")]; // the voice list arrives AFTER the first utterance started
    spoken[0]?.onend?.();
    assert("a voice list that arrives late is picked up by the very next utterance", spoken[1]?.voice?.name === "Late");
  }
}

if (process.exitCode) {
  console.error("\nSpeech checks FAILED.");
} else {
  console.log("\nAll speech checks passed.");
}
