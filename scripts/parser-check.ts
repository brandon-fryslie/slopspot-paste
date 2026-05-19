// Quick parser sanity check. Run with: `node scripts/parser-check.ts`.
// Asserts the user's pasted CC example produces the expected sequence of
// turn kinds, plus regressions on the existing markdown-header format.
//
// No test framework — just throws on failure. Run before deploys to keep the
// parser honest as we add new sources.

import { detectSources, parseInput, parsePaste } from "../src/parser";
import { SOURCE_KINDS } from "../src/types";
import type { SourceKind } from "../src/types";
import {
  parseDiff,
  parseFileRead,
  formatBashTerminal,
  normalizeTables,
  renderMarkdown,
} from "../src/render";
import type { Turn } from "../src/types";

const CC_SAMPLE = `❯ deleted

⏺ Laws applied to this final step

  - types-are-the-program: paste.slopspot.ai will now have one DNS owner (the Worker), removing the
  divergence-permissive state where two systems could claim the hostname.
  - dataflow-not-control-flow: Same redeploy → re-verify path; no special-case path for "fixing the DNS conflict."
  - one-source-of-truth: After deploy, wrangler.toml is the canonical owner of the routing claim; the DNS record is
  derived from it.
  - single-enforcer: Custom-domain provisioning happens at one moment — wrangler deploy — and nowhere else.
  - one-way-deps: User-facing wrangler.toml → adapter-generated dist/server/wrangler.json → Cloudflare. No loops.
  - one-type-per-behavior: One deploy verb (wrangler deploy), one verification routine.
  - verifiable-goals: Done = paste.slopspot.ai returns the index page in a real browser, paste round-trips, zero
  console errors.

⏺ Bash(cd /Users/bmf/code/slopspot-paste && npm run build 2>&1 | tail -3 && wrangler deploy --config
      dist/server/wrangler.json 2>&1 | tail -15)
  ⎿  19:30:57 [build] Server built in 2.80s
     19:30:57 [build] Complete!
     19:30:57 [vite]   ➜  Tunnel closed
     … +17 lines (ctrl+o to expand)
  ⎿  Shell cwd was reset to /Users/bmf/code/slopspot-web
  ⎿  (timeout 5m)

⏺ Custom domain attached. Verifying in the browser.

  Called cherry-chrome-mcp (ctrl+o to expand)

⏺ ★ Insight ─────────────────────────────────────
  - The 522 page title says slopspot-paste.pages.dev — Cloudflare is routing paste.slopspot.ai to the empty Pages
  project I created earlier (before we knew Astro 6 needed Workers-style deploy). The unused Pages project is
  shadowing the Worker. This is a one-source-of-truth violation: two systems both claim the same hostname.
  - The fix: delete the unused Pages project so the Worker's custom-domain claim is the sole owner of
  paste.slopspot.ai.
  ─────────────────────────────────────────────────

✻ Sautéed for 53s
`;

const MARKDOWN_SAMPLE = `## User
hello

## Assistant
hi there

## User
how are you?

## Assistant
doing well`;

const CHATGPT_SAMPLE = `You said:
What is 2+2?

ChatGPT said:
4

You said:
And 3+3?

ChatGPT said:
6`;

type Kind = Turn["kind"];

const kinds = (turns: ReadonlyArray<Turn>): Kind[] => turns.map((t) => t.kind);

