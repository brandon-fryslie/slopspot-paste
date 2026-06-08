// Quick parser sanity check. Run with: `node scripts/parser-check.ts`.
// Asserts the user's pasted CC example produces the expected sequence of
// turn kinds, plus regressions on the existing markdown-header format.
//
// No test framework — just throws on failure. Run before deploys to keep the
// parser honest as we add new sources.

import { detectSources, isClaudeShareUrl, parseInput, parsePaste } from "../src/parser";
import { parseClaudeShare } from "../src/parsers/claude-share";
import { isTurns, SOURCE_KINDS, textArmInput } from "../src/types";
import type { SourceKind } from "../src/types";
import {
  parseDiff,
  parseFileRead,
  formatBashTerminal,
  normalizeTables,
  renderMarkdown,
} from "../src/render";
import { renderTurnsHtml } from "../src/renderTurns";
import {
  convertKind,
  emptyTurn,
  newId,
  toBlocks,
  toTurns,
} from "../src/editor/blocks";
import type { Kind } from "../src/editor/blocks";
import type { Turn } from "../src/types";
import { readFileSync } from "node:fs";

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
  // For text arms: the detector IS the parser. expected() mirrors the text-
  // arm half of the detector; if the parser changes its mind, the detector
  // follows it. The claude-share arm uses a pattern check (not the parser)
  // so it's excluded here and verified separately in the T3 block below.
  const expected = (text: string): ReadonlyArray<SourceKind> =>
    SOURCE_KINDS.filter(
      (k) => k !== "claude-share" && parseInput(textArmInput(k, text)).ok,
    );

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

console.log("\nclaude-share parser (T3 — URL ingestion):");
{
  // isClaudeShareUrl — positive cases
  assert("https URL accepted",
    isClaudeShareUrl("https://claude.ai/share/61812fbb-da15-4992-8de8-1e6fbc7bbd82"));
  assert("http URL accepted (we upgrade later)",
    isClaudeShareUrl("http://claude.ai/share/abc123"));
  assert("trailing slash accepted",
    isClaudeShareUrl("https://claude.ai/share/abc123/"));
  assert("surrounding whitespace tolerated",
    isClaudeShareUrl("  https://claude.ai/share/abc123  \n"));
  assert("uppercase scheme accepted",
    isClaudeShareUrl("HTTPS://claude.ai/share/abc123"));
  assert("query string tolerated",
    isClaudeShareUrl("https://claude.ai/share/abc123?utm=x"));

  // isClaudeShareUrl — negative cases
  assert("plain text rejected", !isClaudeShareUrl("hello world"));
  assert("non-claude URL rejected", !isClaudeShareUrl("https://example.com/share/abc"));
  assert("claude.ai non-share URL rejected", !isClaudeShareUrl("https://claude.ai/new"));
  assert("share without id rejected", !isClaudeShareUrl("https://claude.ai/share/"));
  assert("multiline rejected", !isClaudeShareUrl("https://claude.ai/share/abc\nmore text"));
  assert("empty rejected", !isClaudeShareUrl(""));
  assert("whitespace-only rejected", !isClaudeShareUrl("   \n\t "));

  // Detector recognizes URLs and prioritizes claude-share
  const url = "https://claude.ai/share/61812fbb-da15-4992-8de8-1e6fbc7bbd82";
  const urlSet = detectSources(url);
  assert("URL detection includes claude-share", urlSet.includes("claude-share"));
  assert("URL detection ranks claude-share first", urlSet[0] === "claude-share");
  // URLs are short single lines; the raw fallback still applies because raw
  // never rejects anything. This is intentional: it gives the user an escape
  // hatch to render the URL string as a single bubble if Firecrawl is down.
  assert("URL detection still includes raw fallback", urlSet.includes("raw"));
  // None of the text-arm parsers should match a bare URL — no false-positives.
  ["claude-jsonl", "claude-code", "markdown", "chatgpt", "claude-paste"].forEach((k) => {
    assert(`URL excludes ${k}`, !urlSet.includes(k as SourceKind));
  });

  // parseInput must reject claude-share with a useful redirect message —
  // it has no synchronous interpretation.
  const blocked = parseInput({ kind: "claude-share", url });
  assert("parseInput rejects claude-share arm", !blocked.ok);
  if (!blocked.ok) {
    assert("parseInput error names the async path", blocked.reason.includes("ingestPaste"));
  }

  // parseClaudeShare against the real captured fixture
  const fixture = readFileSync("test/fixtures/claude-share.md", "utf8");
  const turns = parseClaudeShare(fixture);
  assert("fixture parses to non-null", turns !== null);
  if (turns) {
    assertEq("fixture turn count", turns.length, 2);
    const t0 = turns[0]!;
    const t1 = turns[1]!;
    assert("turn[0] is a user message",
      t0.kind === "message" && t0.role === "user");
    assert("turn[1] is an assistant message",
      t1.kind === "message" && t1.role === "assistant");
    assert("user message body contains original question",
      t0.kind === "message" && t0.content.includes("comrehensible to me without dumbing"));
    assert("assistant message contains the substantive answer",
      t1.kind === "message" && t1.content.includes("IsoAcoustics"));
    assert("boilerplate stripped from user body",
      t0.kind === "message" && !t0.content.includes("This is a copy of a chat"));
    assert("date stamp stripped from user body",
      t0.kind === "message" && !/\bMay\s+18\b/.test(t0.content));
    assert("footer stripped from assistant body",
      t1.kind === "message" && !t1.content.includes("Ask Claude your own question"));
  }

  // parseClaudeShare fails cleanly on input with no headings.
  const noHeadings = parseClaudeShare("just some markdown with no\n## headings\nat all");
  assert("no You-said headings → null", noHeadings === null);

  // parseClaudeShare fails cleanly on input with only one heading
  // (single-turn share — we treat as malformed for now, two-turn minimum).
  const single = parseClaudeShare("## You said: hi\n\nhi\n");
  assert("single-heading share → null", single === null);

  // parseClaudeShare handles the alternate "Claude said:" label too.
  const altLabel = parseClaudeShare(
    "## You said: question\n\nquestion\n\n## Claude said: answer\n\nanswer body\n",
  );
  assert("alternate 'Claude said:' label parses", altLabel !== null);
  if (altLabel) {
    assertEq("alt label turn count", altLabel.length, 2);
  }
}

