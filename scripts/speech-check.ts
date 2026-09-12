// The Listen tool: what gets spoken, and in whose voice
// (slopspot-speech-ins). Run: `tsx scripts/speech-check.ts`.
//
// Two layers, and each is here because a silent regression in it would be inaudible to
// every other check in the repo:
//
//   1. speakableSegments — the markdown→speech rules. This is the layer with real
//      judgement in it: a fenced diff must be ANNOUNCED and never read, a link must lose
//      its URL and keep its label. Getting one rule wrong produces audio that is merely
//      unpleasant rather than broken, so nothing but assertions will catch it.
//   2. deriveUtterances — that speech is a projection of the SAME viewable dialogue the
//      renderer draws: carried indices, spine-only prose, folded detail announced.
//
// [LAW:behavior-not-structure] Every assertion is about an observable: the text handed to
// the synthesizer, the voice on an utterance, the state after an event. A different
// implementation of the same contract passes.

import { readFileSync } from "node:fs";
import { plainView, spineNodeLabel, type Dialogue, type SpineNode } from "../src/dialogue";
import { deriveUtterances, speakableSegments, type Utterance } from "../src/speech";

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
  // ChatGPT exports carry the full-size image URL as the alt text (slopspot-speech-2xf):
  // a 200-character URL read out letter by letter is worse than silence.
  assert("an image whose alt text is a URL is announced as an image alone", heard("![https://images.openai.com/a/b.png?purpose=fullsize](https://images.openai.com/a/b.png)") === "image");
  assert("an image with no alt text is announced as an image alone", heard("![](/x.png)") === "image");
  assert("a link whose label is its own URL becomes the word 'link'", heard("see [https://example.com/x](https://example.com/x)") === "see link");
  assert("a link with no label becomes the word 'link'", heard("see [](https://example.com/x)") === "see link");
  const chatgptShare = readFileSync("test/fixtures/chatgpt-share.md", "utf8");
  assert("the chatgpt-share fixture's spoken text contains no images.openai.com URL", !heard(chatgptShare).includes("images.openai.com"));
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

  // ── a bare thematic break (no pipe at all) is never a table divider ──
  assert(
    "a shell pipe above a plain horizontal rule keeps its meaning",
    heard("See `a | b` above.\n\n---\n\nnext paragraph") === "See a | b above. next paragraph",
  );
  assert(
    "a shell pipe below a plain horizontal rule keeps its meaning",
    heard("Notes\n\n---\nUse `ls | grep foo` to filter.") === "Notes Use ls | grep foo to filter.",
  );

  // ── a literal pipe inside a code span, in a REAL table row, is not a cell boundary ──
  const realTable = "| flag | example |\n| --- | --- |\n| x | `a|b` |";
  assert("a code span's pipe survives inside a genuine table cell", heard(realTable) === "flag, example x, a|b");

  // ── a code span whose content contains a backtick uses a longer delimiter run ──
  assert("a doubled-backtick span protects a literal backtick inside it", heard("say ``a`b`` now") === "say a`b now");
  assert("a doubled-backtick span is not split by its own interior backtick", heard("``a`b``") === "a`b");
  assert("a backtick run with no matching close is left as literal text", heard("odd `` run") === "odd `` run");

  // ── table-adjacency requires the row to be SHAPED like a row, not merely contain a pipe ──
  const proseAfterTable = "| a | b |\n| --- | --- |\n| 1 | 2 |\nSee y | z for details.";
  assert(
    "ordinary prose right after a real table's last row is not swept into it",
    heard(proseAfterTable) === "a, b 1, 2 See y | z for details.",
  );
  const absValueAfterTable = "| a | b |\n| --- | --- |\n| 1 | 2 |\nThe absolute value is |x - y| here.";
  assert(
    "absolute-value bars right after a real table's last row keep their meaning",
    heard(absValueAfterTable) === "a, b 1, 2 The absolute value is |x - y| here.",
  );

  // ── an escaped pipe inside a table cell is one cell's content, not two cells ──
  const escapedPipeCell = "| flag | example |\n| --- | --- |\n| x | uses a\\|b flag |";
  assert(
    "an escaped pipe inside a table cell stays one cell",
    heard(escapedPipeCell) === "flag, example x, uses a|b flag",
  );

  // ── a pipeless GFM table's header is still recognized (render.ts supports this shape) ──
  const pipelessTable = "a | b\n--- | ---\n1 | 2";
  assert("a pipeless table's header cells are converted", heard(pipelessTable).startsWith("a, b"));
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
    all.includes("2 tool calls, 1 thinking block, 1 token usage note not read aloud"),
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

  // renderDialogueHtml draws a turn-summary with escapeHtml alone, never renderMarkdown —
  // unlike text/insight blocks. Speech must match: markdown syntax in a turn-summary is
  // spoken LITERALLY, not stripped, or it would diverge from what the page actually shows.
  const literalSummary = deriveUtterances(
    plainView([{ kind: "assistant", blocks: [{ kind: "turn-summary", text: "Tool calls: `Bash`, `Read`." }] }]),
  );
  assert(
    "a turn-summary's markdown syntax is spoken literally, matching the page's escaped rendering",
    literalSummary[0]?.text === "Tool calls: `Bash`, `Read`.",
  );

  // A turn-summary sitting BETWEEN two chunks of assistant text (a mid-turn compaction
  // marker) renders on the page at its real block position — speech must speak it there
  // too, not after all the spine text regardless of where it actually sits.
  const midTurn = deriveUtterances(
    plainView([
      {
        kind: "assistant",
        blocks: [
          { kind: "text", content: "Before the marker." },
          { kind: "turn-summary", text: "Compacted here." },
          { kind: "text", content: "After the marker." },
        ],
      },
    ]),
  );
  assert(
    "a mid-turn summary is spoken in its actual block position, not after all the spine text",
    midTurn.map(textOf).join(" | ") === "Before the marker. | Compacted here. | After the marker.",
  );

  // A usage-only turn (no thinking/tool-calls at all) still gets its own announcement —
  // the detail count and the usage note are independent, not one gating the other. The
  // usage object's own raw counts (a distinctive value, so a leak is unmistakable) are
  // what must never be read as digits — the announcement's OWN count (how many usage
  // blocks) is a different number entirely and is meant to be spoken.
  const usageOnly = deriveUtterances(
    plainView([{ kind: "assistant", blocks: [{ kind: "usage", usage: { input: 24601, output: 24601, cacheCreation: 0, cacheRead: 0 } }] }]),
  );
  assert("a bare usage block still yields a singular announcement", usageOnly.some((u) => u.text === "1 token usage note not read aloud"));
  assert("raw token counts are never read as digits", !usageOnly.some((u) => u.text.includes("24601")));

  // Several usage blocks in one continuous turn (a multi-step agentic turn spanning
  // several LLM completions, each its own message id) are COUNTED, not collapsed to a
  // bare presence check that would always say "a token usage note" regardless of how many.
  const multiUsage = deriveUtterances(
    plainView([
      {
        kind: "assistant",
        blocks: [
          { kind: "usage", usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } },
          { kind: "usage", usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } },
          { kind: "usage", usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } },
        ],
      },
    ]),
  );
  assert("several usage blocks are counted and pluralized", multiUsage.some((u) => u.text === "3 token usage notes not read aloud"));

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

if (process.exitCode) {
  console.error("\nSpeech checks FAILED.");
} else {
  console.log("\nAll speech checks passed.");
}