const assertEq = <T,>(label: string, actual: T, expected: T): void => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${e}`);
    console.error(`    actual:   ${a}`);
    process.exitCode = 1;
  }
};

const assert = (label: string, cond: boolean): void => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  }
};

console.log("Claude Code transcript:");
const cc = parsePaste(CC_SAMPLE);
if (!cc.ok) {
  console.error("  ✗ parse failed:", cc.reason);
  process.exit(1);
}
assertEq("kinds sequence", kinds(cc.turns), [
  "message", // ❯ deleted
  "message", // ⏺ Laws applied …
  "tool-call", // ⏺ Bash(…)
  "message", // ⏺ Custom domain attached. …
  "tool-call", // Called cherry-chrome-mcp
  "insight", // ⏺ ★ Insight …
  "turn-summary", // ✻ Sautéed for 53s
]);

// Type-narrow and inspect specifics.
const t0 = cc.turns[0]!;
assert("turn[0] is user", t0.kind === "message" && t0.role === "user");
assert(
  "turn[0] content",
  t0.kind === "message" && t0.content === "deleted",
);
const t1 = cc.turns[1]!;
assert("turn[1] is assistant", t1.kind === "message" && t1.role === "assistant");
assert(
  "turn[1] starts with 'Laws applied'",
  t1.kind === "message" && t1.content.startsWith("Laws applied"),
);
const t2 = cc.turns[2]!;
assert("turn[2] is tool-call Bash", t2.kind === "tool-call" && t2.tool === "Bash");
assert(
  "turn[2] args contain build command",
  t2.kind === "tool-call" && t2.args.includes("npm run build"),
);
assert(
  "turn[2] output is terminal",
  t2.kind === "tool-call" && t2.output?.kind === "terminal",
);
assert(
  "turn[2] output contains build line",
  t2.kind === "tool-call" && (t2.output?.text ?? "").includes("[build] Server built"),
);
assert(
  "turn[2] output contains all three chunks",
  t2.kind === "tool-call" &&
    (t2.output?.text ?? "").includes("Shell cwd was reset") &&
    (t2.output?.text ?? "").includes("(timeout 5m)"),
);
const t4 = cc.turns[4]!;
assert(
  "turn[4] is cherry-chrome-mcp",
  t4.kind === "tool-call" && t4.tool === "cherry-chrome-mcp",
);
const t5 = cc.turns[5]!;
assert("turn[5] is insight", t5.kind === "insight");
assert(
  "turn[5] content has both bullets",
  t5.kind === "insight" &&
    t5.content.includes("522 page title") &&
    t5.content.includes("The fix"),
);
const t6 = cc.turns[6]!;
assert(
  "turn[6] is turn-summary with full text",
  t6.kind === "turn-summary" && t6.text === "✻ Sautéed for 53s",
);

console.log("\nMarkdown headers (regression):");
const md = parsePaste(MARKDOWN_SAMPLE);
if (!md.ok) {
  console.error("  ✗ parse failed:", md.reason);
  process.exit(1);
}
assertEq("kinds", kinds(md.turns), ["message", "message", "message", "message"]);
assertEq(
  "roles",
  md.turns.map((t) => (t.kind === "message" ? t.role : null)),
  ["user", "assistant", "user", "assistant"],
);

console.log("\nChatGPT 'You said:' (regression):");
const gpt = parsePaste(CHATGPT_SAMPLE);
if (!gpt.ok) {
  console.error("  ✗ parse failed:", gpt.reason);
  process.exit(1);
}
assertEq(
  "roles",
  gpt.turns.map((t) => (t.kind === "message" ? t.role : null)),
  ["user", "assistant", "user", "assistant"],
);

console.log("\nUpdate-tool diff parsing:");
const UPDATE_SAMPLE = `❯ apply the patch

⏺ Update(docs/PIPELINE_STAGES.md)
  ⎿  Added 1 line
      159  - Writes: nothing (test exit code).
      160  - Transformation: runs the isolated unit suites.
      161  - **Diagnostic only.** Tests catch regressions in pipeline tooling itself; they are not safety evi
           dence for the reconstruction transformation.
      162 +- Includes \`tests/entrypoint-smoke.test.mjs\`, which parameterizes over every successfully-built en
          +trypoint in \`bun-build.json\` and asserts each one loads without a body-eval-time \`TypeError\` — the
          + bpl.14 failure shape, broadened from \`cli-contract.test.mjs\`'s cli-only coverage so a regression
          +on \`mcp.ts\` / \`init.ts\` / SDK roots cannot hide behind unexercised commands.
      163
      164  ## Stage-input map (which stage feeds which)
      165

⏺ Done.
`;
const up = parsePaste(UPDATE_SAMPLE);
if (!up.ok) {
  console.error("  ✗ parse failed:", up.reason);
  process.exit(1);
}
const updateTurn = up.turns.find((t) => t.kind === "tool-call" && t.tool === "Update");
assert("Update turn exists", !!updateTurn);
if (updateTurn && updateTurn.kind === "tool-call") {
  assert("args is the file path", updateTurn.args.trim() === "docs/PIPELINE_STAGES.md");
  assert("output kind is diff", updateTurn.output?.kind === "diff");
  const diff = parseDiff(updateTurn.output?.text ?? "");
  assertEq("diff summary", diff.summary, "Added 1 line");
  const added = diff.lines.filter((l) => l.kind === "added");
  const contAdded = diff.lines.filter((l) => l.kind === "cont-added");
  const context = diff.lines.filter((l) => l.kind === "context");
  assert("at least one added line", added.length >= 1);
  assert("continuation-added lines present", contAdded.length >= 3);
  assert("at least three context lines", context.length >= 3);
  const firstAdded = added[0]!;
  assertEq("first added line number", firstAdded.lineNo, 162);
  assert(
    "first added content starts with '- Includes'",
    firstAdded.content.startsWith("- Includes"),
  );
}