console.log("\nclaude-jsonl robustness + legacy auto-path (PR review):");
{
  // [LAW:behavior-not-structure] A malformed/hand-edited JSONL block (null or a
  // primitive where an object is expected) must be skipped at the trust
  // boundary, not crash the request. The valid text block alongside it survives.
  const MALFORMED = [
    { type: "user", message: { role: "user", content: "hi" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [null, "oops", 42, { type: "text", text: "still here" }],
      },
    },
  ].map((e) => JSON.stringify(e)).join("\n");
  const r = parseInput({ kind: "claude-jsonl", content: MALFORMED });
  assert("malformed JSONL blocks skipped (no crash)", r.ok);
  if (r.ok) {
    assert("valid text block survives malformed siblings",
      r.turns.some((t) => t.kind === "message" && t.content === "still here"));
  }

  // A tool_use with a non-string/missing id can't key the pairing map; it must
  // be skipped, not emit a tool-call with a corrupt key.
  const NO_ID = [
    { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "text", text: "after" },
    ] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const rid = parseInput({ kind: "claude-jsonl", content: NO_ID });
  assert("tool_use without id is skipped", rid.ok);
  if (rid.ok) {
    assert("no tool-call emitted for id-less tool_use",
      !rid.turns.some((t) => t.kind === "tool-call"));
    assert("sibling text still emitted",
      rid.turns.some((t) => t.kind === "message" && t.content === "after"));
  }

  // [LAW:one-source-of-truth] The legacy no-source path (parseAuto/parsePaste)
  // must recognize JSONL too, not fall through to a single raw bubble.
  const VALID = [
    { type: "user", message: { role: "user", content: "what's in the repo?" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Two entries." }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const auto = parsePaste(VALID);
  assert("parseAuto recognizes JSONL", auto.ok);
  if (auto.ok) {
    assertEq("parseAuto JSONL kinds", kinds(auto.turns), ["message", "message"]);
    assert("parseAuto did NOT fall back to a single raw bubble", auto.turns.length === 2);
  }
}

console.log("\nrenderTurns snapshot (pins preview === permalink markup):");
{
  // [LAW:behavior-not-structure] Assert the rendered-markup landmarks that the
  // permalink page and the future live preview both depend on — not the
  // function's internals. One fixture exercises every kind and every output kind.
  const DIFF_OUTPUT = `Added 1 line
      162 +new line of code
      163  context line`;
  const FILE_OUTPUT = `Read 2 lines
1  import { foo } from "bar";
2  export const x = 1;`;
  const fixture: Turn[] = [
    { kind: "message", role: "user", content: "hello" },
    { kind: "message", role: "assistant", content: "hi there" },
    { kind: "message", role: "system", content: "you are helpful" },
    { kind: "insight", content: "a key realization" },
    { kind: "turn-summary", text: "Sautéed for 53s" },
    { kind: "tool-call", tool: "Bash", args: "ls -la", output: { kind: "terminal", text: "total 0" } },
    { kind: "tool-call", tool: "Update", args: "src/x.ts", output: { kind: "diff", text: DIFF_OUTPUT } },
    { kind: "tool-call", tool: "Read", args: "src/x.ts", output: { kind: "file-read", text: FILE_OUTPUT } },
    { kind: "tool-call", tool: "WebFetch", args: "{json}", output: { kind: "generic", text: "some output" } },
    { kind: "tool-call", tool: "cherry-mcp", args: "", output: null },
  ];
  const html = renderTurnsHtml(fixture);

  const has = (label: string, needle: string) => assert(label, html.includes(needle));

  has("message user bubble", '<article class="bubble bubble-user" data-kind="message" data-role="user"');
  has("message assistant bubble", 'class="bubble bubble-assistant"');
  has("message system bubble", 'class="bubble bubble-system"');
  has("role label rendered", '<span class="role-name">Assistant</span>');
  has("insight star", '<span class="role-dot role-dot-insight" aria-hidden="true">★</span>');
  has("insight name", '<span class="role-name">Insight</span>');
  has("turn-summary aside", '<aside class="bubble-turn-summary" data-kind="turn-summary"');
  has("tool-call article + data-tool", '<article class="bubble bubble-tool-call" data-kind="tool-call" data-tool="Bash"');
  has("terminal frame", 'data-output-kind="terminal"');
  has("terminal $-prefix", '$ ls -la');
  has("diff frame", 'data-output-kind="diff"');
  has("diff added row", '<div class="diff-line diff-added">');
  has("diff summary pill", '>Added 1 line<');
  has("file-read frame", 'data-output-kind="file-read"');
  has("file row", '<div class="file-line">');
  has("generic frame", 'data-output-kind="generic"');
  has("generic args frame", 'data-output-kind="args"');
  // output: null tool-call shows only its header, no output frame. cherry-mcp is
  // the last turn, so nothing after its marker should contain a frame.
  const cherryIdx = html.indexOf('data-tool="cherry-mcp"');
  assert(
    "null-output tool-call emits header only",
    cherryIdx !== -1 && !html.slice(cherryIdx).includes("tool-output-frame"),
  );

  // [LAW:single-enforcer] The attribute/text-node escaping that Astro's auto-
  // escaping gave the deleted components must survive the move to string
  // concatenation. (Message/insight bodies go through renderMarkdown, whose
  // HTML handling is unchanged by this refactor and tested elsewhere.)
  const xss: Turn[] = [
    { kind: "tool-call", tool: 'evil" onload="x', args: "", output: null },
    { kind: "turn-summary", text: "<b>not bold</b>" },
    { kind: "tool-call", tool: "X", args: "", output: { kind: "generic", text: "<i>raw</i>" } },
  ];
  const xssHtml = renderTurnsHtml(xss);
  assert("tool name attribute escaped (no quote breakout)", !xssHtml.includes('data-tool="evil" onload='));
  assert("tool name attribute escaped form present", xssHtml.includes("evil&quot; onload="));
  assert("turn-summary text escaped", xssHtml.includes("&lt;b&gt;not bold&lt;/b&gt;"));
  assert("tool output text escaped", xssHtml.includes("&lt;i&gt;raw&lt;/i&gt;"));

  // A code-fence info string is user-controlled and lands in a class="" value;
  // escapeHtml alone leaves quotes intact, so a fence like ```js" onx=" would
  // break out of the attribute. The class attribute must quote-escape it.
  const fenceXss = renderMarkdown('```js" onmouseover="alert(1)\nx\n```');
  assert("fence language attribute escaped (no quote breakout)", !fenceXss.includes('" onmouseover="alert(1)"'));
  assert("fence language attribute escaped form present", fenceXss.includes("language-js&quot; onmouseover=&quot;alert(1)"));
}

console.log("\nBlock model (b48.2 — pure editor blocks):");
{
  // One fixture exercising every kind, including a tool-call with output.
  const fixture: Turn[] = [
    { kind: "message", role: "user", content: "hello" },
    { kind: "message", role: "assistant", content: "hi there" },
    { kind: "insight", content: "a key realization" },
    { kind: "turn-summary", text: "Sautéed for 53s" },
    {
      kind: "tool-call",
      tool: "Bash",
      args: "ls -la",
      output: { kind: "terminal", text: "total 0" },
    },
  ];

  // Round-trip: identity must attach and strip without touching the turn.
  const blocks = toBlocks(fixture);
  assertEq("toBlocks preserves count", blocks.length, fixture.length);
  assertEq("toTurns(toBlocks(t)) === t", toTurns(blocks), fixture);
  assert(
    "every block carries a non-empty id",
    blocks.every((b) => typeof b.id === "string" && b.id.length > 0),
  );
  assert(
    "ids are unique across blocks",
    new Set(blocks.map((b) => b.id)).size === blocks.length,
  );

  // newId draws fresh identity every call (no fixed/colliding value).
  const ids = [newId(), newId(), newId()];
  assert("newId is unique across calls", new Set(ids).size === 3);

  // emptyTurn seeds an empty turn of each kind.
  const allKinds: Kind[] = ["message", "insight", "turn-summary", "tool-call"];
  allKinds.forEach((k) => assertEq(`emptyTurn(${k}).kind`, emptyTurn(k).kind, k));
  const em = emptyTurn("message");
  assert(
    "emptyTurn(message) defaults role + empty content",
    em.kind === "message" && em.role === "assistant" && em.content === "",
  );
  const et = emptyTurn("tool-call");
  assert(
    "emptyTurn(tool-call) is empty tool, no output",
    et.kind === "tool-call" && et.tool === "" && et.args === "" && et.output === null,
  );

  // convertKind — content-bearing kinds preserve text across conversion.
  const ins = convertKind({ kind: "message", role: "user", content: "carry me" }, "insight");
  assert(
    "message -> insight preserves text",
    ins.kind === "insight" && ins.content === "carry me",
  );
  const sum = convertKind({ kind: "insight", content: "carry me" }, "turn-summary");
  assert(
    "insight -> turn-summary preserves text",
    sum.kind === "turn-summary" && sum.text === "carry me",
  );

  // convertKind TO tool-call — prior text seeds args, tool name empty.
  const toTool = convertKind({ kind: "message", role: "user", content: "do the thing" }, "tool-call");
  assert(
    "X -> tool-call seeds args, empty tool, no output",
    toTool.kind === "tool-call" &&
      toTool.tool === "" &&
      toTool.args === "do the thing" &&
      toTool.output === null,
  );

  // convertKind FROM tool-call — tool/args/output joined into the content field.
  const fromTool = convertKind(
    { kind: "tool-call", tool: "Bash", args: "ls -la", output: { kind: "terminal", text: "total 0" } },
    "message",
  );
  assert(
    "tool-call -> message joins tool/args/output into content",
    fromTool.kind === "message" &&
      fromTool.content.includes("Bash") &&
      fromTool.content.includes("ls -la") &&
      fromTool.content.includes("total 0"),
  );

  // Same-kind conversion is the identity — preserves fields text can't carry.
  const sameKind = convertKind({ kind: "message", role: "user", content: "keep my role" }, "message");
  assert(
    "convertKind to same kind preserves role (identity)",
    sameKind.kind === "message" && sameKind.role === "user" && sameKind.content === "keep my role",
  );
}

console.log("\nisTurns trust-boundary validator (b48.3 — /api/paste { turns } arm):");
{
  // [LAW:types-are-the-program] The accept/reject table for the editor arm.
  // isTurns is the single gate between user-edited wire JSON and the store; it
  // must accept every legal Turn[] and reject every malformed one — a missing
  // per-kind field, a bad discriminator, or a non-array. These are the shapes a
  // directly crafted request (bypassing the pristine client-side toTurns) could
  // send.

  // --- accepts: one valid turn of every kind ---
  assert("accepts message (all roles)", isTurns([
    { kind: "message", role: "user", content: "hi" },
    { kind: "message", role: "assistant", content: "yo" },
    { kind: "message", role: "system", content: "be nice" },
  ]));
  assert("accepts tool-call with null output", isTurns([
    { kind: "tool-call", tool: "Bash", args: "ls", output: null },
  ]));
  assert("accepts tool-call with every output kind", isTurns([
    { kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "terminal", text: "x" } },
    { kind: "tool-call", tool: "Update", args: "f", output: { kind: "diff", text: "x" } },
    { kind: "tool-call", tool: "Read", args: "f", output: { kind: "file-read", text: "x" } },
    { kind: "tool-call", tool: "X", args: "", output: { kind: "generic", text: "x" } },
  ]));
  assert("accepts insight", isTurns([{ kind: "insight", content: "aha" }]));
  assert("accepts turn-summary", isTurns([{ kind: "turn-summary", text: "Sautéed for 53s" }]));
  // Empty array IS a Turn[] — isTurns stays honest to its name; the API
  // boundary rejects empty separately as "Empty paste".
  assert("accepts empty array (boundary rejects empty separately)", isTurns([]));

  // --- rejects: malformed message ---
  assert("rejects bad role", !isTurns([{ kind: "message", role: "bot", content: "x" }]));
  assert("rejects missing role", !isTurns([{ kind: "message", content: "x" }]));
  assert("rejects missing content", !isTurns([{ kind: "message", role: "user" }]));
  assert("rejects non-string content", !isTurns([{ kind: "message", role: "user", content: 5 }]));

  // --- rejects: malformed tool-call ---
  assert("rejects tool-call missing output (must be explicit null)",
    !isTurns([{ kind: "tool-call", tool: "Bash", args: "ls" }]));
  assert("rejects tool-call non-string tool",
    !isTurns([{ kind: "tool-call", tool: 1, args: "ls", output: null }]));
  assert("rejects tool-call bad output kind",
    !isTurns([{ kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "bogus", text: "x" } }]));
  assert("rejects tool-call output missing text",
    !isTurns([{ kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "terminal" } }]));

  // --- rejects: malformed insight / turn-summary ---
  assert("rejects insight missing content", !isTurns([{ kind: "insight" }]));
  assert("rejects turn-summary non-string text", !isTurns([{ kind: "turn-summary", text: [] }]));

  // --- rejects: bad discriminator / shape (the enumeration gap) ---
  assert("rejects unknown kind", !isTurns([{ kind: "banana", content: "x" }]));
  assert("rejects missing kind", !isTurns([{ role: "user", content: "x" }]));
  assert("rejects null element", !isTurns([null]));
  assert("rejects primitive element", !isTurns([42]));
  assert("rejects non-array (string)", !isTurns("nope"));
  assert("rejects non-array (object)", !isTurns({ kind: "message", role: "user", content: "x" }));
  assert("rejects null", !isTurns(null));
  // One bad turn among good ones poisons the whole batch — no partial accept.
  assert("rejects array with one malformed turn", !isTurns([
    { kind: "message", role: "user", content: "ok" },
    { kind: "message", role: "nope", content: "bad" },
  ]));

  // --- round-trip: toTurns output (what the editor actually submits) passes ---
  const fixture: Turn[] = [
    { kind: "message", role: "user", content: "hello" },
    { kind: "insight", content: "a key realization" },
    { kind: "tool-call", tool: "Bash", args: "ls -la", output: { kind: "terminal", text: "total 0" } },
  ];
  assert("accepts editor toTurns output (round-trip)", isTurns(toTurns(toBlocks(fixture))));
}

if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nAll checks passed.");
}
