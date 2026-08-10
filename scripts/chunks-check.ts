// Embeddable chunk projection checks (slopspot-ask-rag-a3k.3). Run: `tsx scripts/chunks-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the
// pure projection (src/chunks.ts) over dialogues derived from the REAL parser
// fixtures in test/fixtures, plus the overlay interactions and the constructed
// edge shapes (long nodes, subagent nesting, prose-less nodes) the acceptance
// criteria name. [LAW:behavior-not-structure] Every assertion is about the
// projection's contract — anchors valid, bound held, visible prose covered,
// hidden content unreachable — never about how windows are packed internally.

import { readFileSync } from "node:fs";
import { parseClaudeShare } from "../src/parsers/claude-share";
import { parseChatgptShare } from "../src/parsers/chatgpt-share";
import { deriveDialogue, nodeVisibleProse, plainView } from "../src/dialogue";
import type { ViewableDialogue } from "../src/dialogue";
import { applyOverlay } from "../src/overlay";
import { CHUNK_MAX_CHARS, deriveChunks } from "../src/chunks";
import type { Turn } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// The acceptance invariants every view must satisfy, whatever produced it —
// asserted uniformly over each real fixture below, so a parser quirk in any one
// source (tool-heavy, PUA glyphs, artifacts) cannot slip a violating shape past
// the projection.
const assertInvariants = (name: string, view: ViewableDialogue): void => {
  const chunks = deriveChunks(view);
  const viewIndices = new Set(view.map((d) => d.index));
  assert(
    `${name}: every chunk's index is a spine index present in the view`,
    chunks.every((c) => viewIndices.has(c.index)),
  );
  assert(
    `${name}: no chunk exceeds CHUNK_MAX_CHARS (${CHUNK_MAX_CHARS})`,
    chunks.every((c) => c.text.length <= CHUNK_MAX_CHARS),
  );
  assert(
    `${name}: no chunk is empty or whitespace-only`,
    chunks.every((c) => c.text.trim().length > 0),
  );
  const covered = new Set(chunks.map((c) => c.index));
  assert(
    `${name}: every node with non-empty visible prose is covered by at least one chunk`,
    view
      .filter((d) => nodeVisibleProse(d.node).trim().length > 0)
      .every((d) => covered.has(d.index)),
  );
  assert(
    `${name}: deterministic — the same view yields the same chunks`,
    JSON.stringify(chunks) === JSON.stringify(deriveChunks(view)),
  );
};

console.log("Real parser fixtures (plain, un-overlaid views):");
const fixtureViews: Array<[string, ViewableDialogue]> = [];
{
  const claudeFixtures = [
    "claude-share",
    "claude-share-no-tools",
    "claude-share-pua",
    "claude-share-fenced-art",
    "claude-share-hidden-files",
    "claude-share-tools-artifact",
    "claude-share-tools-card-titles",
    "claude-share-tools-interleaved",
    "claude-share-tools-mcp",
    "claude-share-tools-websearch",
  ];
  for (const name of claudeFixtures) {
    const turns = parseClaudeShare(readFileSync(`test/fixtures/${name}.md`, "utf8"));
    // [LAW:no-silent-failure] A fixture that stops parsing is a loud failure of
    // THIS check, not a silently skipped source.
    assert(`${name}: fixture parses`, turns !== null);
    if (turns !== null) fixtureViews.push([name, plainView(deriveDialogue(turns))]);
  }
  const gpt = parseChatgptShare(readFileSync("test/fixtures/chatgpt-share.md", "utf8"));
  assert("chatgpt-share: fixture parses", gpt !== null);
  if (gpt !== null) fixtureViews.push(["chatgpt-share", plainView(deriveDialogue(gpt))]);

  for (const [name, view] of fixtureViews) assertInvariants(name, view);
  const total = fixtureViews.reduce((n, [, v]) => n + deriveChunks(v).length, 0);
  assert("fixtures produced a non-trivial corpus (some node yielded chunks)", total > 0);
}

console.log("\nOverlay interactions (the claude-share fixture):");
{
  const [, plain] = fixtureViews.find(([name]) => name === "claude-share")!;
  const dialogue = plain.map((d) => d.node);

  // A node with distinctive prose to hide, and a needle that provably detects it.
  const target = plain.find((d) => nodeVisibleProse(d.node).trim().length >= 40)!;
  const needle = nodeVisibleProse(target.node).trim().slice(0, 40);
  const plainChunks = deriveChunks(plain);
  assert(
    "positive control: the needle appears in the un-overlaid chunks",
    plainChunks.some((c) => c.text.includes(needle)),
  );

  // Whole-turn hide: the content is replaced upstream by applyOverlay, so the
  // hidden prose is unreachable from the chunk corpus BY CONSTRUCTION — the
  // guarantee the TL;DR and outline already make. Anchors stay put (hide
  // replaces in place), so remaining chunks still carry valid view indices.
  const hidden = applyOverlay(dialogue, [
    { kind: "hide", target: { kind: "turn", index: target.index } },
  ]);
  const hiddenChunks = deriveChunks(hidden);
  assert(
    "hide: the hidden node's prose reaches no chunk",
    hiddenChunks.every((c) => !c.text.includes(needle)),
  );
  assertInvariants("hide-view", hidden);

  // Feature (the omission arm): non-featured nodes are ABSENT from the view, so
  // they yield no chunk — and the survivor keeps its ORIGINAL index, so a hit
  // still resolves to the t<N> anchor the full page renders.
  const featured = applyOverlay(dialogue, [
    { kind: "feature", target: { kind: "turn", index: target.index } },
  ]);
  const featuredChunks = deriveChunks(featured);
  assert(
    "feature: a view without a node yields no chunk for it",
    featuredChunks.every((c) => c.index === target.index),
  );
  assert(
    "feature: the survivor's chunks carry its original spine index",
    featuredChunks.length > 0 && featuredChunks[0]!.index === target.index,
  );

  // Collapse folds presentation only — readable content is unchanged, so the
  // chunk corpus is unchanged (the same reason a collapse keeps the TL;DR cache).
  const collapsed = applyOverlay(dialogue, [
    { kind: "collapse", target: { kind: "turn", index: target.index } },
  ]);
  assert(
    "collapse: chunks are identical to the plain view's",
    JSON.stringify(deriveChunks(collapsed)) === JSON.stringify(plainChunks),
  );
}