console.log("\nFile-read parsing:");
const READ_SAMPLE = `1  import { foo } from "bar";
   2
   3  export const main = () => {
   4    console.log("hi");
   5  };`;
const fr = parseFileRead(READ_SAMPLE);
assertEq(
  "line numbers",
  fr.lines.map((l) => l.lineNo),
  [1, 2, 3, 4, 5],
);
assertEq("line 1 content", fr.lines[0]!.content, 'import { foo } from "bar";');
assertEq("line 4 content", fr.lines[3]!.content, '  console.log("hi");');

console.log("\nBash terminal formatting:");
assertEq(
  "single-line $-prefix",
  formatBashTerminal("ls -la", "total 0"),
  "$ ls -la\ntotal 0",
);
assertEq(
  "multi-line continuation indent",
  formatBashTerminal("cd /tmp && \\\n  npm install", "ok"),
  "$ cd /tmp && \\\n  npm install\nok",
);
assert(
  "empty output ok",
  formatBashTerminal("pwd", "") === "$ pwd",
);

console.log("\nTable normalization:");
{
  // Case 1: Pipe rows missing separator — must inject one.
  const input = `Some intro.

| Tool | Purpose |
| ripgrep | fast text search |
| fd | fast file find |

After.`;
  const normalized = normalizeTables(input);
  const norm = normalized.split("\n");
  assert(
    "separator injected after header",
    norm.some((l) => /^\|\s*---\s*\|\s*---\s*\|$/.test(l)),
  );
  // The data rows must be preserved.
  assert(
    "data rows preserved",
    norm.includes("| ripgrep | fast text search |") &&
      norm.includes("| fd | fast file find |"),
  );
  // And marked must render it as a real table.
  const html = renderMarkdown(input);
  assert("renders <table>", html.includes("<table>"));
  assert("wraps in scroll container", html.includes('<div class="table-wrap">'));
  assert("contains 'ripgrep' td", /<td[^>]*>ripgrep<\/td>/.test(html));
}

{
  // Case 2: Valid GFM table — separator already present, must not be doubled.
  const input = `| a | b |
| --- | --- |
| 1 | 2 |`;
  const normalized = normalizeTables(input);
  const seps = normalized
    .split("\n")
    .filter((l) => /^\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?$/.test(l.trim()));
  assertEq("valid GFM keeps exactly one separator", seps.length, 1);
  const html = renderMarkdown(input);
  assert("valid GFM still renders <table>", html.includes("<table>"));
}

{
  // Case 3: Pipes inside a code fence — leave alone, no table promotion.
  const input = "```\n| a | b |\n| 1 | 2 |\n```";
  const normalized = normalizeTables(input);
  // Inside the fence: no synthetic separator injected.
  assert(
    "code fence pipes untouched (no separator injected)",
    !/\|\s*---\s*\|\s*---\s*\|/.test(normalized),
  );
  const html = renderMarkdown(input);
  assert("code fence renders as pre, not table", !html.includes("<table>"));
}

{
  // Case 4: Pipe-prose with mismatched cell counts — must NOT be promoted.
  const input = `Conditions: x | y | z all hold
but only when a | b matches.`;
  const normalized = normalizeTables(input);
  assert(
    "mismatched-cell prose not promoted",
    !/\|\s*---\s*\|/.test(normalized),
  );
}

{
  // Case 5: Wide table — the renderer must still wrap it for overflow.
  const input = `| col1 | col2 | col3 | col4 | col5 |
| --- | --- | --- | --- | --- |
| https://example.com/a/very/long/path/that/has/no/spaces | b | c | d | e |`;
  const html = renderMarkdown(input);
  assert(
    "wide table wrapped for overflow",
    /<div class="table-wrap"><table>/.test(html),
  );
}