console.log("\nLong nodes split into windows:");
{
  // Paragraphs that pack several to a window: all chunks share the node's spine
  // index, respect the bound, and every paragraph survives into exactly one chunk.
  const paragraphs = Array.from({ length: 12 }, (_, i) => `paragraph ${i} ` + "lorem ".repeat(120));
  const turns: Turn[] = [
    { kind: "message", role: "user", content: "q" },
    { kind: "message", role: "assistant", content: paragraphs.join("\n\n") },
  ];
  const view = plainView(deriveDialogue(turns));
  const chunks = deriveChunks(view).filter((c) => c.index === 1);
  assert("a long node yields multiple chunks", chunks.length > 1);
  assert(
    "every window respects the bound",
    chunks.every((c) => c.text.length <= CHUNK_MAX_CHARS),
  );
  assert(
    "every paragraph lands in exactly one window",
    paragraphs.every((p) => chunks.filter((c) => c.text.includes(p.trim())).length === 1),
  );
  assertInvariants("long-node", view);

  // A single unbroken paragraph over the bound is hard-sliced losslessly.
  const unbroken = "abcdefghij".repeat(500); // 5000 chars, no paragraph breaks
  const hardView = plainView(
    deriveDialogue([{ kind: "message", role: "assistant", content: unbroken }]),
  );
  const hardChunks = deriveChunks(hardView);
  assert(
    "an unbroken over-long paragraph is sliced into bounded chunks",
    hardChunks.length > 1 && hardChunks.every((c) => c.text.length <= CHUNK_MAX_CHARS),
  );
  assert(
    "hard slicing loses no content: the windows concatenate back to the paragraph",
    hardChunks.map((c) => c.text).join("") === unbroken,
  );

  // A slice boundary landing inside a surrogate pair backs off: no chunk edge
  // manufactures a lone surrogate.
  const emojiText = "x".repeat(CHUNK_MAX_CHARS - 1) + "😀" + "y".repeat(500);
  const emojiChunks = deriveChunks(
    plainView(deriveDialogue([{ kind: "message", role: "assistant", content: emojiText }])),
  );
  assert(
    "no chunk starts or ends with a lone surrogate half",
    emojiChunks.every(
      (c) => !/[\uD800-\uDBFF]$/.test(c.text) && !/^[\uDC00-\uDFFF]/.test(c.text),
    ),
  );
  assert(
    "the emoji survives whole in exactly one chunk",
    emojiChunks.filter((c) => c.text.includes("😀")).length === 1,
  );
}

console.log("\nProse-less and nested-subagent nodes contribute nothing:");
{
  // An assistant node holding only detail blocks (a tool call) has no visible
  // prose — it yields NO chunk, as a value falling out of the projection, and the
  // coverage invariant is satisfied vacuously for it.
  const toolOnly: Turn[] = [
    { kind: "message", role: "user", content: "run it" },
    { kind: "tool-call", tool: "Bash", args: '{"command":"ls"}', output: null },
    { kind: "message", role: "user", content: "thanks" },
  ];
  const toolView = plainView(deriveDialogue(toolOnly));
  const toolChunks = deriveChunks(toolView);
  assert(
    "a node with no visible prose yields no chunk",
    toolChunks.every((c) => c.index !== 1) && toolChunks.length === 2,
  );
  assertInvariants("tool-only", toolView);

  // DECISION (made visible here, as the ticket requires): nested subagent
  // transcripts contribute NO chunks. A subagent block is `detail` visibility,
  // and nested nodes have no top-level spine index — a hit inside one could
  // never resolve to a t<N> anchor, so indexing it would mint dead citations.
  const nested: Turn[] = [
    { kind: "message", role: "user", content: "outer question" },
    {
      kind: "subagent",
      agentType: "explore",
      description: "hunt the docs",
      stepCount: 2,
      transcript: {
        kind: "captured",
        turns: [
          { kind: "message", role: "user", content: "NESTED-PROMPT-PROSE" },
          { kind: "message", role: "assistant", content: "NESTED-RESULT-PROSE" },
        ],
      },
    },
    { kind: "message", role: "assistant", content: "outer answer" },
  ];
  const nestedView = plainView(deriveDialogue(nested));
  const nestedChunks = deriveChunks(nestedView);
  assert(
    "outer prose on both sides of the subagent is chunked",
    nestedChunks.some((c) => c.text.includes("outer question")) &&
      nestedChunks.some((c) => c.text.includes("outer answer")),
  );
  assert(
    "nested subagent transcript prose reaches no chunk",
    nestedChunks.every(
      (c) => !c.text.includes("NESTED-PROMPT-PROSE") && !c.text.includes("NESTED-RESULT-PROSE"),
    ),
  );
  assertInvariants("nested-subagent", nestedView);
}

console.log("\nchunks-check complete.");