console.log("\nparseInput per-kind dispatch:");
{
  // chatgpt arm parses said-marker content cleanly
  const r = parseInput({ kind: "chatgpt", content: CHATGPT_SAMPLE });
  assert("chatgpt arm ok", r.ok);
  if (r.ok) {
    assertEq(
      "chatgpt roles",
      r.turns.map((t) => (t.kind === "message" ? t.role : null)),
      ["user", "assistant", "user", "assistant"],
    );
  }
}
{
  // markdown arm parses markdown headings cleanly
  const r = parseInput({ kind: "markdown", content: MARKDOWN_SAMPLE });
  assert("markdown arm ok", r.ok);
  if (r.ok) assertEq("markdown turn count", r.turns.length, 4);
}
{
  // claude-code arm parses the CC transcript
  const r = parseInput({ kind: "claude-code", content: CC_SAMPLE });
  assert("claude-code arm ok", r.ok);
  if (r.ok) assert("claude-code emits insight + turn-summary",
    r.turns.some((t) => t.kind === "insight") &&
    r.turns.some((t) => t.kind === "turn-summary"));
}
{
  // raw arm always produces one assistant bubble
  const r = parseInput({ kind: "raw", content: "just plain text\nno markers" });
  assert("raw arm ok", r.ok);
  if (r.ok) {
    assertEq("raw turn count", r.turns.length, 1);
    assert("raw is assistant message",
      r.turns[0]!.kind === "message" && r.turns[0]!.role === "assistant");
  }
}
{
  // wrong kind for content → typed failure, not silent fallback
  const r = parseInput({ kind: "claude-code", content: "## User\nhi\n## Assistant\nhello" });
  assert("wrong-kind pick fails cleanly", !r.ok);
  if (!r.ok) assert("failure reason names the kind",
    r.reason.toLowerCase().includes("claude-code"));
}
{
  // claude-paste arm parses Human:/Assistant: format
  const r = parseInput({
    kind: "claude-paste",
    content: "Human:\nhi\n\nAssistant:\nhello\n\nHuman:\nbye\n\nAssistant:\nlater",
  });
  assert("claude-paste arm ok", r.ok);
  if (r.ok) assertEq("claude-paste turn count", r.turns.length, 4);
}
{
  // empty content → typed failure regardless of kind
  const r = parseInput({ kind: "chatgpt", content: "   \n  " });
  assert("empty content fails cleanly", !r.ok);
}

console.log("\nclaude-jsonl parser (T4):");
{
  // Synthetic transcript exercising every block type the parser handles.
  // Two user prompts, one assistant text + tool_use + paired tool_result,
  // a thinking block (must be dropped), and a system-reminder envelope
  // (must be stripped from the user message body).
  const JSONL_SAMPLE = [
    { type: "user", message: { role: "user", content: "what's in the repo?" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning, should be filtered" },
          { type: "text", text: "Let me look around." },
          { type: "tool_use", id: "tool_abc", name: "Bash", input: { command: "ls", description: "List files" } },
        ],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_abc", content: "src\nREADME.md" }] },
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Two entries." }] },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: "thanks!<system-reminder>You are in 'explanatory' mode.</system-reminder>",
      },
    },
    // Non-message event (must be ignored, not crash the parser)
    { type: "permission-mode", permissionMode: "default", sessionId: "abc" },
  ].map((e) => JSON.stringify(e)).join("\n");

  const r = parseInput({ kind: "claude-jsonl", content: JSONL_SAMPLE });
  assert("claude-jsonl arm ok", r.ok);
  if (r.ok) {
    assertEq(
      "kinds sequence",
      kinds(r.turns),
      ["message", "message", "tool-call", "message", "message"],
    );
    const t0 = r.turns[0]!;
    assert("turn[0] is user 'what's in the repo?'",
      t0.kind === "message" && t0.role === "user" && t0.content === "what's in the repo?");
    const t1 = r.turns[1]!;
    assert("turn[1] is assistant 'Let me look around.'",
      t1.kind === "message" && t1.role === "assistant" && t1.content === "Let me look around.");
    // Thinking block MUST be filtered — verify it's not in the output.
    assert("no turn contains 'internal reasoning'",
      r.turns.every((t) => t.kind !== "message" || !t.content.includes("internal reasoning")));
    const t2 = r.turns[2]!;
    assert("turn[2] is Bash tool-call",
      t2.kind === "tool-call" && t2.tool === "Bash");
    assert("turn[2] args contain the command (JSON-serialized)",
      t2.kind === "tool-call" && t2.args.includes('"command": "ls"'));
    assert("turn[2] output paired from tool_result",
      t2.kind === "tool-call" && t2.output?.text === "src\nREADME.md");
    assert("turn[2] output kind classified as terminal (Bash)",
      t2.kind === "tool-call" && t2.output?.kind === "terminal");
    const t4 = r.turns[4]!;
    assert("turn[4] is user 'thanks!' (system-reminder envelope stripped)",
      t4.kind === "message" && t4.role === "user" && t4.content === "thanks!");
  }

  // Detector picks up the new kind on JSONL input.
  const det = detectSources(JSONL_SAMPLE);
  assert("detector includes claude-jsonl on JSONL input", det.includes("claude-jsonl"));
  assert("detector ranks claude-jsonl first (most specific)", det[0] === "claude-jsonl");

  // Bogus first line → null (not JSONL).
  const r2 = parseInput({ kind: "claude-jsonl", content: "this is not JSON\n{\"type\":\"user\"}" });
  assert("non-JSONL input fails cleanly", !r2.ok);

  // Empty JSONL → null.
  const r3 = parseInput({ kind: "claude-jsonl", content: "" });
  assert("empty input fails cleanly", !r3.ok);

  // JSONL with only non-message events → null (no parseable transcript).
  const noMsgs = [
    { type: "permission-mode", permissionMode: "default" },
    { type: "bridge-session", sessionId: "x" },
  ].map((e) => JSON.stringify(e)).join("\n");
  const r4 = parseInput({ kind: "claude-jsonl", content: noMsgs });
  assert("JSONL with no message events fails cleanly", !r4.ok);
}

console.log("\ndetectSources (T2 — UI-gating detector):");
{
  // The detector IS the parser: it must return exactly the kinds for which
  // parseInput would succeed. Verified by construction here against every
  // sample; if the parser changes its mind, the detector follows it.
  const expected = (text: string): ReadonlyArray<SourceKind> =>
    SOURCE_KINDS.filter((k) => parseInput({ kind: k, content: text }).ok);

  assertEq("empty → all kinds (priming)", detectSources(""), SOURCE_KINDS);
  assertEq("whitespace-only → all kinds (priming)", detectSources("   \n  \t  "), SOURCE_KINDS);

  // CC sample must include claude-code; raw is always present for non-empty.
  const ccSet = detectSources(CC_SAMPLE);
  assertEq("CC sample matches parser-truth", ccSet, expected(CC_SAMPLE));
  assert("CC sample includes claude-code", ccSet.includes("claude-code"));
  assert("CC sample includes raw", ccSet.includes("raw"));
  assert("CC sample's first kind is claude-code (priority)", ccSet[0] === "claude-code");

  const mdSet = detectSources(MARKDOWN_SAMPLE);
  assertEq("markdown sample matches parser-truth", mdSet, expected(MARKDOWN_SAMPLE));
  assert("markdown sample includes markdown", mdSet.includes("markdown"));
  assert("markdown sample's first kind is markdown (priority over raw)", mdSet[0] === "markdown");
  assert("markdown sample excludes claude-code", !mdSet.includes("claude-code"));

  const gptSet = detectSources(CHATGPT_SAMPLE);
  assertEq("chatgpt sample matches parser-truth", gptSet, expected(CHATGPT_SAMPLE));
  assert("chatgpt sample includes chatgpt", gptSet.includes("chatgpt"));
  assert("chatgpt sample's first kind is chatgpt (priority)", gptSet[0] === "chatgpt");
  // Parser overlap is a real feature, not a bug: the name-colon regex matches
  // "You said:" as a bare name + colon, classifyLabel resolves "you"→user via
  // leading-word fallback. Both parsers produce equivalent turns. The detector
  // surfaces both because both genuinely succeed — this is detector-is-the-
  // parser working correctly. A separate predicate would have lied about it.
  assert("chatgpt sample also includes claude-paste (parser overlap)",
    gptSet.includes("claude-paste"));

  // Pure prose with no markers: only raw matches. The dropdown will collapse
  // to a single option, which is the correct typed expression of "we have no
  // structural signal, the user gets a single bubble." claude-jsonl is also
  // excluded because plain prose isn't valid JSON on the first line.
  const proseSet = detectSources("just a single paragraph of text, no markers anywhere here");
  assertEq("plain prose → only raw", proseSet, ["raw"]);
}

if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nAll checks passed.");
}
