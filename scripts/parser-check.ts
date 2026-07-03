// Quick parser sanity check. Run with: `node scripts/parser-check.ts`.
// Asserts the user's pasted CC example produces the expected sequence of
// turn kinds, plus regressions on the existing markdown-header format.
//
// No test framework — just throws on failure. Run before deploys to keep the
// parser honest as we add new sources.

import { canonicalize, detectSources, ingestPaste, isUrl, parseFallback, parseInput, parsePaste, reprojectOrigin } from "../src/parser";
import { decodeRequest } from "../src/paste-request";
import { augmentJsonlWithSubagents } from "../src/parsers/jsonl";
import { parseClaudeShare } from "../src/parsers/claude-share";
import { parseChatgptShare } from "../src/parsers/chatgpt-share";
import { INPUT_KINDS, isOrigin, isTurns, PROVIDERS, sourceOf, sourceUrlOf, TEXT_ARM_KINDS, textArmInput } from "../src/types";
import type { InputKind, Origin, SourceKind } from "../src/types";
import { upgradeOrigin } from "../src/types";
import {
  parseDiff,
  parseFileRead,
  formatBashTerminal,
  normalizeTables,
  renderMarkdown,
  sanitizeUrl,
} from "../src/render";
import { highlightCode } from "../src/highlight";
import { renderDialogueHtml } from "../src/renderDialogue";
import { deriveDialogue, blockVisibility } from "../src/dialogue";
import type { AssistantBlock, SpineNode } from "../src/dialogue";
import { condenseToolCall, primaryArgValue, TOOL_PRIMARY_ARG } from "../src/toolCall";
import {
  convertKind,
  emptyTurn,
  isAuthorable,
  mergeTurns,
  newId,
  splitTurn,
  toBlocks,
  toTurns,
} from "../src/editor/blocks";
import type { AuthorableTurn, Kind } from "../src/editor/blocks";
import { EditorStore, type Draft, type DraftLoadResult, type EditorIo, type SubmitResult } from "../src/editor/store";
import { persistDrafts } from "../src/editor/mount";
import type { ParseResult, Turn } from "../src/types";
import { compareLines, findCredentialLeaks, scrubCredentials } from "./capture-fixture";
import { readFileSync } from "node:fs";
import { scrapeRequestBody } from "../src/firecrawl";
import {
  buildSummaryPrompt,
  renderDialogueForPrompt,
  summaryRequestBody,
  extractSummary,
  turnsContentHash,
  summarize,
  SUMMARY_SYSTEM_PROMPT,
} from "../src/summary";
import { FALLBACK_WAIT, PROVIDER_REGISTRY, resolveProvider } from "../src/providers";

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

// [LAW:types-are-the-program] The FULL turn discriminator (all seven kinds,
// including the source-derived `usage`/`subagent`) — distinct from the editor's
// authorable `Kind` imported above (five kinds). The kind-sequence assertions
// below label whole parsed streams, so they must name every kind a Turn can be.
type TurnKind = Turn["kind"];

const kinds = (turns: ReadonlyArray<Turn>): TurnKind[] => turns.map((t) => t.kind);

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

console.log("\nsyntax highlighting (highlightCode at the render boundary):");
{
  // A declared, registered language highlights and keeps the author's label.
  const ts = highlightCode("export const x: number = 1;", "ts");
  assert("declared lang highlights", ts.kind === "highlighted");
  assert(
    "declared lang keeps author label",
    ts.kind === "highlighted" && ts.language === "ts",
  );
  assert(
    "highlighted output carries hljs token spans",
    ts.kind === "highlighted" && ts.html.includes('class="hljs-'),
  );

  // The highlighted markup round-trips to the original text — the copy button,
  // which reads the <code> textContent, still yields the exact bytes.
  const py = highlightCode('def greet(name):\n    print(f"hi {name}")', "python");
  const stripped =
    py.kind === "highlighted"
      ? py.html
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&amp;/g, "&")
      : "";
  assert(
    "highlighted text round-trips to source (copy stays correct)",
    stripped === 'def greet(name):\n    print(f"hi {name}")',
  );

  // A declared language we don't ship a grammar for: honor the label, no color.
  const unknown = highlightCode("frobnicate the widget", "wingdings");
  assert("unknown declared lang is labeled, not highlighted", unknown.kind === "labeled");
  assert(
    "unknown declared lang keeps the author label",
    unknown.kind === "labeled" && unknown.language === "wingdings",
  );

  // Unlabeled but substantial real code: auto-detected confidently (high
  // relevance AND a clear margin over the runner-up) and highlighted.
  const auto = highlightCode(
    "import os\n\ndef load_config(path):\n    with open(path) as f:\n        data = f.read()\n    return {k: v for k, v in parse(data)}\n\nclass Server:\n    def __init__(self, port):\n        self.port = port",
    undefined,
  );
  assert("unlabeled substantial code auto-detects", auto.kind === "highlighted");
  assert(
    "auto-detect classifies the right language",
    auto.kind === "highlighted" && auto.language === "python",
  );

  // Unlabeled prose: low confidence → plain, never a wrong-language guess.
  const prose = highlightCode("just some words that are not code at all", undefined);
  assert("unlabeled prose stays plain (no mislabel)", prose.kind === "plain");

  // Ambiguous short snippet that hljs mis-detects at low margin → refused to plain
  // rather than mislabeled (a JS one-liner gets guessed as bash at margin 0).
  const ambiguous = highlightCode("function add(a, b) {\n  return a + b;\n}", undefined);
  assert("ambiguous short snippet refused to plain (no mislabel)", ambiguous.kind === "plain");

  // End-to-end through the render boundary: hljs class present, escaping intact.
  const fenced = renderMarkdown("```python\nx = 1\n```");
  assert("render boundary emits hljs <code>", /<code class="hljs">/.test(fenced));
  assert("render boundary keeps code-lang label", /class="code-lang"/.test(fenced));
  const plainFence = renderMarkdown("```\nnot real code just prose words here\n```");
  assert(
    "render boundary leaves low-confidence block plain",
    !/<code class="hljs">/.test(plainFence) && /<code>/.test(plainFence),
  );
}

console.log("\nrenderMarkdown XSS safety (stored-XSS enforcer):");
{
  // The renderMarkdown theorem: no byte of pasted input becomes executable
  // HTML. These assert the contract (input → inert output), not the mechanism.

  // Vector 1: raw HTML blocks/inline tags render as literal text, never markup.
  const script = renderMarkdown("<script>alert(1)</script>");
  assert("raw <script> is escaped, not emitted", !/<script>/i.test(script));
  assert("raw <script> shown as text", script.includes("&lt;script&gt;"));

  const imgOnerror = renderMarkdown("<img src=x onerror=alert(2)>");
  assert(
    "raw <img onerror> is escaped, not emitted",
    !/<img/i.test(imgOnerror) && !/onerror/i.test(imgOnerror.replace(/&lt;[^&]*&gt;/g, "")),
  );
  assert("raw <img onerror> shown as text", imgOnerror.includes("&lt;img"));

  const inlineTag = renderMarkdown("inline <b>x</b> y");
  assert("inline raw HTML escaped", inlineTag.includes("&lt;b&gt;") && !/<b>/.test(inlineTag));

  // Vector 2: dangerous URL schemes on links/images become inert.
  const jsLink = renderMarkdown("[click](javascript:alert(3))");
  assert("javascript: link href neutralized", !/href="javascript:/i.test(jsLink));
  assert("neutralized link still renders an anchor", /<a /.test(jsLink));

  const jsImg = renderMarkdown("![x](javascript:alert(4))");
  assert("javascript: image src neutralized", !/src="javascript:/i.test(jsImg));

  // Safe markdown is untouched — the fix must not over-reach.
  const safeLink = renderMarkdown("[ok](https://example.com)");
  assert("https link preserved", safeLink.includes('href="https://example.com"'));
  const relLink = renderMarkdown("[rel](/path/to/page)");
  assert("relative link preserved", relLink.includes('href="/path/to/page"'));

  // sanitizeUrl unit contract — default-deny by scheme, whitespace-obfuscation safe.
  assertEq("https allowed", sanitizeUrl("https://x.com"), "https://x.com");
  assertEq("mailto allowed", sanitizeUrl("mailto:a@b.com"), "mailto:a@b.com");
  assertEq("relative allowed", sanitizeUrl("/a/b"), "/a/b");
  assertEq("fragment allowed", sanitizeUrl("#sec"), "#sec");
  assertEq("javascript denied", sanitizeUrl("javascript:alert(1)"), "#");
  assertEq("data denied", sanitizeUrl("data:text/html,<script>"), "#");
  assertEq("vbscript denied", sanitizeUrl("vbscript:msgbox(1)"), "#");
  assertEq(
    "whitespace-obfuscated javascript denied",
    sanitizeUrl("java\nscript:alert(1)"),
    "#",
  );
  assertEq(
    "leading-control javascript denied",
    sanitizeUrl(String.fromCharCode(1, 9, 32) + "javascript:alert(1)"),
    "#",
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
console.log("\nParse provenance (origin rides the ParseResult):");
{
  // [LAW:one-source-of-truth] A successful parse captures the verbatim input as
  // its origin; the styling kind is DERIVED from origin via sourceOf. Explicit
  // picks echo the pick, the auto-race reports its winner, the raw fallback names
  // itself — and the origin carries the exact content, byte-for-byte.
  const md = parseInput({ kind: "markdown", content: MARKDOWN_SAMPLE });
  assert("parseInput captures the requested kind in origin",
    md.ok && md.origin.kind === "markdown");
  assert("parseInput origin carries the verbatim content",
    md.ok && md.origin.kind === "markdown" && md.origin.content === MARKDOWN_SAMPLE);
  assert("sourceOf derives the styling kind from origin",
    md.ok && sourceOf(md.origin) === "markdown");

  const autoCc = parsePaste(CC_SAMPLE);
  assert("parseAuto origin names the winning kind (claude-code)",
    autoCc.ok && autoCc.origin.kind === "claude-code");
  assert("parseAuto origin carries the verbatim input (not normalized)",
    autoCc.ok && autoCc.origin.kind === "claude-code" && autoCc.origin.content === CC_SAMPLE);
  const autoMd = parsePaste(MARKDOWN_SAMPLE);
  assert("parseAuto origin names the winning kind (markdown)",
    autoMd.ok && sourceOf(autoMd.origin) === "markdown");
  const autoRaw = parsePaste("just plain text with no markers at all");
  assert("parseAuto raw fallback origin is raw",
    autoRaw.ok && sourceOf(autoRaw.origin) === "raw");
}

console.log("\nOrigin validator (isOrigin — shape table, provenance-kg4):");
{
  // [LAW:types-are-the-program] The accept/reject table IS the type. Origin is
  // captured server-side and re-read from KV (a trust boundary), so every legal
  // shape is accepted and every illegal one rejected by construction — the
  // enumeration gap is closed, not left to a downstream crash.
  const accepts: ReadonlyArray<[string, unknown]> = [
    ["text arm with content", { kind: "markdown", content: "## User\nhi" }],
    ["raw arm with empty content", { kind: "raw", content: "" }],
    ["every text arm accepted", { kind: "claude-jsonl", content: "{}" }],
    ["url arm with url + fetched + provider", { kind: "url", url: "https://claude.ai/share/x", fetched: "## You said: q", provider: "claude-share" }],
    ["url arm with provider:null (unclaimed host — fetched, no registered parser)", { kind: "url", url: "https://example.com/post", fetched: "## You said: q", provider: null }],
    ["editor with null source", { kind: "editor", source: null }],
    ["editor with a SourceKind source", { kind: "editor", source: "claude-code" }],
    ["editor with input (edited text import)", { kind: "editor", source: "claude-code", input: { kind: "claude-code", content: "original content" } }],
    ["editor with url input (edited share import)", { kind: "editor", source: "claude-share", input: { kind: "url", url: "https://claude.ai/share/x", fetched: "original", provider: "claude-share" } }],
  ];
  for (const [label, v] of accepts) assert(`accepts: ${label}`, isOrigin(v));

  const rejects: ReadonlyArray<[string, unknown]> = [
    ["null", null],
    ["a bare string", "markdown"],
    ["a number", 42],
    ["an array", []],
    ["empty object (no kind)", {}],
    ["text arm missing content", { kind: "raw" }],
    ["text arm with non-string content", { kind: "raw", content: 42 }],
    ["unknown kind", { kind: "nonsense", content: "x" }],
    ["claude-share kind is a Provider, not an Origin discriminator", { kind: "claude-share", url: "https://claude.ai/share/x", fetched: "body" }],
    ["url arm missing fetched", { kind: "url", url: "https://claude.ai/share/x", provider: "claude-share" }],
    ["url arm missing url", { kind: "url", fetched: "body", provider: "claude-share" }],
    ["url arm missing provider", { kind: "url", url: "https://claude.ai/share/x", fetched: "body" }],
    ["url arm with unknown provider", { kind: "url", url: "https://claude.ai/share/x", fetched: "body", provider: "bogus" }],
    ["editor with a bogus source", { kind: "editor", source: "bogus" }],
    ["editor missing source field", { kind: "editor" }],
    ["editor with invalid input (bogus kind)", { kind: "editor", source: null, input: { kind: "bogus" } }],
    ["editor with invalid input (editor arm — not replayable)", { kind: "editor", source: null, input: { kind: "editor", source: null } }],
  ];
  for (const [label, v] of rejects) assert(`rejects: ${label}`, !isOrigin(v));
}

console.log("\nLegacy origin upgrade (upgradeOrigin — claude-share → url arm, url-ingestion-wfd.2):");
{
  // [LAW:one-source-of-truth] The governing architecture in action: records
  // written before the URL arm was generalized stored a fetched origin as
  // { kind:"claude-share", url, fetched }. upgradeOrigin lifts that legacy
  // discriminator into the current { kind:"url", …, provider } shape on read, so
  // the rename costs ZERO migration — stored bytes are untouched, the new shape
  // is DERIVED. isOrigin then accepts the upgraded value; sourceOf/sourceUrlOf
  // re-derive provenance unchanged, so a legacy paste renders identically.
  const legacyShare = { kind: "claude-share", url: "https://claude.ai/share/abc", fetched: "## You said:\nq" };
  const upgraded = upgradeOrigin(legacyShare);
  assert("legacy share upgrades to the url arm accepted by isOrigin", isOrigin(upgraded));
  assertEq("upgraded kind is url", (upgraded as { kind?: unknown }).kind, "url");
  assertEq("upgraded provider is claude-share", (upgraded as { provider?: unknown }).provider, "claude-share");
  assertEq("upgraded keeps the link", sourceUrlOf(upgraded as Origin), "https://claude.ai/share/abc");
  assertEq("upgraded keeps the styling provenance", sourceOf(upgraded as Origin), "claude-share");
  assertEq(
    "upgraded keeps the original fetched bytes verbatim",
    (upgraded as { fetched?: unknown }).fetched,
    "## You said:\nq",
  );

  // A legacy share nested as an EDITOR arm's `input` (an edited share import) is
  // upgraded in place; the editor's own `source` was already a valid SourceKind.
  const legacyEditedShare = {
    kind: "editor",
    source: "claude-share",
    input: { kind: "claude-share", url: "https://claude.ai/share/x", fetched: "orig" },
  };
  const upgradedEditor = upgradeOrigin(legacyEditedShare);
  assert("legacy edited-share editor upgrades to a valid Origin", isOrigin(upgradedEditor));
  assertEq(
    "nested input is upgraded to the url arm",
    ((upgradedEditor as { input?: { kind?: unknown } }).input ?? {}).kind,
    "url",
  );

  // [LAW:no-silent-failure] Idempotent + total: a current url origin and a text
  // origin pass through byte-identical (no double-upgrade, no field churn), and
  // junk passes through untouched for isOrigin to reject downstream.
  const currentUrl: Origin = { kind: "url", url: "https://claude.ai/share/y", fetched: "f", provider: "claude-share" };
  assertEq("current url origin is unchanged (idempotent)", JSON.stringify(upgradeOrigin(currentUrl)), JSON.stringify(currentUrl));
  const textOrigin: Origin = { kind: "markdown", content: "## User\nhi" };
  assertEq("text origin is unchanged", JSON.stringify(upgradeOrigin(textOrigin)), JSON.stringify(textOrigin));
  assert("junk passes through to be rejected by isOrigin", !isOrigin(upgradeOrigin({ kind: "nonsense" })));

  // [LAW:single-enforcer] The CLIENT draft loader (mount.loadDraft) now runs the
  // SAME upgradeOrigin the server applies on KV read. Prove the draft-migration
  // contract: a draft persisted before the URL arm was generalized — its origin the
  // legacy claude-share shape — hydrates as a replayable url origin, not null. The
  // first assert is the regression that existed before the fix (raw isOrigin rejects
  // the legacy shape, so the draft would silently drop its provenance).
  const legacyDraftOrigin = { kind: "claude-share", url: "https://claude.ai/share/draft", fetched: "## You said:\nq" };
  assert("regression guard: raw legacy draft origin is NOT a current Origin", !isOrigin(legacyDraftOrigin));
  // The exact resolution loadDraft performs: upgrade, then validate.
  const draftUpgraded = upgradeOrigin(legacyDraftOrigin);
  const draftOrigin = isOrigin(draftUpgraded) ? draftUpgraded : null;
  assert("loadDraft path preserves a legacy share draft's provenance (not null)", draftOrigin !== null);
  assertEq("restored draft origin is a replayable url origin", (draftOrigin as { kind?: unknown }).kind, "url");
  assertEq("restored draft origin keeps the claude-share provenance", sourceOf(draftOrigin as Origin), "claude-share");
}

console.log("\nOrigin → source derivation (sourceOf — shape table, provenance-kg4):");
{
  // [LAW:one-source-of-truth] sourceOf is the SINGLE derivation of styling
  // provenance from the canonical origin. Every Origin shape (plus the legacy
  // null) maps to exactly one SourceKind | null.
  const cases: ReadonlyArray<[string, Origin | null, SourceKind | null]> = [
    ["legacy null origin → null", null, null],
    ["editor authored from scratch → null", { kind: "editor", source: null }, null],
    ["editor carrying provenance → that kind", { kind: "editor", source: "chatgpt" }, "chatgpt"],
    ["text arm → its own kind", { kind: "markdown", content: "x" }, "markdown"],
    ["url arm → its provider (the host styling identity)", { kind: "url", url: "u", fetched: "f", provider: "claude-share" }, "claude-share"],
  ];
  for (const [label, origin, expected] of cases) assertEq(label, sourceOf(origin), expected);
}

console.log("\nOrigin → source URL derivation (sourceUrlOf — shape table, provenance-2my):");
{
  // [LAW:one-source-of-truth] sourceUrlOf is the SINGLE derivation of the
  // original-source link from the canonical origin. ONLY a url (fetched) origin
  // carries an upstream URL; every other shape (text arms carry content, editor
  // authoring + legacy carry no link) maps to null — honest absence the paste
  // page renders as nothing, never a placeholder.
  const cases: ReadonlyArray<[string, Origin | null, string | null]> = [
    ["legacy null origin → null", null, null],
    ["editor authored from scratch → null", { kind: "editor", source: null }, null],
    ["editor carrying share provenance → still null (no url retained)", { kind: "editor", source: "claude-share" }, null],
    ["text arm → null", { kind: "markdown", content: "x" }, null],
    ["url arm → its url", { kind: "url", url: "https://claude.ai/share/abc", fetched: "f", provider: "claude-share" }, "https://claude.ai/share/abc"],
  ];
  for (const [label, origin, expected] of cases) assertEq(label, sourceUrlOf(origin), expected);
}


console.log("\nReplay theorem (reprojectOrigin — purely re-derives turns, provenance-kg4):");
{
  // [LAW:one-source-of-truth] The proof that Turns are a derived cache: replaying
  // a captured origin through the parser reproduces the projection. parseInput
  // captures the origin; reprojectOrigin re-derives the turns from it; the two
  // are identical (round-trip), with no network even for the share arm.
  const captured = parseInput({ kind: "markdown", content: MARKDOWN_SAMPLE });
  assert("text paste captures an origin", captured.ok);
  if (captured.ok) {
    const replayed = reprojectOrigin(captured.origin);
    assertEq(
      "text origin round-trips to identical turns",
      JSON.stringify(replayed),
      JSON.stringify(captured.turns),
    );
  }

  // url-arm replay parses the STORED fetched bytes — never the network. A
  // hand-built url origin (the only arm whose capture needs a live fetch) is
  // re-projected from its bytes and matches a direct parse of those same bytes.
  const fetched = readFileSync("test/fixtures/claude-share.md", "utf8");
  const shareOrigin: Origin = {
    kind: "url",
    url: "https://claude.ai/share/61812fbb-da15-4992-8de8-1e6fbc7bbd82",
    fetched,
    provider: "claude-share",
  };
  const shareTurns = reprojectOrigin(shareOrigin);
  assertEq(
    "url origin re-projects from stored bytes (no network)",
    JSON.stringify(shareTurns),
    JSON.stringify(parseClaudeShare(fetched)),
  );

  // The editor arm has no upstream input to replay — its turns ARE the source,
  // so reprojectOrigin returns null (a signal "the stored turns are canonical",
  // not a failure). The next child (re-project in place) keys on exactly this.
  assert("editor origin re-projects to null (turns are the source)",
    reprojectOrigin({ kind: "editor", source: "claude-code" }) === null);
}

console.log("\nCanonicalize (shared by create + re-project-in-place, provenance-jdf):");
{
  // [LAW:single-enforcer] canonicalize is the one primitive POST /api/paste and
  // POST /api/reproject share, so the two cannot derive different turns from the
  // same origin. These assertions pin its three-way contract.

  // A replayable origin regenerates its turns from the captured source — the
  // turns argument is IGNORED, so a stale/mismatched cache cannot survive.
  const md = parseInput({ kind: "markdown", content: MARKDOWN_SAMPLE });
  assert("markdown captures an origin", md.ok);
  if (md.ok) {
    const stale = [{ kind: "message", role: "user", content: "STALE — must be discarded" } as const];
    const canon = canonicalize(stale, md.origin);
    assert("replayable origin canonicalizes ok", canon.ok);
    if (canon.ok) {
      assertEq(
        "replayable origin replaces given turns with replayed turns",
        JSON.stringify(canon.turns),
        JSON.stringify(md.turns),
      );
    }
  }

  // An editor origin keeps the given turns verbatim — there is no upstream input
  // to replay, so the turns ARE the source. Re-projection of such a paste is a
  // no-op by construction.
  const editorTurns = [{ kind: "message", role: "user", content: "authored in editor" } as const];
  const editorCanon = canonicalize(editorTurns, { kind: "editor", source: null });
  assert("editor origin canonicalizes ok", editorCanon.ok);
  if (editorCanon.ok) {
    assertEq(
      "editor origin keeps the given turns verbatim",
      JSON.stringify(editorCanon.turns),
      JSON.stringify(editorTurns),
    );
  }

  // [LAW:no-silent-failure] A replayable origin whose captured source reproduces
  // nothing is corruption, rejected loudly — never a silent fallback to the
  // given turns under an origin label that would then lie about replay.
  const corrupt = canonicalize(editorTurns, { kind: "markdown", content: "" });
  assert("replayable origin that reproduces nothing is rejected", !corrupt.ok);
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
  // a thinking block (now KEPT as a thinking Turn), and a system-reminder
  // envelope (must be stripped from the user message body).
  const JSONL_SAMPLE = [
    { type: "user", message: { role: "user", content: "what's in the repo?" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning, now surfaced" },
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
    // Thinking block is now KEPT as a thinking Turn, ahead of the assistant text.
    assertEq(
      "kinds sequence",
      kinds(r.turns),
      ["message", "thinking", "message", "tool-call", "message", "message"],
    );
    const t0 = r.turns[0]!;
    assert("turn[0] is user 'what's in the repo?'",
      t0.kind === "message" && t0.role === "user" && t0.content === "what's in the repo?");
    const tk = r.turns[1]!;
    assert("turn[1] is the thinking block with its text",
      tk.kind === "thinking" && tk.content === "internal reasoning, now surfaced");
    const t1 = r.turns[2]!;
    assert("turn[2] is assistant 'Let me look around.'",
      t1.kind === "message" && t1.role === "assistant" && t1.content === "Let me look around.");
    const t2 = r.turns[3]!;
    assert("turn[3] is Bash tool-call",
      t2.kind === "tool-call" && t2.tool === "Bash");
    assert("turn[3] args contain the command (JSON-serialized)",
      t2.kind === "tool-call" && t2.args.includes('"command": "ls"'));
    assert("turn[3] output paired from tool_result",
      t2.kind === "tool-call" && t2.output?.text === "src\nREADME.md");
    assert("turn[3] output kind classified as terminal (Bash)",
      t2.kind === "tool-call" && t2.output?.kind === "terminal");
    const t4 = r.turns[5]!;
    assert("turn[5] is user 'thanks!' (system-reminder envelope stripped)",
      t4.kind === "message" && t4.role === "user" && t4.content === "thanks!");

    // A thinking block whose text is blank/whitespace emits no Turn (no empty
    // toggle) — the "when available" guarantee at the parser boundary.
    const EMPTY_THINK = [
      { type: "assistant", message: { role: "assistant", content: [
        { type: "thinking", thinking: "   \n  " },
        { type: "text", text: "answer" },
      ] } },
    ].map((e) => JSON.stringify(e)).join("\n");
    const rEmpty = parseInput({ kind: "claude-jsonl", content: EMPTY_THINK });
    assert("blank thinking emits no turn", rEmpty.ok);
    if (rEmpty.ok) {
      assertEq("blank thinking → only the text message", kinds(rEmpty.turns), ["message"]);
    }
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

console.log("\nclaude-jsonl token usage (display-tba):");
{
  // The accuracy trap: ONE logical assistant message (one message.id) is split
  // across several JSONL lines that each REPEAT the same usage total. Counting
  // per line would multiply the real cost. msgA is split across 3 lines (each
  // usage output=100); msgB is a tool-only message (no text) with output=50.
  const usageA = {
    input: 10, output_tokens: 100,
    cache_creation_input_tokens: 5, cache_read_input_tokens: 20,
  };
  const withUsage = (extra: Record<string, number>) => ({
    input_tokens: extra.input ?? 0,
    output_tokens: extra.output_tokens,
    cache_creation_input_tokens: extra.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: extra.cache_read_input_tokens ?? 0,
  });
  const SAMPLE = [
    { type: "assistant", message: { id: "msgA", role: "assistant", usage: withUsage(usageA),
      content: [{ type: "thinking", thinking: "reasoning" }] } },
    { type: "assistant", message: { id: "msgA", role: "assistant", usage: withUsage(usageA),
      content: [{ type: "text", text: "Looking." }] } },
    { type: "assistant", message: { id: "msgA", role: "assistant", usage: withUsage(usageA),
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] } },
    { type: "assistant", message: { id: "msgB", role: "assistant",
      usage: { input_tokens: 2, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "x" } }] } },
  ].map((e) => JSON.stringify(e)).join("\n");

  const r = parseInput({ kind: "claude-jsonl", content: SAMPLE });
  assert("usage sample parses", r.ok);
  if (r.ok) {
    // Each logical message contributes exactly one usage turn, after its content.
    assertEq(
      "usage turns positioned after each message's content",
      kinds(r.turns),
      ["thinking", "message", "tool-call", "usage", "tool-call", "usage"],
    );
    const u1 = r.turns[3]!;
    const u2 = r.turns[5]!;
    // DEDUP: msgA's 3 repeated lines (output=100 each) count ONCE as 100 — not 300.
    assert("msgA usage counted once (not multiplied by its 3 lines)",
      u1.kind === "usage" && u1.usage.output === 100);
    assert("msgA full breakdown carried accurately",
      u1.kind === "usage" && u1.usage.input === 10 && u1.usage.cacheCreation === 5 && u1.usage.cacheRead === 20);
    // Tool-only message's tokens are NOT lost (no text turn to hang them on).
    assert("tool-only msgB usage still counted (output=50)",
      u2.kind === "usage" && u2.usage.output === 50);

    // Running total folds across usage turns: 100, then 100+50=150.
    const html = renderDialogueHtml(deriveDialogue(r.turns));
    assert("per-message output rendered", html.includes("100 tokens") && html.includes("50 tokens"));
    assert("running total rendered (100 then 150)",
      html.includes("100 total") && html.includes("150 total"));
    // Usage is a nested annotation, not a spine node → carries no data-index, so the
    // minimap (which selects [data-index]) skips it.
    assert("usage chip carries no data-index",
      !/data-kind="usage"[^>]*data-index/.test(html));
  }

  // A usage object without output_tokens is not a usage record — no turn, no
  // fabricated zero. [LAW:no-silent-failure]
  const NO_OUTPUT = [
    { type: "assistant", message: { id: "m", role: "assistant", usage: { input_tokens: 5 },
      content: [{ type: "text", text: "hi" }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const rno = parseInput({ kind: "claude-jsonl", content: NO_OUTPUT });
  assert("usage without output_tokens emits no usage turn", rno.ok);
  if (rno.ok) assert("only the text message, no usage", !kinds(rno.turns).includes("usage"));

  // Real-data regression: a multi-tool message's lines are INTERRUPTED by the
  // tool_result (a user event) between its two tool calls, then the SAME id
  // resumes. Consecutive-only dedup would count it twice; global dedup counts
  // it once. [LAW:no-silent-failure]
  const u = (out: number) => ({
    input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  });
  const INTERRUPTED = [
    { type: "assistant", message: { id: "mS", role: "assistant", usage: u(80),
      content: [{ type: "tool_use", id: "a", name: "Bash", input: {} }] } },
    { type: "user", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] } },
    { type: "assistant", message: { id: "mS", role: "assistant", usage: u(80),
      content: [{ type: "tool_use", id: "b", name: "Read", input: {} }] } },
    { type: "user", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "b", content: "ok" }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const ri = parseInput({ kind: "claude-jsonl", content: INTERRUPTED });
  assert("interrupted message parses", ri.ok);
  if (ri.ok) {
    const us = ri.turns.filter((t) => t.kind === "usage");
    assert("interrupted-then-resumed id counted ONCE (not twice)", us.length === 1);
    assert("interrupted id keeps its real output (80, not 160)",
      us[0]!.kind === "usage" && us[0]!.usage.output === 80);
  }

  // Real-data regression: a streamed message repeats its id across lines with a
  // GROWING output (an early partial flush, then the settled count). The
  // authoritative value is the complete one (max output), not the partial.
  const STREAMED = [
    { type: "assistant", message: { id: "mT", role: "assistant", usage: u(3),
      content: [{ type: "thinking", thinking: "..." }] } },
    { type: "assistant", message: { id: "mT", role: "assistant", usage: u(500),
      content: [{ type: "text", text: "done" }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const rs = parseInput({ kind: "claude-jsonl", content: STREAMED });
  assert("streamed message parses", rs.ok);
  if (rs.ok) {
    const us = rs.turns.filter((t) => t.kind === "usage");
    assert("streamed id counted once", us.length === 1);
    assert("streamed id uses the complete count (500, not the partial 3)",
      us[0]!.kind === "usage" && us[0]!.usage.output === 500);
  }
}

console.log("\ndetectSources (T2 — UI-gating detector):");
{
  // For text arms: the detector IS the parser. expected() mirrors the text-
  // arm half of the detector; if the parser changes its mind, the detector
  // follows it. The url arm is recognized by isUrl (not a parser) so it's
  // excluded here and verified separately in the URL-detection block below.
  const expected = (text: string): ReadonlyArray<InputKind> =>
    TEXT_ARM_KINDS.filter((k) => parseInput(textArmInput(k, text)).ok);

  // Priming (empty) offers every input kind — the generic url arm plus the text
  // arms — for pre-selection before anything is pasted.
  assertEq("empty → all input kinds (priming)", detectSources(""), INPUT_KINDS);
  assertEq("whitespace-only → all input kinds (priming)", detectSources("   \n  \t  "), INPUT_KINDS);

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

console.log("\nGeneric URL detection (isUrl — url-ingestion-wfd.4):");
{
  // isUrl recognizes ANY http(s) link, NOT a specific provider — which parser
  // applies (or the fallback) is resolved AFTER fetch via resolveProvider.
  // Positive cases: known and unknown hosts alike are fetchable links.
  assert("https claude share accepted",
    isUrl("https://claude.ai/share/61812fbb-da15-4992-8de8-1e6fbc7bbd82"));
  assert("http accepted", isUrl("http://claude.ai/share/abc123"));
  assert("an unknown host is still a URL", isUrl("https://example.com/some/post"));
  assert("a chatgpt share link is a URL", isUrl("https://chatgpt.com/share/abc123"));
  assert("surrounding whitespace tolerated", isUrl("  https://example.com/x  \n"));
  assert("uppercase scheme accepted", isUrl("HTTPS://example.com/x"));
  assert("query string tolerated", isUrl("https://example.com/x?utm=y"));

  // Negative cases: not a fetchable http(s) link.
  assert("plain text rejected", !isUrl("hello world"));
  assert("non-http scheme rejected", !isUrl("ftp://example.com/x"));
  assert("bare word rejected", !isUrl("claude.ai"));
  assert("multiline rejected", !isUrl("https://example.com/x\nmore text"));
  // [LAW:one-source-of-truth] The WHATWG URL parser silently strips tab/CR/LF, so a
  // string carrying any of them internally would be FETCHED as a different URL than
  // its literal text — reject the whole strip-set, not just \n.
  assert("CR-only multiline rejected (parser would strip the CR)", !isUrl("https://example.com/x\rmore"));
  assert("internal tab rejected (parser would strip it)", !isUrl("https://example.com/x\tmore"));
  assert("surrounding CR/tab is trimmed — still a URL", isUrl("\r\thttps://example.com/x\r"));
  assert("empty rejected", !isUrl(""));
  assert("whitespace-only rejected", !isUrl("   \n\t "));

  // [LAW:no-silent-failure] The detector collapses ANY link to the single
  // generic "url" fetch arm — never the text-parser race, which would render a
  // lone link as a raw bubble of the link text (the outcome the user forbade).
  // This holds for an UNKNOWN host as much as for claude-share: provider
  // resolution is server-side, so detection does not distinguish them.
  assertEq("claude.ai/share URL → ['url']",
    detectSources("https://claude.ai/share/61812fbb-da15-4992-8de8-1e6fbc7bbd82"), ["url"]);
  assertEq("unknown-host URL → ['url'] (still fetched, not a raw bubble)",
    detectSources("https://example.com/some/blog-post"), ["url"]);
  assertEq("chatgpt URL → ['url']",
    detectSources("https://chatgpt.com/share/abc123"), ["url"]);

  const url = "https://claude.ai/share/61812fbb-da15-4992-8de8-1e6fbc7bbd82";
  // parseInput must reject the url arm with a useful redirect message —
  // it has no synchronous interpretation.
  const blocked = parseInput({ kind: "url", url });
  assert("parseInput rejects the url arm", !blocked.ok);
  if (!blocked.ok) {
    assert("parseInput error names the async path", blocked.reason.includes("ingestPaste"));
  }

  // parseClaudeShare against the real captured fixture. Its assistant body
  // opens with a doubled "Searched the web" indicator pair, now promoted to a
  // single tool-call Turn between the user and assistant messages.
  const fixture = readFileSync("test/fixtures/claude-share.md", "utf8");
  const turns = parseClaudeShare(fixture);
  assert("fixture parses to non-null", turns !== null);
  if (turns) {
    assertEq("fixture kinds", kinds(turns), ["message", "tool-call", "message"]);
    const t0 = turns[0]!;
    const tc = turns[1]!;
    const t1 = turns[2]!;
    assert("turn[0] is a user message",
      t0.kind === "message" && t0.role === "user");
    assert("doubled indicator pair → ONE tool-call",
      tc.kind === "tool-call" && tc.tool === "Searched the web" &&
      tc.args === "" && tc.output === null);
    assert("turn[2] is an assistant message",
      t1.kind === "message" && t1.role === "assistant");
    assert("user message body contains original question",
      t0.kind === "message" && t0.content.includes("comrehensible to me without dumbing"));
    assert("assistant message contains the substantive answer",
      t1.kind === "message" && t1.content.includes("IsoAcoustics"));
    assert("indicator text sliced out of the assistant body",
      t1.kind === "message" && !t1.content.includes("Searched the web"));
    assert("boilerplate stripped from user body",
      t0.kind === "message" && !t0.content.includes("This is a copy of a chat"));
    assert("date stamp stripped from user body",
      t0.kind === "message" && !/\bMay\s+18\b/.test(t0.content));
    assert("footer stripped from assistant body",
      t1.kind === "message" && !t1.content.includes("Ask Claude your own question"));
  }

  // [LAW:single-enforcer] PUA strip — fixture built from the real paste
  // CsDbeRFrMX, where every turn's content tail is the claude.ai icon-font run
  // U+E056 U+E03B. The parser must drop all Private Use Area glyphs while every
  // non-PUA character (including the substantive prose) survives.
  const puaFixture = readFileSync("test/fixtures/claude-share-pua.md", "utf8");
  assert(
    "fixture actually contains the PUA artifact (guard against a clean fixture)",
    /[\u{E000}-\u{F8FF}]/u.test(puaFixture),
  );
  const puaTurns = parseClaudeShare(puaFixture);
  assert("PUA fixture parses to two turns", puaTurns !== null && puaTurns.length === 2);
  if (puaTurns) {
    const allText = puaTurns
      .map((t) => (t.kind === "message" ? t.content : ""))
      .join("\n");
    assert(
      "no PUA glyph survives in any parsed turn",
      !/[\u{E000}-\u{F8FF}]/u.test(allText),
    );
    assert(
      "legitimate prose preserved verbatim",
      puaTurns[0]!.kind === "message" &&
        puaTurns[0]!.content.includes("near-field monitors") &&
        puaTurns[1]!.kind === "message" &&
        puaTurns[1]!.content.includes("IsoAcoustics stands decouple"),
    );
    // Lone-backslash hard-break residue (the action-row `\` left after the PUA
    // glyphs are stripped) must not survive — no parsed turn ends in a stray
    // backslash, and no turn carries a whitespace-only `\` line.
    assert(
      "no trailing lone-backslash residue survives",
      !puaTurns.some(
        (t) => t.kind === "message" && /(?:^|\n)\s*\\\s*$/.test(t.content),
      ),
    );
    // The fenced code block survives verbatim: a `\` line continuation and a
    // lone `\` line *inside* the fence are conversation content, not residue.
    assert(
      "backslashes inside a code fence survive verbatim",
      puaTurns[1]!.kind === "message" &&
        puaTurns[1]!.content.includes("echo one \\\n  two") &&
        /```bash\n[^]*\n\\\n```/.test(puaTurns[1]!.content),
    );
  }

  // [LAW:single-enforcer] Backslash-escaped punctuation is marked's job, not a
  // second strip in render.ts — locking it here proves the renderer already
  // unescapes `\_ \* \[ \. \(` to the bare character while leaving backslashes
  // inside code spans and fences untouched (the other half of 5uo's acceptance).
  const escHtml = renderMarkdown(
    "esc \\_a\\_ \\* \\[ \\. \\( then `code \\_ x` and\n\n```\nfence \\_ y\n```",
  );
  assert(
    "escaped punctuation renders as the bare character",
    escHtml.includes("esc _a_ * [ . ("),
  );
  assert(
    "backslash inside a code span survives",
    escHtml.includes("code \\_ x"),
  );
  assert(
    "backslash inside a fence survives",
    escHtml.includes("fence \\_ y"),
  );

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

console.log("\nclaude-share tool indicators (claude-share-4pf):");
{
  // Fixtures are real share pages captured via the production Firecrawl call
  // (v1 /scrape, formats:[markdown]) — each one characterizes a distinct
  // indicator shape observed in the wild.
  const load = (name: string): Turn[] => {
    const t = parseClaudeShare(readFileSync(`test/fixtures/${name}.md`, "utf8"));
    if (t === null) throw new Error(`${name} parsed to null`);
    return t;
  };
  const toolsOf = (turns: ReadonlyArray<Turn>): string[] =>
    turns.flatMap((t) => (t.kind === "tool-call" ? [t.tool] : []));
  const bodiesOf = (turns: ReadonlyArray<Turn>): string =>
    turns.map((t) => (t.kind === "message" ? t.content : "")).join("\n");

  // Web search: the canonical doubled indicator, alone at the turn start.
  const ws = load("claude-share-tools-websearch");
  assertEq("websearch kinds", kinds(ws), ["message", "tool-call", "message"]);
  assertEq("websearch tool", toolsOf(ws), ["Searched the web"]);
  assert("websearch body keeps the prose, drops the indicator",
    bodiesOf(ws).includes("Car Presentation Submissions") &&
    !bodiesOf(ws).includes("Searched the web"));

  // Interleaved: prose → indicator → prose inside ONE assistant turn must
  // come out as an ordered message/tool-call/message stream, and the
  // attachment placeholder inside the user body is chrome.
  const il = load("claude-share-tools-interleaved");
  assertEq("interleaved opening sequence",
    kinds(il).slice(0, 5),
    ["message", "tool-call", "message", "tool-call", "message"]);
  assert("interleaved count summaries promoted",
    toolsOf(il).includes("Viewed 9 files, ran 2 commands") &&
    toolsOf(il).includes("Ran 3 commands, read a file"));
  assert("hidden-files placeholder stripped from user body",
    !bodiesOf(il).includes("Files hidden in shared chats"));

  // Artifact cards: type line + preceding title → tool + args; the analysis
  // tool's label + "View analysis" button collapses to one tool-call.
  const af = load("claude-share-tools-artifact");
  const afTools = af.filter((t) => t.kind === "tool-call");
  assert("artifact card carries title in args",
    afTools.some((t) => t.kind === "tool-call" &&
      t.tool === "Interactive artifact" &&
      t.args === "Mortgage Calculator: Prepayment vs Investment"));
  assert("artifact version line preserved in tool name",
    afTools.some((t) => t.kind === "tool-call" &&
      t.tool === "Interactive artifact ∙ Version 20"));
  assert("Analyzed data + View analysis pair → one tool-call",
    afTools.some((t) => t.kind === "tool-call" && t.tool === "Analyzed data"));
  assert("View analysis button text not left in any body",
    !bodiesOf(af).includes("View analysis"));
  assert("prose before an artifact card survives the title pop",
    bodiesOf(af).includes("Let me create that for you:"));

  // Free-form labels: MCP tool names and status text are an OPEN set — the
  // structural fingerprint must promote strings never seen before.
  const mcp = load("claude-share-tools-mcp");
  assert("MCP tool labels promoted",
    toolsOf(mcp).includes("Search-designs") &&
    toolsOf(mcp).includes("Loaded tools, used a tool") &&
    toolsOf(mcp).includes("Used 2 tools"));
  assert("Show more truncation button stripped",
    !bodiesOf(mcp).includes("Show more"));

  // Localized card titles double like indicators and must promote whole.
  const ct = load("claude-share-tools-card-titles");
  assert("localized card title promoted",
    toolsOf(ct).includes("GitHub Actions workflow für Label-Bot und Issue-zu-PR Pipeline"));
  assert("prose section headings stay prose",
    bodiesOf(ct).includes("GitHub Actions Workflows"));

  // Fence safety: repeated ASCII-diagram lines inside code fences must NOT
  // be promoted — this fixture has doubles only inside fences.
  const fa = load("claude-share-fenced-art");
  assertEq("fenced diagrams produce zero tool-calls", toolsOf(fa), []);
  assert("diagram glyphs survive verbatim", bodiesOf(fa).includes("▼"));

  // No tools at all: bodies must come through untouched, zero tool-calls.
  const nt = load("claude-share-no-tools");
  assertEq("clean share produces zero tool-calls", toolsOf(nt), []);

  // A share can BEGIN with an assistant turn (user upload hidden): the first
  // event is the tool-call its body opens with.
  const hf = load("claude-share-hidden-files");
  assert("leading-assistant share opens with its tool-call",
    hf[0]!.kind === "tool-call" && hf[0]!.tool === "Viewed 3 files");
  assert("hidden-files placeholder stripped (leading-assistant share)",
    !bodiesOf(hf).includes("Files hidden in shared chats"));

  // Synthetic negatives — the reject half of the fingerprint.
  // User bodies are never scanned: a doubled line a user pasted stays prose.
  const userDouble = parseClaudeShare(
    "## You said: hi\n\nfoo\n\nfoo\n\n## Claude responded: ok\n\nok body\n",
  );
  assert("doubled line in USER body stays prose",
    userDouble !== null && kinds(userDouble).every((k) => k === "message"));

  // Repeated prose with sentence punctuation is not an indicator.
  const punct = parseClaudeShare(
    "## You said: q\n\nq\n\n## Claude responded: a\n\nSame line.\n\nSame line.\n",
  );
  assert("doubled sentence-punctuated prose stays prose",
    punct !== null && kinds(punct).every((k) => k === "message"));

  // Repeated markdown-structural lines (lists, bold) are not indicators.
  const structural = parseClaudeShare(
    "## You said: q\n\nq\n\n## Claude responded: a\n\n- item\n\n- item\n\n**Bold**\n\n**Bold**\n",
  );
  assert("doubled structural lines stay prose",
    structural !== null && kinds(structural).every((k) => k === "message"));

  // An indicator-shaped line appearing ONCE is prose, not a tool-call.
  const single = parseClaudeShare(
    "## You said: q\n\nq\n\n## Claude responded: a\n\nRan a command\n\nthen explained it.\n",
  );
  assert("undoubled indicator-shaped line stays prose",
    single !== null && kinds(single).every((k) => k === "message"));
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

console.log("\nMarkdown fence language attribute escaping (XSS):");
{
  // A code-fence info string is user-controlled and lands in a class="" value;
  // escapeHtml alone leaves quotes intact, so a fence like ```js" onx=" would
  // break out of the attribute. The class attribute must quote-escape it. This is
  // a property of renderMarkdown (shared by every renderer), independent of which
  // renderer wraps it. The disclosure renderer's own markup, kinds, output frames
  // and escaping are pinned by the "Disclosure renderer" section below.
  const fenceXss = renderMarkdown('```js" onmouseover="alert(1)\nx\n```');
  assert("fence language attribute escaped (no quote breakout)", !fenceXss.includes('" onmouseover="alert(1)"'));
  assert("fence language attribute escaped form present", fenceXss.includes("language-js&quot; onmouseover=&quot;alert(1)"));
}

console.log("\nBlock model (b48.2 — pure editor blocks):");
{
  // One fixture exercising every authorable kind, including a tool-call with
  // output. Typed AuthorableTurn[] — the editor only ever holds these (usage and
  // subagent are filtered out before reaching a Block), so this is what toBlocks
  // accepts. [LAW:types-are-the-program]
  const fixture: AuthorableTurn[] = [
    { kind: "message", role: "user", content: "hello" },
    { kind: "message", role: "assistant", content: "hi there" },
    { kind: "insight", content: "a key realization" },
    { kind: "turn-summary", text: "Sautéed for 53s" },
    {
      kind: "tool-call",
      tool: "Bash",
      args: "ls -la",
      output: { kind: "terminal", text: "total 0", isError: false },
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
  const allKinds: Kind[] = ["message", "insight", "thinking", "turn-summary", "tool-call"];
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
  // thinking shares insight's single content field — conversion is lossless both ways.
  const think = convertKind({ kind: "insight", content: "carry me" }, "thinking");
  assert(
    "insight -> thinking preserves text",
    think.kind === "thinking" && think.content === "carry me",
  );
  const backToMsg = convertKind({ kind: "thinking", content: "carry me" }, "message");
  assert(
    "thinking -> message preserves text",
    backToMsg.kind === "message" && backToMsg.content === "carry me",
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
    { kind: "tool-call", tool: "Bash", args: "ls -la", output: { kind: "terminal", text: "total 0", isError: false } },
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

  // splitTurn — a pure cut of the primary text; both halves keep kind + non-text
  // fields, and the halves reconstruct the original exactly (nothing inserted).
  const [sh, st] = splitTurn({ kind: "message", role: "user", content: "hello world" }, 5);
  assert(
    "splitTurn divides text, both halves keep role",
    sh.kind === "message" && st.kind === "message" &&
      sh.role === "user" && st.role === "user" &&
      sh.content === "hello" && st.content === " world",
  );
  assert(
    "splitTurn is a pure cut (head + tail === original)",
    sh.kind === "message" && st.kind === "message" && sh.content + st.content === "hello world",
  );
  // Edge offsets clamp; one empty half (a legal block) rather than an out-of-range slice.
  const [eh, et2] = splitTurn({ kind: "insight", content: "abc" }, 99);
  assert(
    "splitTurn clamps past end -> full head, empty tail",
    eh.kind === "insight" && et2.kind === "insight" && eh.content === "abc" && et2.content === "",
  );
  const [nh] = splitTurn({ kind: "turn-summary", text: "abc" }, -5);
  assert("splitTurn clamps negative -> empty head", nh.kind === "turn-summary" && nh.text === "");
  // tool-call splits its primary field (args), preserving tool name + output.
  const [th, tt] = splitTurn(
    { kind: "tool-call", tool: "Bash", args: "ls -la", output: { kind: "terminal", text: "out", isError: false } },
    2,
  );
  assert(
    "splitTurn(tool-call) cuts args, keeps tool + output on both",
    th.kind === "tool-call" && tt.kind === "tool-call" &&
      th.tool === "Bash" && tt.tool === "Bash" &&
      th.args === "ls" && tt.args === " -la" &&
      th.output?.text === "out" && tt.output?.text === "out",
  );

  // mergeTurns — keeps prev's shape, joins texts with a blank line, drops next's
  // non-text fields (one merged block keeps exactly one shape).
  const merged = mergeTurns(
    { kind: "message", role: "user", content: "first" },
    { kind: "message", role: "assistant", content: "second" },
  );
  assert(
    "mergeTurns keeps prev role, joins with blank line, drops next role",
    merged.kind === "message" && merged.role === "user" && merged.content === "first\n\nsecond",
  );
  // Merge across kinds: prev's kind wins; next contributes only its primary text.
  const mixedMerge = mergeTurns(
    { kind: "insight", content: "note" },
    { kind: "turn-summary", text: "summary" },
  );
  assert(
    "mergeTurns keeps prev kind, appends next primary text",
    mixedMerge.kind === "insight" && mixedMerge.content === "note\n\nsummary",
  );
}

console.log("\nEditorStore (b48.5 importKind derivation + b48.6 confirm-on-reparse):");
{
  // A fake IO — the store's only contact with the world, injected. Records what
  // crossed the boundary so a test can assert on submit/fetch without a network.
  const fakeIo = (): {
    io: EditorIo;
    submitted: Draft[];
    navigated: string[];
    draftCell: () => string | null;
  } => {
    const submitted: Draft[] = [];
    const navigated: string[] = [];
    // Mirror localStorage's single string cell: saveDraft writes JSON, loadDraft
    // reads + validates (so the test exercises the same gate mount ships),
    // clearDraft removes it. draftCell() lets a test assert what was persisted.
    let cell: string | null = null;
    const io: EditorIo = {
      fetchShare: async (): Promise<ParseResult> => ({ ok: false, reason: "unused" }),
      fetchDraft: async (): Promise<DraftLoadResult> => ({ ok: false, reason: "unused" }),
      submit: async (draft): Promise<SubmitResult> => {
        submitted.push(draft);
        return { ok: true, slug: "test-slug" };
      },
      navigate: (slug) => navigated.push(slug),
      saveDraft: (draft) => {
        cell = JSON.stringify(draft);
      },
      loadDraft: (): Draft => {
        if (cell === null) return { turns: [], origin: null };
        const o = JSON.parse(cell) as { turns?: unknown; origin?: unknown } | null;
        return o && isTurns(o.turns)
          ? { turns: o.turns, origin: isOrigin(o.origin) ? o.origin : null }
          : { turns: [], origin: null };
      },
      clearDraft: () => {
        cell = null;
      },
      deleteDraft: () => {},
    };
    return { io, submitted, navigated, draftCell: () => cell };
  };

  // --- importKind derivation (b48.5 fix: 'raw' is no longer sticky) ---
  const s1 = new EditorStore(fakeIo().io);
  s1.setImport("## User\nhi\n\n## Assistant\nyo");
  assertEq("importKind snaps to most-specific detection (markdown)", s1.importKind, "markdown");
  // A user override is honored only while it stays a detected kind.
  s1.setImportKind("raw");
  assertEq("explicit override honored when detected", s1.importKind, "raw");
  s1.setImport("just some unstructured text with no markers");
  // markdown no longer detected -> override 'raw' still valid here (raw always
  // detected), so it remains; prove the getter, not a stored snapshot.
  assert("override dropped by getter when undetected", s1.detected.includes(s1.importKind));

  // --- confirm-on-reparse: first parse never warns (nothing to clobber) ---
  const f2 = fakeIo();
  const s2 = new EditorStore(f2.io);
  s2.setImport("## User\nhello\n\n## Assistant\nworld");
  s2.ingest();
  assert("first parse loads blocks immediately", s2.blocks.length === 2);
  assert("freshly-loaded blocks are not dirty", !s2.isDirty);
  assert("no pending reparse after clean load", s2.pendingReparse === null);

  // --- hand-edit makes the store dirty; a reparse stages instead of clobbering ---
  const firstId = s2.blocks[0]!.id;
  s2.replaceTurn(firstId, { kind: "message", role: "user", content: "EDITED" });
  assert("editing a block marks dirty", s2.isDirty && s2.wouldClobber);
  const editedSnapshot = JSON.stringify(s2.turns);
  s2.setImport("## User\nbrand\n\n## Assistant\nnew");
  s2.ingest();
  assert("reparse over edits stages, does not replace", s2.pendingReparse !== null);
  assertEq("blocks untouched while reparse pending", JSON.stringify(s2.turns), editedSnapshot);

  // --- cancel keeps edits; confirm commits the staged parse ---
  s2.cancelReparse();
  assert("cancel clears the pending reparse", s2.pendingReparse === null);
  assertEq("cancel preserves the edited blocks", JSON.stringify(s2.turns), editedSnapshot);

  s2.setImport("## User\nbrand\n\n## Assistant\nnew");
  s2.ingest();
  assert("reparse stages again", s2.pendingReparse !== null);
  s2.confirmReparse();
  assert("confirm replaces blocks with the staged parse", s2.blocks.length === 2);
  assert("confirmed reparse resets dirty baseline", !s2.isDirty);
  assert("confirm clears pending", s2.pendingReparse === null);
  const confirmedFirst = s2.turns[0]!;
  assert(
    "confirmed blocks carry the new content",
    confirmedFirst.kind === "message" && confirmedFirst.content === "brand",
  );

  // --- submit moves the Draft (turns + stamped origin) across the boundary ---
  // A pristine confirmed reparse stamps the verbatim text origin (markdown here),
  // preserving the source of truth rather than collapsing to an editor origin.
  await s2.submit();
  const s2Origin = f2.submitted[0]?.origin;
  assert(
    "submit stamps the verbatim text origin for a pristine text import",
    s2Origin?.kind === "markdown" && s2Origin.content === "## User\nbrand\n\n## Assistant\nnew",
  );
  assertEq("submit navigates on success", f2.navigated[0], "test-slug");

  // --- editing the import box invalidates a staged reparse ---
  const s3 = new EditorStore(fakeIo().io);
  s3.setImport("## User\na\n\n## Assistant\nb");
  s3.ingest();
  s3.replaceTurn(s3.blocks[0]!.id, { kind: "insight", content: "changed kind" });
  s3.setImport("## User\nc\n\n## Assistant\nd");
  s3.ingest();
  assert("staged before re-edit", s3.pendingReparse !== null);
  s3.setImport("## User\ne\n\n## Assistant\nf");
  assert("editing import text drops the stale pending reparse", s3.pendingReparse === null);
}

console.log("\nEditorStore split/merge (b48.7 — block by text-range):");
{
  const io: EditorIo = {
    fetchShare: async (): Promise<ParseResult> => ({ ok: false, reason: "unused" }),
    fetchDraft: async (): Promise<DraftLoadResult> => ({ ok: false, reason: "unused" }),
    submit: async (): Promise<SubmitResult> => ({ ok: true, slug: "x" }),
    navigate: () => {},
    saveDraft: () => {},
    loadDraft: (): Draft => ({ turns: [], origin: null }),
    clearDraft: () => {},
    deleteDraft: () => {},
  };

  // --- splitBlock: one card becomes two in place; head keeps id, tail is fresh ---
  const s = new EditorStore(io);
  s.setImport("## User\nhello world\n\n## Assistant\nreply");
  s.ingest();
  assert("two blocks loaded", s.blocks.length === 2);
  const headId = s.blocks[0]!.id;
  const tailIdBefore = s.blocks[1]!.id;
  s.splitBlock(headId, 5);
  assert("splitBlock grows the list by one", s.blocks.length === 3);
  assert("head keeps the original id (DOM/caret stability)", s.blocks[0]!.id === headId);
  assert("tail gets a fresh id distinct from head", s.blocks[1]!.id !== headId);
  assert("the untouched following block is unmoved", s.blocks[2]!.id === tailIdBefore);
  const h = s.blocks[0]!.turn;
  const t = s.blocks[1]!.turn;
  assert(
    "split content divides at the offset, role preserved",
    h.kind === "message" && t.kind === "message" &&
      h.content === "hello" && t.content === " world" && h.role === "user" && t.role === "user",
  );
  assert("split marks the store dirty (derives from blocks)", s.isDirty);

  // A stale split id (concurrent delete) is a total no-op, not a throw.
  const lenBefore = s.blocks.length;
  s.splitBlock("does-not-exist", 0);
  assert("splitBlock on a missing id is a no-op", s.blocks.length === lenBefore);

  // --- mergeBlocks: a card folds into the one above; prev id + shape survive ---
  const m = new EditorStore(io);
  m.setImport("## User\nfirst\n\n## Assistant\nsecond");
  m.ingest();
  const prevId = m.blocks[0]!.id;
  const curId = m.blocks[1]!.id;
  m.mergeBlocks(curId);
  assert("mergeBlocks shrinks the list by one", m.blocks.length === 1);
  assert("merged block keeps the previous block's id", m.blocks[0]!.id === prevId);
  const mt = m.blocks[0]!.turn;
  assert(
    "merged text joins prev + cur with a blank line, prev role wins",
    mt.kind === "message" && mt.role === "user" && mt.content === "first\n\nsecond",
  );
  assert("the consumed block's id is gone", !m.blocks.some((b) => b.id === curId));

  // Merging the first block has nothing above it — a total no-op.
  const firstOnly = m.blocks[0]!.id;
  m.mergeBlocks(firstOnly);
  assert("mergeBlocks on the first block is a no-op", m.blocks.length === 1);
}

console.log("\nEditorStore draft persistence (b48.9 — localStorage round-trip):");
{
  // A fake IO modelling localStorage's string cell. The test wires persistDrafts
  // — the SAME reaction mount ships — so it exercises the real persistence path,
  // not a hand-rolled copy [LAW:behavior-not-structure].
  const draftIo = (): { io: EditorIo; cell: () => string | null } => {
    let cell: string | null = null;
    const io: EditorIo = {
      fetchShare: async (): Promise<ParseResult> => ({ ok: false, reason: "unused" }),
      fetchDraft: async (): Promise<DraftLoadResult> => ({ ok: false, reason: "unused" }),
      submit: async (): Promise<SubmitResult> => ({ ok: true, slug: "saved-slug" }),
      navigate: () => {},
      saveDraft: (draft) => {
        cell = JSON.stringify(draft);
      },
      loadDraft: (): Draft => {
        if (cell === null) return { turns: [], origin: null };
        const o = JSON.parse(cell) as { turns?: unknown; origin?: unknown } | null;
        return o && isTurns(o.turns)
          ? { turns: o.turns, origin: isOrigin(o.origin) ? o.origin : null }
          : { turns: [], origin: null };
      },
      clearDraft: () => {
        cell = null;
      },
      deleteDraft: () => {},
    };
    return { io, cell: () => cell };
  };

  // --- restoring with no draft yields the same empty, clean editor as a fresh
  //     visit (loadDraft() returns [], restore is unconditional dataflow) ---
  const a = draftIo();
  const s = new EditorStore(a.io);
  s.restoreDraft(a.io.loadDraft());
  assert("empty draft restores to an empty, non-dirty editor", s.blocks.length === 0 && !s.isDirty);

  // --- wire the real persistence path, then an edit persists the current turns ---
  const dispose = persistDrafts(s, a.io);
  s.setImport("## User\nhi\n\n## Assistant\nyo");
  s.ingest();
  assertEq("ingest adopts the parse's provenance", s.source, "markdown");
  const firstId = s.blocks[0]!.id;
  s.replaceTurn(firstId, { kind: "message", role: "user", content: "EDITED DRAFT" });
  assertEq(
    "the reaction persisted the current draft (turns + import origin)",
    a.cell(),
    JSON.stringify({ turns: s.turns, origin: s.importOrigin }),
  );

  // --- a fresh editor restoring that draft reproduces the edits and is NOT
  //     instantly dirty (restore sets pristineTurns via the shared loader) ---
  const s2 = new EditorStore(a.io);
  s2.restoreDraft(a.io.loadDraft());
  assertEq("restored draft reproduces the edited blocks", JSON.stringify(s2.turns), JSON.stringify(s.turns));
  assert("restored draft is not instantly dirty", !s2.isDirty);
  assertEq("restored draft carries the provenance through", s2.source, "markdown");

  // --- a successful submit clears the draft so the next visit starts clean ---
  await s2.submit();
  assert("successful submit clears the persisted draft", a.cell() === null);
  assert("loadDraft after submit yields no draft", a.io.loadDraft().turns.length === 0);

  dispose();
}

console.log("\nDiscard draft persistence round-trip (slopspot-editor-draft-rp4):");
{
  // [LAW:verifiable-goals] The ticket's core acceptance: after discard(), a fresh
  // store restored from io.loadDraft() has empty blocks — reload starts clean.
  // Wires persistDrafts (the SAME reaction mount ships) so the full real path runs.
  let cell: string | null = null;
  const discardIo: EditorIo = {
    fetchShare: async (): Promise<ParseResult> => ({ ok: false, reason: "unused" }),
    fetchDraft: async (): Promise<DraftLoadResult> => ({ ok: false, reason: "unused" }),
    submit: async (): Promise<SubmitResult> => ({ ok: true, slug: "x" }),
    navigate: () => {},
    saveDraft: (draft) => { cell = JSON.stringify(draft); },
    loadDraft: (): Draft => {
      if (cell === null) return { turns: [], origin: null };
      const o = JSON.parse(cell) as { turns?: unknown; origin?: unknown } | null;
      return o && isTurns(o.turns)
        ? { turns: o.turns, origin: isOrigin(o.origin) ? o.origin : null }
        : { turns: [], origin: null };
    },
    clearDraft: () => { cell = null; },
    deleteDraft: () => {},
  };

  const store = new EditorStore(discardIo);
  const dispose = persistDrafts(store, discardIo);

  store.setImport("## User\nhello\n\n## Assistant\nworld");
  store.ingest();
  assert("blocks built before discard", store.blocks.length === 2);
  assert("draft persisted before discard", cell !== null);

  store.discard();
  assert("after discard(): store.blocks is empty", store.blocks.length === 0);

  // The persist reaction fires after discard() and writes an empty draft; the
  // fresh store that restores it gets the same empty editor a fresh visit gets.
  const freshStore = new EditorStore(discardIo);
  freshStore.restoreDraft(discardIo.loadDraft());
  assert(
    "fresh store from loadDraft() after discard has empty blocks — reload starts clean",
    freshStore.blocks.length === 0,
  );

  dispose();
}

console.log("\nDiscard revokes the server-side handoff draft (slopspot-cc-share-4nc.11):");
{
  // [LAW:verifiable-goals] The ticket's acceptance: discarding a draft opened from a
  // server handoff (?draft=<id> -> loadServerDraft) DELETEs that exact KV draft, so
  // exposure ends immediately instead of waiting out the 1h TTL. The id the boundary
  // received is captured so the test asserts the bound handle — not merely that some
  // delete fired.
  const deleted: (string | null)[] = [];
  const draftTurns: Turn[] = [{ kind: "message", role: "user", content: "handed off" }];
  const handoffIo: EditorIo = {
    fetchShare: async (): Promise<ParseResult> => ({ ok: false, reason: "unused" }),
    fetchDraft: async (): Promise<DraftLoadResult> => ({ ok: true, draft: { turns: draftTurns, origin: null } }),
    submit: async (): Promise<SubmitResult> => ({ ok: true, slug: "x" }),
    navigate: () => {},
    saveDraft: () => {},
    loadDraft: (): Draft => ({ turns: [], origin: null }),
    clearDraft: () => {},
    deleteDraft: (id) => { deleted.push(id); },
  };

  const store = new EditorStore(handoffIo);
  await store.loadServerDraft("draft_abc123");
  assertEq("server draft restored its turns", store.blocks.length, 1);
  assertEq("the revocable handle is bound after restore", store.serverDraftId, "draft_abc123");

  store.discard();
  assertEq("discard revoked exactly the bound draft id", JSON.stringify(deleted), JSON.stringify(["draft_abc123"]));
  assert("the handle is cleared after revocation (a second discard re-issues nothing)", store.serverDraftId === null);

  store.discard();
  assertEq("a second discard passes null (no server draft to revoke)", JSON.stringify(deleted), JSON.stringify(["draft_abc123", null]));

  // A from-scratch editor (never opened from a handoff) revokes nothing server-side:
  // serverDraftId stays null, so discard passes null and the boundary no-ops.
  const scratchDeleted: (string | null)[] = [];
  const scratchIo: EditorIo = { ...handoffIo, deleteDraft: (id) => { scratchDeleted.push(id); } };
  const scratch = new EditorStore(scratchIo);
  scratch.setImport("## User\nhi\n\n## Assistant\nyo");
  scratch.ingest();
  scratch.discard();
  assertEq("from-scratch discard passes null (no handoff to revoke)", JSON.stringify(scratchDeleted), JSON.stringify([null]));
}

console.log("\nEditorStore submitOrigin (provenance-2my — share carries its origin, edits collapse to editor):");
{
  const shareUrl = "https://claude.ai/share/abc-def-123";
  const shareFetched = "## You said:\nq\n\n## Claude said:\na";
  const shareTurns: Turn[] = [
    { kind: "message", role: "user", content: "q" },
    { kind: "message", role: "assistant", content: "a" },
  ];
  const shareOrigin: Origin = { kind: "url", url: shareUrl, fetched: shareFetched, provider: "claude-share" };
  // fetchShare stands in for /api/fetch returning the FULL captured origin (url +
  // fetched bytes), which the editor now carries through to submit.
  const io: EditorIo = {
    fetchShare: async (): Promise<ParseResult> => ({ ok: true, turns: shareTurns, origin: shareOrigin }),
    fetchDraft: async (): Promise<DraftLoadResult> => ({ ok: false, reason: "unused" }),
    submit: async (): Promise<SubmitResult> => ({ ok: true, slug: "x" }),
    navigate: () => {},
    saveDraft: () => {},
    loadDraft: (): Draft => ({ turns: [], origin: null }),
    clearDraft: () => {},
    deleteDraft: () => {},
  };

  // --- a pristine share import stamps the replayable claude-share origin: its
  //     url is displayed and its bytes re-projectable [the whole point of 2my] ---
  const s = new EditorStore(io);
  s.setImport(shareUrl);
  await s.ingest();
  assertEq("share import detects the generic url arm (provider resolved server-side)", s.importKind, "url");
  assert("share import loads its turns and is not dirty", s.blocks.length === 2 && !s.isDirty);
  const pristine = s.submitOrigin;
  assert(
    "a pristine share stamps a url origin carrying link + fetched bytes + provider",
    pristine.kind === "url" &&
      pristine.url === shareUrl &&
      pristine.fetched === shareFetched &&
      pristine.provider === "claude-share",
  );
  assertEq("styling derives from the url origin's provider", s.source, "claude-share");

  // --- editing the imported turns collapses to an editor origin: the turns are
  //     now the source (claiming the share URL would lie about replay), but the
  //     claude-share styling provenance is preserved ---
  s.replaceTurn(s.blocks[0]!.id, { kind: "message", role: "user", content: "EDITED" });
  assert("editing a share import marks it dirty", s.isDirty);
  const edited = s.submitOrigin;
  assert(
    "an edited share collapses to editor while keeping claude-share styling",
    edited.kind === "editor" && edited.source === "claude-share",
  );

  // --- a pristine text import stamps the verbatim content origin (o2q.4) ---
  //     The turns ARE parse(content), so the stored paste is replayable without
  //     collapsing to the editor arm. isDirty=false is the discriminator.
  const textIo: EditorIo = {
    ...io,
    submit: async (): Promise<SubmitResult> => ({ ok: true, slug: "x" }),
  };
  const text = new EditorStore(textIo);
  text.setImport("## User\nhello\n\n## Assistant\nworld");
  text.ingest();
  assert("text import loads turns and is not dirty", text.blocks.length === 2 && !text.isDirty);
  const pristineText = text.submitOrigin;
  assert(
    "a pristine text import stamps its verbatim content origin, not an editor arm",
    pristineText.kind === "markdown" && pristineText.content === "## User\nhello\n\n## Assistant\nworld",
  );

  // --- authored from scratch (no import) stamps editor with no provenance ---
  const blank = new EditorStore(io);
  blank.addBlock("message");
  const scratch = blank.submitOrigin;
  assert(
    "from-scratch authoring stamps an editor origin with null provenance",
    scratch.kind === "editor" && scratch.source === null,
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
    { kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "terminal", text: "x", isError: false } },
    { kind: "tool-call", tool: "Update", args: "f", output: { kind: "diff", text: "x", isError: true } },
    { kind: "tool-call", tool: "Read", args: "f", output: { kind: "file-read", text: "x", isError: false } },
    { kind: "tool-call", tool: "X", args: "", output: { kind: "generic", text: "x", isError: false } },
  ]));
  assert("accepts insight", isTurns([{ kind: "insight", content: "aha" }]));
  assert("accepts thinking", isTurns([{ kind: "thinking", content: "reasoning" }]));
  assert("rejects thinking missing content", !isTurns([{ kind: "thinking" }]));
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
    !isTurns([{ kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "bogus", text: "x", isError: false } }]));
  assert("rejects tool-call output missing text",
    !isTurns([{ kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "terminal", isError: false } }]));
  assert("rejects tool-call output missing isError",
    !isTurns([{ kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "terminal", text: "x" } }]));
  assert("rejects tool-call output non-boolean isError",
    !isTurns([{ kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "terminal", text: "x", isError: "yes" } }]));

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
  const fixture: AuthorableTurn[] = [
    { kind: "message", role: "user", content: "hello" },
    { kind: "insight", content: "a key realization" },
    { kind: "tool-call", tool: "Bash", args: "ls -la", output: { kind: "terminal", text: "total 0", isError: false } },
  ];
  assert("accepts editor toTurns output (round-trip)", isTurns(toTurns(toBlocks(fixture))));
}

console.log("\nFixture-capture credential scrub (single enforcer):");
{
  // Shape table for the scrub: each rule mirrors the exact produced shape of
  // one AWS SigV4 credential param; reject rows perturb one invariant each.
  // Key ids are assembled at runtime so no scanner-matchable literal ever
  // sits in this repo — the literal in source IS the leak class under test.
  const ASIA_ID = ["AS", "IA", "0123456789ABCDEF"].join("");
  const AKIA_ID = ["AK", "IA", "ZYXWVU9876543210"].join("");
  const SCRUBBED_ID = "ASIA" + "x".repeat(16);
  const TOKEN = "IQoJb3JpZ2luX2VjEBA%2FaCWV1%2BLXdlc3QtMSJIMEYCIQD0%3D";
  const SIG = "c76687ee7e2837015ff40472880094c4d7d67d2a60df5e31e9af3937af4c49f0";

  // --- accepts (rewrites): each credential param, in produced context ---
  assertEq(
    "security token → REDACTED, stops at next param",
    scrubCredentials(`X-Amz-Security-Token=${TOKEN}&X-Amz-Algorithm=AWS4-HMAC-SHA256`),
    "X-Amz-Security-Token=REDACTED&X-Amz-Algorithm=AWS4-HMAC-SHA256",
  );
  assertEq(
    "security token at end of input",
    scrubCredentials(`X-Amz-Security-Token=${TOKEN}`),
    "X-Amz-Security-Token=REDACTED",
  );
  assertEq(
    "security token inside markdown link keeps closing paren",
    scrubCredentials(`[img](https://x.com/a?X-Amz-Security-Token=${TOKEN})`),
    "[img](https://x.com/a?X-Amz-Security-Token=REDACTED)",
  );
  assertEq(
    "temporary key id in X-Amz-Credential → prefix + lowercase x",
    scrubCredentials(`X-Amz-Credential=${ASIA_ID}%2F20260530%2Feu-west-1`),
    `X-Amz-Credential=${SCRUBBED_ID}%2F20260530%2Feu-west-1`,
  );
  assertEq(
    "bare key id in prose is scrubbed (scanners match bare ids)",
    scrubCredentials(`the key ${AKIA_ID} leaked`),
    `the key AKIA${"x".repeat(16)} leaked`,
  );
  assertEq(
    "signature → 64 zeros, length-preserving",
    scrubCredentials(`X-Amz-Signature=${SIG}`),
    `X-Amz-Signature=${"0".repeat(64)}`,
  );

  // --- full produced line: params interact the way the share page emits them ---
  const rawLine =
    `Failed to fetch: https://blob.example.amazonaws.com/obj?x-key-id=BN5JZ` +
    `&X-Amz-Security-Token=${TOKEN}&X-Amz-Date=20260530T080637Z` +
    `&X-Amz-Credential=${ASIA_ID}%2F20260530%2Feu-west-1%2Fs3%2Faws4\\_request` +
    `&X-Amz-Expires=14400&X-Amz-Signature=${SIG}`;
  const scrubbedLine = scrubCredentials(rawLine);
  assertEq(
    "full pre-signed URL line scrubs all three params, keeps the rest",
    scrubbedLine,
    `Failed to fetch: https://blob.example.amazonaws.com/obj?x-key-id=BN5JZ` +
      `&X-Amz-Security-Token=REDACTED&X-Amz-Date=20260530T080637Z` +
      `&X-Amz-Credential=${SCRUBBED_ID}%2F20260530%2Feu-west-1%2Fs3%2Faws4\\_request` +
      `&X-Amz-Expires=14400&X-Amz-Signature=${"0".repeat(64)}`,
  );
  assertEq("scrub is idempotent", scrubCredentials(scrubbedLine), scrubbedLine);
  // The doubled-indicator fingerprint depends on byte-identical line pairs.
  const pair = scrubCredentials(`${rawLine}\n\n${rawLine}`).split("\n");
  assert("doubled pair stays byte-identical", pair[0] === pair[2]);

  // --- rejects (left alone): near-misses, one invariant perturbed each ---
  assertEq("prose ASIA + <16 chars untouched", scrubCredentials("ASIAN markets rallied"), "ASIAN markets rallied");
  assertEq(
    "lowercase placeholder untouched (already scrubbed)",
    scrubCredentials(SCRUBBED_ID),
    SCRUBBED_ID,
  );
  assertEq(
    "non-credential X-Amz params untouched",
    scrubCredentials("X-Amz-Date=20260530T080637Z&X-Amz-Expires=14400"),
    "X-Amz-Date=20260530T080637Z&X-Amz-Expires=14400",
  );

  // --- leak checks assert output state, independent of the rules ---
  assertEq("raw line trips all three leak checks", findCredentialLeaks(rawLine).length, 3);
  assertEq("scrubbed line trips none", findCredentialLeaks(scrubbedLine).length, 0);
  assert(
    "truncated signature (rule can't fix it) still fails loud",
    findCredentialLeaks("X-Amz-Signature=abc123").length > 0,
  );

  // --- structural truth: scrubbing must not flip indicator eligibility ---
  assertEq("long line stays indicator-ineligible after scrub", compareLines(rawLine, scrubbedLine).flips.length, 0);
  const shortRaw = `Failed to fetch https://e.co/a?X-Amz-Security-Token=${TOKEN}${TOKEN}${TOKEN}`;
  const shortScrubbed = scrubCredentials(shortRaw);
  assert(
    "length-class flip (>160 → ≤160) is detected",
    compareLines(shortRaw, shortScrubbed).flips.length === 1,
  );
  assertEq("changed-line count reports scrubbed lines", compareLines(rawLine, scrubbedLine).changedLines, 1);
}

console.log("\nDerived nested dialogue (deriveDialogue — cbm.1):");
{
  // [LAW:types-are-the-program] The contract that survives a refactor: a Dialogue
  // is an ordered spine of user/system "spoken" nodes and assistant nodes; an
  // assistant node carries an ORDERED, INTERLEAVED block sequence in source order;
  // each tool-call OWNS its result; illegal states (a detail block at a user spine,
  // an orphaned result) are unrepresentable. These assert the CONTRACT (turns →
  // dialogue), not the fold's mechanism.

  // Helpers that read the model without leaning on its internal field order.
  const blockKinds = (n: SpineNode): string[] =>
    n.kind === "assistant" ? n.blocks.map((b) => b.kind) : [];
  const spineKinds = (d: ReadonlyArray<SpineNode>): string[] =>
    d.map((n) => (n.kind === "spoken" ? `spoken:${n.role}` : "assistant"));

  // A transcript exercising interleaving (text → tool → text), a paired tool
  // result, a thinking block, multiple assistant message.ids between two human
  // turns (which MUST merge into one assistant node), and per-message usage.
  const u = (out: number) => ({
    input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  });
  const SAMPLE = [
    { type: "user", message: { role: "user", content: "build it" } },
    { type: "assistant", message: { id: "mA", role: "assistant", usage: u(40), content: [
      { type: "thinking", thinking: "plan the work" },
      { type: "text", text: "On it." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } },
    ] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "built ok" }] } },
    { type: "assistant", message: { id: "mB", role: "assistant", usage: u(12), content: [
      { type: "text", text: "Done — it builds." },
    ] } },
    { type: "user", message: { role: "user", content: "thanks" } },
  ].map((e) => JSON.stringify(e)).join("\n");

  const parsed = parseInput({ kind: "claude-jsonl", content: SAMPLE });
  assert("dialogue sample parses", parsed.ok);
  if (parsed.ok) {
    const dialogue = deriveDialogue(parsed.turns);

    // Spine: user → assistant (mA + mB merged, the tool_result event between them
    // is NOT a human message) → user. Three nodes, not five.
    assertEq("spine alternates user/assistant/user", spineKinds(dialogue),
      ["spoken:user", "assistant", "spoken:user"]);

    const first = dialogue[0]!;
    assert("first spine node is the user message, content intact",
      first.kind === "spoken" && first.role === "user" && first.content === "build it");

    // Interleaving preserved in source order, and the two assistant messages merged
    // into ONE assistant node carrying both messages' blocks.
    const mid = dialogue[1]!;
    assertEq("assistant blocks interleaved in source order across merged messages",
      blockKinds(mid),
      ["thinking", "text", "tool-call", "usage", "text", "usage"]);

    // The tool-call OWNS its result — joined by tool_use_id, no orphaned result node.
    if (mid.kind === "assistant") {
      const tc = mid.blocks.find((b) => b.kind === "tool-call");
      assert("tool-call carries its own paired result",
        tc?.kind === "tool-call" && tc.output?.text === "built ok");
      assert("tool-call result classified terminal (Bash)",
        tc?.kind === "tool-call" && tc.output?.kind === "terminal");
    }

    const last = dialogue[2]!;
    assert("trailing user message closes the spine",
      last.kind === "spoken" && last.role === "user" && last.content === "thanks");

    // [LAW:types-are-the-program] Illegal states are unrepresentable, asserted as
    // structural invariants over ANY derived dialogue:
    //   (1) no spoken node carries blocks (a detail block at a user/system spine
    //       cannot exist — `spoken` has no `blocks` field);
    //   (2) every tool-call lives inside an assistant node;
    //   (3) there is no standalone "result" spine node — results live in output.
    const spokenHaveNoBlocks = dialogue.every(
      (n) => n.kind !== "spoken" || !("blocks" in n),
    );
    assert("no spoken node carries blocks (detail at user spine unrepresentable)",
      spokenHaveNoBlocks);
    // Every tool-call observed lands inside an assistant node — the type makes a
    // tool-call elsewhere impossible, so this counts them where they legally live.
    const toolCallsUnderAssistant = dialogue
      .filter((n): n is Extract<SpineNode, { kind: "assistant" }> => n.kind === "assistant")
      .flatMap((n) => n.blocks)
      .filter((b) => b.kind === "tool-call").length;
    assert("the one tool-call lands under an assistant node", toolCallsUnderAssistant === 1);
  }

  // [LAW:one-source-of-truth] The dialogue is a pure function of the ORIGINAL:
  // deriving from the stored turns equals deriving from turns re-projected from the
  // captured origin. No KV migration — existing pastes re-derive for free.
  if (parsed.ok) {
    const replayed = reprojectOrigin(parsed.origin);
    assert("origin re-projects (replayable jsonl arm)", replayed !== null);
    if (replayed) {
      assertEq("dialogue(turns) === dialogue(reproject(origin))",
        JSON.stringify(deriveDialogue(parsed.turns)),
        JSON.stringify(deriveDialogue(replayed)));
    }
  }

  // Multi-kind assistant annotations (insight, turn-summary) are preserved as
  // assistant blocks in source order — the CC sample carries both.
  if (cc.ok) {
    const ccDialogue = deriveDialogue(cc.turns);
    const ccBlockKinds = ccDialogue.flatMap((n) => (n.kind === "assistant" ? n.blocks.map((b) => b.kind) : []));
    assert("insight preserved as an assistant block", ccBlockKinds.includes("insight"));
    assert("turn-summary preserved as an assistant block", ccBlockKinds.includes("turn-summary"));
    // The CC sample opens with a user message, then a long run of agent activity.
    const ccHead = ccDialogue[0]!;
    assert("CC dialogue opens with the user 'deleted' message",
      ccHead.kind === "spoken" && ccHead.role === "user" && ccHead.content === "deleted");
  }

  // [LAW:dataflow-not-control-flow] Visibility is a total property of block KIND.
  const visOf = (kind: AssistantBlock["kind"]): string => {
    const sample: Record<AssistantBlock["kind"], AssistantBlock> = {
      text: { kind: "text", content: "" },
      thinking: { kind: "thinking", content: "" },
      "tool-call": { kind: "tool-call", tool: "", args: "", output: null },
      insight: { kind: "insight", content: "" },
      "turn-summary": { kind: "turn-summary", text: "" },
      usage: { kind: "usage", usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } },
      subagent: {
        kind: "subagent",
        agentType: null,
        description: null,
        stepCount: 0,
        body: { kind: "summary-only", prompt: "", result: "" },
      },
    };
    return blockVisibility(sample[kind]);
  };
  assertEq("text is spine", visOf("text"), "spine");
  assertEq("insight is spine", visOf("insight"), "spine");
  assertEq("thinking is detail", visOf("thinking"), "detail");
  assertEq("tool-call is detail", visOf("tool-call"), "detail");
  assertEq("subagent is detail", visOf("subagent"), "detail");
  assertEq("turn-summary is meta", visOf("turn-summary"), "meta");
  assertEq("usage is meta", visOf("usage"), "meta");

  // Empty stream → empty dialogue. A system message becomes its own spoken node
  // and breaks the assistant run.
  assertEq("empty turns → empty dialogue", JSON.stringify(deriveDialogue([])), "[]");
  const withSystem = deriveDialogue([
    { kind: "message", role: "assistant", content: "a" },
    { kind: "message", role: "system", content: "sys" },
    { kind: "message", role: "assistant", content: "b" },
  ]);
  assertEq("system message splits the spine",
    withSystem.map((n) => (n.kind === "spoken" ? `spoken:${n.role}` : "assistant")),
    ["assistant", "spoken:system", "assistant"]);

  // [LAW:no-silent-failure] The exhaustiveness guard is compile-time (a new Turn
  // kind fails to compile in the switch) AND loud at runtime: a kind that slipped
  // past the type system throws rather than dropping out of the projection.
  let threw = false;
  try {
    deriveDialogue([{ kind: "not-a-real-kind" } as unknown as Turn]);
  } catch {
    threw = true;
  }
  assert("unhandled turn kind throws (never silently dropped)", threw);
}

console.log("\nCondensed tool-call model (cbm.2 — per-tool primary-arg table):");
{
  // jsonl shape: args is serialized JSON; the primary key's value is extracted.
  assertEq("jsonl Bash → command value",
    primaryArgValue("Bash", JSON.stringify({ command: "git status", description: "check" })),
    "git status");
  assertEq("jsonl Read → file_path value",
    primaryArgValue("Read", JSON.stringify({ file_path: "/a/b.ts" })),
    "/a/b.ts");
  assertEq("jsonl WebSearch → query value",
    primaryArgValue("WebSearch", JSON.stringify({ query: "lit html" })),
    "lit html");

  // [LAW:dataflow-not-control-flow] Adding a tool is ONE table row, no code path:
  // Read and Bash route through the identical extractor with different keys, and a
  // key added to the table is immediately extractable with no extraction change.
  assert("table drives extraction, not per-tool code",
    TOOL_PRIMARY_ARG["Read"] === "file_path" && TOOL_PRIMARY_ARG["Bash"] === "command" &&
    primaryArgValue("Grep", JSON.stringify({ pattern: "foo", path: "src" })) === "foo");

  // cc/claude-share shape: args is raw text (already the source's condensed form),
  // not JSON — the raw string IS the value, no extraction lie.
  assertEq("cc raw-text args used verbatim", primaryArgValue("Bash", "git status"), "git status");
  assertEq("cc Read raw path used verbatim", primaryArgValue("Read", "src/foo.ts"), "src/foo.ts");

  // Multi-line value (pretty JSON / multi-line command) collapses to one line.
  assertEq("primary value collapsed to one line",
    primaryArgValue("Bash", JSON.stringify({ command: "a\n  b\n  c" })),
    "a b c");

  // [LAW:no-mode-explosion] A tool ABSENT from the table → null (name-only), via
  // the one NAMED fallback — never a crash, never a guessed value.
  assertEq("unknown tool → null (name-only fallback)", primaryArgValue("TodoWrite", "{}"), null);
  assertEq("unknown tool with prose args → still null",
    primaryArgValue("MysteryTool", "some args"), null);

  // [LAW:no-silent-failure] A table tool whose JSON args OMIT (or null) the
  // primary key → null (name-only), NEVER the raw JSON blob dumped as a value.
  assertEq("table tool, JSON missing primary key → null", primaryArgValue("Edit", "{}"), null);
  assertEq("table tool, JSON with other keys but no primary key → null",
    primaryArgValue("Bash", JSON.stringify({ description: "x" })), null);
  assertEq("table tool, JSON primary key present but null → null",
    primaryArgValue("Read", JSON.stringify({ file_path: null })), null);

  // Pass/fail status is the source's real error bit, exhaustive over the three
  // honest states. [LAW:no-silent-failure]
  assertEq("output null → no-result status",
    condenseToolCall({ kind: "tool-call", tool: "Bash", args: "ls", output: null }).status,
    "no-result");
  assertEq("result isError false → ok status",
    condenseToolCall({ kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "terminal", text: "x", isError: false } }).status,
    "ok");
  assertEq("result isError true → error status",
    condenseToolCall({ kind: "tool-call", tool: "Bash", args: "ls", output: { kind: "terminal", text: "boom", isError: true } }).status,
    "error");

  // End-to-end condensed line as data: name + extracted value + status.
  assertEq("condenseToolCall produces the full row",
    condenseToolCall({
      kind: "tool-call", tool: "Edit",
      args: JSON.stringify({ file_path: "src/x.ts", old_string: "a", new_string: "b" }),
      output: { kind: "diff", text: "...", isError: false },
    }),
    { tool: "Edit", primaryArg: "src/x.ts", status: "ok" });
}

console.log("\nDisclosure renderer (renderDialogueHtml — cbm.3):");
{
  // [LAW:behavior-not-structure] These assert the four acceptance criteria as
  // invariants over the rendered HTML — what the renderer PROMISES (spine always
  // visible, detail collapsed-by-default, condensed rows scannable, no JS for
  // expand/collapse) — not the private shape of the renderer's helpers.

  const DIFF_OUTPUT = `Added 1 line
      162 +new line of code
      163  context line`;
  const FILE_OUTPUT = `Read 2 lines
1  import { foo } from "bar";
2  export const x = 1;`;

  // One transcript exercising every block kind, interleaving, the usage fold,
  // the three tool statuses, name-only fallback, and XSS-bearing content. The
  // first Bash carries cc-shape RAW args (the terminal body formats the command);
  // the Edit carries jsonl-shape JSON args (the primary arg is extracted from it).
  // The run derives a single assistant node (no human turn between the agent
  // blocks) closed by a trailing system message.
  const turns: Turn[] = [
    { kind: "message", role: "user", content: "build it" },
    { kind: "thinking", content: "let me plan the <work>" },
    { kind: "message", role: "assistant", content: "On it." },
    { kind: "tool-call", tool: "Bash", args: "ls -la",
      output: { kind: "terminal", text: "total 0", isError: false } },
    { kind: "tool-call", tool: "Edit", args: JSON.stringify({ file_path: "src/x.ts", old_string: "a", new_string: "b" }),
      output: { kind: "diff", text: DIFF_OUTPUT, isError: false } },
    { kind: "tool-call", tool: "Bash", args: JSON.stringify({ command: "boom" }),
      output: { kind: "terminal", text: "kaboom", isError: true } },
    { kind: "tool-call", tool: 'evil" onload="x', args: "", output: null },
    { kind: "tool-call", tool: "TodoWrite", args: "{}", output: { kind: "generic", text: "ok", isError: false } },
    { kind: "tool-call", tool: "Read", args: "src/x.ts", output: { kind: "file-read", text: FILE_OUTPUT, isError: false } },
    { kind: "insight", content: "the key point" },
    { kind: "turn-summary", text: "<b>not bold</b>" },
    { kind: "usage", usage: { input: 10, output: 100, cacheCreation: 0, cacheRead: 0 } },
    { kind: "message", role: "assistant", content: "Done." },
    { kind: "usage", usage: { input: 1, output: 50, cacheCreation: 0, cacheRead: 0 } },
    { kind: "message", role: "system", content: "system note" },
  ];
  const html = renderDialogueHtml(deriveDialogue(turns));
  const has = (label: string, needle: string) => assert(label, html.includes(needle));

  // ── Acceptance 1: collapsed by default = thinking, tool-call; always visible =
  // user + assistant text. Spine nodes are NOT <details>, so they cannot collapse.
  // Each top-level spine node carries id="t<index>" — the permalink anchor, the
  // same index the minimap navigates by (permalinks-64g.1). It is emitted only at
  // the top level; a nested subagent transcript carries none (asserted below).
  has("user message is an always-visible article (not a details)",
    '<article class="bubble bubble-user" data-kind="message" data-role="user" data-index="0" data-topic="build it" id="t0">');
  has("assistant turn is an always-visible article",
    '<article class="bubble bubble-assistant assistant-turn" data-kind="message" data-role="assistant" data-index="1" data-topic="On it." id="t1">');
  has("assistant TEXT renders always-visible (no details wrapper)",
    '<div class="assistant-text bubble-body clampable">');
  assert("no spine bubble is a <details> (user/assistant text never collapse)",
    !/<details[^>]*class="[^"]*bubble-(user|assistant)/.test(html));

  // ── Spine prose is clampable; its body is wrapped in .clamp-content so the
  // client capability can clamp it to a default height and reveal an Expand
  // toggle only when it overflows. The clamp class/toggle are NEVER in the
  // server markup — they are added by enhanceClampBlocks from measured geometry,
  // so a no-JS viewer sees full prose ([LAW:no-silent-failure]). Detail kinds
  // (thinking) stay un-clampable: they already collapse behind disclosure.
  has("user spine body is a clampable wrapper", '<div class="bubble-body clampable">');
  has("clampable body wraps its prose in .clamp-content", '<div class="clamp-content">');
  assert("server markup never pre-collapses (no .is-collapsed)", !html.includes("is-collapsed"));
  assert("server markup carries no clamp toggle (client-only)", !html.includes("clamp-toggle"));
  // The thinking detail body keeps the bare (un-clampable) bubble-body — that
  // exact class string appears ONLY for detail kinds now that every spine body
  // carries `clampable`, so its presence proves thinking stayed a disclosure.
  has("thinking body is the bare bubble-body (NOT clampable)", '<div class="bubble-body">');
  has("thinking is a condensed <details>", '<details class="condensed condensed-thinking" data-kind="thinking">');
  has("tool-call is a condensed <details>", '<details class="condensed condensed-tool-call" data-kind="tool-call"');
  assert("thinking collapsed by default (no open attribute)",
    !/<details class="condensed condensed-thinking"[^>]*\bopen\b/.test(html));
  assert("tool-call collapsed by default (no open attribute)",
    !/<details class="condensed condensed-tool-call"[^>]*\bopen\b/.test(html));

  // ── Acceptance 2: expanding any node reveals its FULL original content. The
  // body is present in the markup (the browser reveals it on toggle, no fetch).
  has("thinking body carries the full reasoning text", "let me plan the &lt;work&gt;");
  has("tool-call expands to the shared terminal frame", 'data-output-kind="terminal"');
  has("terminal body shows the $-prefixed command", "$ ls -la");
  has("tool-call expands to the shared diff frame", 'data-output-kind="diff"');
  has("diff body shows an added row", '<div class="diff-line diff-added">');
  has("tool-call expands to the shared file-read frame", 'data-output-kind="file-read"');
  has("file-read body shows a file row", '<div class="file-line">');

  // ── Acceptance 3: condensed rows are scannable as a column — icon + label +
  // primary arg + badge, read straight from the cbm.2 condensed model.
  has("condensed row carries a kind icon", '<span class="condensed-icon');
  has("tool row label is the tool name", '<span class="condensed-label tool-name">Bash</span>');
  has("tool row primary arg is the cbm.2 value", '<span class="condensed-arg">ls -la</span>');
  has("Edit row primary arg is the file path", '<span class="condensed-arg">src/x.ts</span>');
  // Status badges map from the source error bit: ok→✓, error→✕, null→none.
  has("ok status renders a pass badge", '<span class="tool-badge tool-badge-ok"');
  has("error status renders a fail badge", '<span class="tool-badge tool-badge-error"');
  // null-output (evil) and the name-only fallback (TodoWrite, not in the table)
  // render NO arg span and NO badge — never a raw JSON blob, never a guessed value.
  {
    const todoIdx = html.indexOf('data-tool="TodoWrite"');
    const todoRow = html.slice(todoIdx, html.indexOf("</summary>", todoIdx));
    assert("TodoWrite row is name-only: no condensed-arg", !todoRow.includes("condensed-arg"));
    const evilIdx = html.indexOf("evil&quot; onload=");
    const evilRow = html.slice(html.lastIndexOf("<details", evilIdx), html.indexOf("</summary>", evilIdx));
    assert("null-output tool row carries no status badge", !evilRow.includes("tool-badge"));
  }

  // ── Acceptance 4: no JavaScript for expand/collapse — native <details>/<summary>.
  has("collapse affordance is a native <summary>", '<summary class="condensed-summary">');

  // ── Usage fold: running output total across the dialogue, in source order.
  has("first usage shows its own output and running total", "100 tokens");
  has("second usage folds the running total (100 + 50)", "150 total");

  // ── Spine grouping: the two assistant message.ids merge into ONE assistant
  // node (index 1); the trailing system message is its own spine node (index 2).
  has("trailing system message is its own spine node",
    '<article class="bubble bubble-system" data-kind="message" data-role="system" data-index="2" data-topic="system note" id="t2">');
  assert("the merged run yields exactly one assistant turn",
    (html.match(/class="bubble bubble-assistant assistant-turn"/g) ?? []).length === 1);

  // ── [LAW:single-enforcer] The escaping the flat renderer guaranteed survives in
  // the disclosure renderer — same XSS vectors closed (attribute + text + output).
  assert("tool name attribute escaped (no quote breakout)", !html.includes('data-tool="evil" onload='));
  has("tool name attribute escaped form present", "evil&quot; onload=");
  has("turn-summary text escaped", "&lt;b&gt;not bold&lt;/b&gt;");

  // ── [LAW:one-source-of-truth] The render is a pure projection of the original:
  // dialogue from stored turns renders identically to dialogue re-derived from a
  // reprojected origin (proven for deriveDialogue in cbm.1; here for the renderer).
  const empty = renderDialogueHtml(deriveDialogue([]));
  assertEq("empty dialogue → empty render", empty, "");
}

console.log("\nSubagent reattachment + recursive nesting (cbm.4):");
{
  // [LAW:no-silent-failure] Mirrors the VERIFIED real-CC shape: the main blob has
  // an `Agent` tool_use; its tool_result event carries a TOP-LEVEL `toolUseResult`
  // whose `agentId` joins to a subagent group of lines (isSidechain:true, agentId)
  // — the subagent's own transcript, concatenated onto the main blob by the
  // uploader. Reattachment is by that id, never positionally.
  const MAIN = [
    { type: "user", message: { role: "user", content: "analyze the repo" } },
    {
      type: "assistant",
      message: {
        role: "assistant", id: "m1",
        content: [
          { type: "text", text: "I'll delegate." },
          { type: "tool_use", id: "tu1", name: "Agent",
            input: { subagent_type: "Explore", description: "Scout the repo", prompt: "Find the config files" } },
        ],
      },
    },
    {
      type: "user",
      // Top-level toolUseResult is the join: agentId -> subagent group; plus the
      // final result text + the source's own step count.
      toolUseResult: {
        agentId: "a1", agentType: "Explore", status: "completed",
        prompt: "Find the config files", content: "Found 2 configs", totalToolUseCount: 2,
      },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Found 2 configs" }] },
    },
    { type: "assistant", message: { role: "assistant", id: "m2", content: [{ type: "text", text: "Thanks, done." }] } },
  ];
  const SIDECHAIN = [
    { type: "user", isSidechain: true, agentId: "a1", message: { role: "user", content: "Find the config files" } },
    {
      type: "assistant", isSidechain: true, agentId: "a1",
      message: {
        role: "assistant", id: "s1",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "st1", name: "Read", input: { file_path: "wrangler.toml" } },
        ],
      },
    },
    {
      type: "user", isSidechain: true, agentId: "a1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "st1", content: "name = x" }] },
    },
    { type: "assistant", isSidechain: true, agentId: "a1", message: { role: "assistant", id: "s2", content: [{ type: "text", text: "Found 2 configs" }] } },
  ];
  const lines = (evs: unknown[]) => evs.map((e) => JSON.stringify(e)).join("\n");

  // ── Captured: main + concatenated subagent group → full nested transcript.
  const bundle = lines([...MAIN, ...SIDECHAIN]);
  const r = parseInput({ kind: "claude-jsonl", content: bundle });
  assert("bundle parses", r.ok);
  if (r.ok) {
    assertEq("main kinds: the Agent call became a subagent turn",
      kinds(r.turns), ["message", "message", "subagent", "message"]);
    const sub = r.turns[2]!;
    assert("subagent carries agentType from input.subagent_type",
      sub.kind === "subagent" && sub.agentType === "Explore");
    assert("subagent carries the short description",
      sub.kind === "subagent" && sub.description === "Scout the repo");
    assert("subagent stepCount is the source's totalToolUseCount",
      sub.kind === "subagent" && sub.stepCount === 2);
    assert("transcript is CAPTURED (group present)",
      sub.kind === "subagent" && sub.transcript.kind === "captured");
    if (sub.kind === "subagent" && sub.transcript.kind === "captured") {
      assertEq("nested transcript is the subagent's own run",
        kinds(sub.transcript.turns), ["message", "message", "tool-call", "message"]);
      const readCall = sub.transcript.turns[2]!;
      assert("nested Read tool-call paired its result",
        readCall.kind === "tool-call" && readCall.tool === "Read" && readCall.output?.text === "name = x");
      assert("nested run's first turn is the spawn prompt",
        sub.transcript.turns[0]!.kind === "message" && (sub.transcript.turns[0] as { content: string }).content === "Find the config files");
    }

    // Render: the subagent is a collapsed detail row that expands to the nested run.
    const html = renderDialogueHtml(deriveDialogue(r.turns));
    assert("subagent renders as a condensed detail row",
      html.includes('<details class="condensed condensed-subagent" data-kind="subagent"'));
    assert("subagent collapsed by default (no open attribute)",
      !/<details class="condensed condensed-subagent"[^>]*\bopen\b/.test(html));
    assert("condensed line shows the agent type chip", html.includes('<span class="subagent-type">Explore</span>'));
    assert("condensed line shows the source step count", html.includes('<span class="subagent-steps">2 steps</span>'));
    assert("expanded body nests the subagent transcript", html.includes('<div class="subagent-transcript">'));
    assert("nested transcript renders the Read tool-call recursively",
      html.includes('<span class="condensed-label tool-name">Read</span>'));
    // [LAW:no-silent-failure] Nested-subagent prose is NOT clampable: it lives in
    // a collapsed <details>, where it would measure at zero height and cache as
    // "fits" forever. The clamp marker must only land on always-visible top-level
    // spine prose. The transcript's first turn is the spawn prompt — a spoken node
    // whose body must therefore render as the bare (un-clampable) bubble-body.
    {
      const tx = html.indexOf('<div class="subagent-transcript">');
      const window = tx >= 0 ? html.slice(tx, tx + 600) : "";
      assert("nested subagent prose renders as bare bubble-body",
        window.includes('<div class="bubble-body">'));
      assert("nested subagent prose carries no clampable marker",
        tx >= 0 && !window.includes("clampable"));
      // [LAW:types-are-the-program] The permalink id is emitted only at the top
      // level (permalinks-64g.1). A nested transcript renders through the same
      // function with topLevel=false, so its spine nodes carry data-index but NO
      // id="t…" — the duplicate-DOM-id state (nested t0 colliding with the outer
      // t0) is never minted, not deduped after the fact.
      assert("nested subagent spine carries no permalink id (no duplicate anchors)",
        tx >= 0 && window.includes("data-index=") && !window.includes('id="t'));
    }

    // [LAW:one-source-of-truth] Re-projecting the captured origin reproduces an
    // identical dialogue — subagent nesting is derived, never stored separately.
    if (r.origin) {
      const replayed = reprojectOrigin(r.origin);
      assert("captured bundle re-projects", replayed !== null);
      if (replayed) {
        assertEq("reprojected dialogue is identical",
          JSON.stringify(deriveDialogue(r.turns)), JSON.stringify(deriveDialogue(replayed)));
      }
    }
  }

  // ── Graceful degradation: main only, no subagent group → summary-only.
  const mainOnly = lines(MAIN);
  const rg = parseInput({ kind: "claude-jsonl", content: mainOnly });
  assert("main-only bundle parses", rg.ok);
  if (rg.ok) {
    const sub = rg.turns[2]!;
    assert("transcript degrades to SUMMARY-ONLY (group absent)",
      sub.kind === "subagent" && sub.transcript.kind === "summary-only");
    if (sub.kind === "subagent" && sub.transcript.kind === "summary-only") {
      assertEq("summary-only keeps the spawn prompt", sub.transcript.prompt, "Find the config files");
      assertEq("summary-only keeps the final result", sub.transcript.result, "Found 2 configs");
    }
    assert("step count survives without the transcript",
      sub.kind === "subagent" && sub.stepCount === 2);
    const html = renderDialogueHtml(deriveDialogue(rg.turns));
    assert("degraded body names the gap honestly", html.includes("Nested transcript not captured"));
    assert("degraded body is the cbm.7 backfill seam", html.includes('data-subagent-degraded="true"'));
    assert("degraded body still shows the final result", html.includes("Found 2 configs"));
  }

  // ── A blob that is ALL sidechain (no main transcript) is not a conversation.
  const r0 = parseInput({ kind: "claude-jsonl", content: lines(SIDECHAIN) });
  assert("all-sidechain blob (no main) fails cleanly", !r0.ok);

  // ── [LAW:no-silent-failure] Orphaned subagent: a group spawned by a slash
  // command / skill leaves NO Agent tool_use and NO toolUseResult.agentId in the
  // main stream (verified against real sessions). It must still SURFACE — as a
  // top-level subagent turn — not vanish. Here the main has only a plain message;
  // the sidechain group "a1" is referenced nowhere.
  const MAIN_NO_AGENT = [
    { type: "user", message: { role: "user", content: "do the recap" } },
    { type: "assistant", message: { role: "assistant", id: "m9", content: [{ type: "text", text: "Working on it." }] } },
  ];

  // cbm.8: the uploader folds the orphan group's agent-<id>.meta.json {agentType,
  // description} onto its first REAL sidechain line; the orphan branch reads it
  // there (the only honest source, since an orphan has no spawning tool_result).
  const SIDECHAIN_TYPED = SIDECHAIN.map((e, i) =>
    i === 0 ? { ...e, agentType: "general-purpose", description: "do the recap" } : e);
  const rt = parseInput({ kind: "claude-jsonl", content: lines([...MAIN_NO_AGENT, ...SIDECHAIN_TYPED]) });
  assert("typed-orphan bundle parses", rt.ok);
  if (rt.ok) {
    const orphan = rt.turns[2]!;
    assert("orphan surfaces its folded agentType (not null)",
      orphan.kind === "subagent" && orphan.agentType === "general-purpose");
    assert("orphan surfaces its folded description",
      orphan.kind === "subagent" && orphan.description === "do the recap");
    const html = renderDialogueHtml(deriveDialogue(rt.turns));
    assert("typed orphan renders its agent-type chip",
      html.includes('<span class="subagent-type">general-purpose</span>'));
  }

  // An upload predating the fold carries no injected fields → honest nulls, but
  // the orphan still SURFACES (the type is unknown, not the run).
  const ro = parseInput({ kind: "claude-jsonl", content: lines([...MAIN_NO_AGENT, ...SIDECHAIN]) });
  assert("orphan bundle parses", ro.ok);
  if (ro.ok) {
    assertEq("orphan surfaces as a trailing subagent turn (not dropped)",
      kinds(ro.turns), ["message", "message", "subagent"]);
    const orphan = ro.turns[2]!;
    assert("orphan transcript is captured from its group",
      orphan.kind === "subagent" && orphan.transcript.kind === "captured");
    assert("untyped orphan (no folded meta) carries honest null type/description",
      orphan.kind === "subagent" && orphan.agentType === null && orphan.description === null);
    const html = renderDialogueHtml(deriveDialogue(ro.turns));
    assert("orphan renders as a condensed subagent row",
      html.includes('condensed condensed-subagent'));
  }

  // ── [LAW:no-silent-failure] Backfill (cbm.7): augment a degraded main-only blob
  // with its missing subagent transcript, then re-derive. The acceptance path:
  // main-only (summary-only subagent) + supplied sidechain lines → captured.
  // Membership is by sessionId, so the fixtures here carry one (the shared MAIN/
  // SIDECHAIN above predate sessionId and exercise a different axis).
  const SID = "sess-abc";
  const stamp = (evs: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    evs.map((e) => ({ ...e, sessionId: SID }));
  const mainStamped = lines(stamp(MAIN));
  const sideStamped = stamp(SIDECHAIN);
  const suppliedSub = lines(sideStamped);

  // Happy path: append the subagent group, re-derive → the subagent is captured.
  const aug = augmentJsonlWithSubagents(mainStamped, suppliedSub);
  assert("augment of a matching-session subagent succeeds", aug.ok);
  if (aug.ok) {
    assertEq("augment reports the appended agent group", [...aug.addedAgentIds], ["a1"]);
    const ra = parseInput({ kind: "claude-jsonl", content: aug.content });
    assert("augmented blob re-parses", ra.ok);
    if (ra.ok) {
      const sub = ra.turns[2]!;
      assert("the once-degraded subagent is now CAPTURED",
        sub.kind === "subagent" && sub.transcript.kind === "captured");
      const html = renderDialogueHtml(deriveDialogue(ra.turns));
      assert("the backfill seam (button) is gone once captured",
        !html.includes('data-subagent-degraded="true"'));
      assert("captured nested transcript now renders", html.includes('<div class="subagent-transcript">'));
    }
  }

  // Idempotent: re-augmenting an already-captured blob appends nothing (dedup by
  // agentId), so the re-derived transcript is not doubled.
  if (aug.ok) {
    const again = augmentJsonlWithSubagents(aug.content, suppliedSub);
    assert("re-augmenting an already-captured group succeeds", again.ok);
    if (again.ok) {
      assertEq("re-augment appends nothing new", [...again.addedAgentIds], []);
      assertEq("re-augment reports the group as already present", [...again.skippedAgentIds], ["a1"]);
      assertEq("re-augment is byte-identical (no duplicate lines)", again.content, aug.content);
    }
  }

  // [LAW:no-silent-failure] Foreign session: a sidechain line whose sessionId is
  // not the paste's session is rejected — the WHOLE request, not silently dropped.
  const foreign = lines(SIDECHAIN.map((e) => ({ ...e, sessionId: "sess-OTHER" })));
  const augForeign = augmentJsonlWithSubagents(mainStamped, foreign);
  assert("augment rejects lines from a different session", !augForeign.ok);
  assert("rejection names the foreign session loudly",
    !augForeign.ok && augForeign.reason.includes("different session"));

  // [LAW:no-silent-failure] Unlinkable: a well-formed line for the right session
  // that is NOT a subagent sidechain (no agentId/isSidechain) is rejected too —
  // it would otherwise corrupt the MAIN transcript.
  const notSidechain = lines([{ type: "user", sessionId: SID, message: { role: "user", content: "stray main line" } }]);
  const augStray = augmentJsonlWithSubagents(mainStamped, notSidechain);
  assert("augment rejects a non-sidechain line", !augStray.ok);
  assert("rejection names the unlinkable line",
    !augStray.ok && augStray.reason.includes("not a subagent sidechain"));

  // cbm.8 + cbm.7 contract: a folded orphan line carries an EXTRA top-level
  // agentType, but still has sessionId+agentId+isSidechain, so option (a) (the
  // real sidechain line, never a synthetic one) passes the augment validator
  // unchanged — backfilling an orphan-containing session is not rejected.
  const augFolded = augmentJsonlWithSubagents(mainStamped, lines(stamp(SIDECHAIN_TYPED)));
  assert("augment accepts a folded (agentType-bearing) sidechain line", augFolded.ok);

  // Empty / non-JSON supplied input fails cleanly, never silently.
  assert("augment rejects empty supplied input",
    !augmentJsonlWithSubagents(mainStamped, "   ").ok);
  assert("augment rejects non-JSON supplied input",
    !augmentJsonlWithSubagents(mainStamped, "not json at all").ok);

  // A stored blob with no sessionId cannot validate membership → loud refusal.
  assert("augment refuses when the stored blob has no session id",
    !augmentJsonlWithSubagents(lines(MAIN), suppliedSub).ok);

  // ── The subagent kind is detail (collapses by default) and is NOT author-able.
  assertEq("subagent block classifies as detail", blockVisibility({
    kind: "subagent", agentType: null, description: null, stepCount: 0,
    body: { kind: "summary-only", prompt: "", result: "" },
  } as AssistantBlock), "detail");
  assert("a subagent turn is not editable (excluded from AuthorableTurn)",
    !isAuthorable({
      kind: "subagent", agentType: null, description: null, stepCount: 0,
      transcript: { kind: "summary-only", prompt: "", result: "" },
    } as Turn));
}

console.log("\nFirecrawl scrape request body (firecrawl-fetch-bq8 — per-provider SPA render-wait):");
{
  // [LAW:behavior-not-structure] Assert the CONTRACT: the request body carries a
  // wait action targeting the PROVIDER'S OWN hydration selector — the value the
  // registry holds, not one hard-coded selector. The spike proved the selector is
  // per-provider (chatgpt.com never renders claude's), so the assertion iterates
  // the registry rather than pinning a single host's contract. A future edit that
  // drops the action, or stops threading the selector, fails loudly here.
  for (const provider of PROVIDERS) {
    const entry = PROVIDER_REGISTRY[provider];
    const body = scrapeRequestBody("https://example.test/x", entry.wait);
    assert(`scrapeRequestBody[${provider}] includes formats:markdown`, body.formats.includes("markdown"));
    const waitAction = body.actions.find((a) => a.type === "wait");
    assert(`scrapeRequestBody[${provider}] has a wait action`, waitAction !== undefined);
    // The action mirrors the provider's WaitStrategy VALUE: a selector strategy
    // targets its selector; a settle strategy carries its milliseconds.
    if (entry.wait.kind === "selector") {
      assert(
        `scrapeRequestBody[${provider}] selector strategy targets the provider's selector`,
        waitAction !== undefined && "selector" in waitAction && waitAction.selector === entry.wait.selector,
      );
    } else {
      assert(
        `scrapeRequestBody[${provider}] settle strategy carries its milliseconds`,
        waitAction !== undefined && "milliseconds" in waitAction && waitAction.milliseconds === entry.wait.ms,
      );
    }
  }
  // Pin the verified claude.ai contract specifically — a regression guard on the
  // exact selector the spike validated against the live hydrated DOM, so a careless
  // registry edit can't silently swap it for a selector that never hydrates.
  const claudeWait = PROVIDER_REGISTRY["claude-share"].wait;
  assert(
    "claude-share waits on the verified selector [data-testid=\"user-message\"]",
    claudeWait.kind === "selector" && claudeWait.selector === '[data-testid="user-message"]',
  );

  // [LAW:no-silent-failure] The unclaimed-host fallback waits by a bounded SETTLE,
  // not a DOM selector — the spike proved there is no universal hydration selector,
  // so a wrong one would time out. Assert it maps to a milliseconds wait action
  // carrying NO selector (firecrawl's only selector-less wait mode).
  const fallbackBody = scrapeRequestBody("https://example.test/x", FALLBACK_WAIT);
  const fallbackWait = fallbackBody.actions.find((a) => a.type === "wait");
  const fallbackMs = FALLBACK_WAIT.kind === "settle" ? FALLBACK_WAIT.ms : -1;
  assert("FALLBACK_WAIT is a settle strategy", FALLBACK_WAIT.kind === "settle");
  assert("fallback wait is a positive bounded delay", fallbackMs > 0);
  assert(
    "fallback produces a milliseconds wait action",
    fallbackWait !== undefined && "milliseconds" in fallbackWait && fallbackWait.milliseconds === fallbackMs,
  );
  assert(
    "fallback wait carries NO selector",
    fallbackWait !== undefined && !("selector" in fallbackWait),
  );
}

console.log("\nOn-demand summary boundary (slopspot-summary-daf.2):");
{
  // A small derived Dialogue: two human turns around one assistant turn whose
  // blocks mix spine-visible prose (text) with a collapsed detail block (thinking).
  const dialogueTurns: Turn[] = [
    { kind: "message", role: "user", content: "How do I reverse a linked list in place?" },
    { kind: "thinking", content: "SECRET-REASONING-THAT-MUST-NOT-LEAK-INTO-THE-PROMPT" },
    { kind: "message", role: "assistant", content: "Walk it with three pointers and rewire each node." },
    { kind: "message", role: "user", content: "What is the time complexity?" },
    { kind: "message", role: "assistant", content: "O(n) time, O(1) space." },
  ];
  const dialogue = deriveDialogue(dialogueTurns);

  // [LAW:behavior-not-structure] The pure prompt is testable with no fetch: it
  // carries the system instruction and a user message flattening the transcript.
  const messages = buildSummaryPrompt(dialogue);
  assertEq("buildSummaryPrompt emits system + user messages", messages.length, 2);
  const [sysMsg, userMsg] = messages;
  assertEq("first message is the shared system instruction", sysMsg?.content, SUMMARY_SYSTEM_PROMPT);
  assert("system role", sysMsg?.role === "system");
  assert("user role", userMsg?.role === "user");

  const transcript = renderDialogueForPrompt(dialogue);
  assert("transcript includes the human question", transcript.includes("How do I reverse a linked list"));
  assert("transcript includes assistant spine prose", transcript.includes("three pointers"));
  assert("transcript includes the second exchange", transcript.includes("O(n) time"));
  // [LAW:effects-at-boundaries] The summary is built from the READER-facing
  // conversation: collapsed detail (thinking) is NOT sent to the model, so private
  // reasoning cannot leak into a shared TL;DR. This reuses BLOCK_VISIBILITY, so it
  // cannot drift from what the reader actually sees on the page.
  assert("collapsed thinking is EXCLUDED from the prompt", !transcript.includes("SECRET-REASONING"));

  const body = summaryRequestBody(dialogue);
  assert("request body targets deepseek-chat", body.model === "deepseek-chat");
  assert("request body is non-streaming", body.stream === false);
  assertEq("request body carries the built messages", body.messages.length, 2);

  // [FRAMING:representation] FIXTURE FIRST — this is the VERBATIM envelope captured
  // from a real DeepSeek call (POST https://api.deepseek.com/chat/completions), not
  // an assumed shape. extractSummary is exercised against the exact wire payload the
  // edge will hand it, so the parser can never be written against fiction.
  const realResponse = {
    id: "9b2e753d-d7d5-454f-a8b2-9b63d495335e",
    object: "chat.completion",
    created: 1783079563,
    model: "deepseek-v4-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "The user asked how to reverse a linked list; the assistant gave the three-pointer method and confirmed O(n) time, O(1) space." },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 99, completion_tokens: 11, total_tokens: 110 },
  };
  const extracted = extractSummary(realResponse);
  assert("extractSummary reads choices[0].message.content from the real envelope", extracted.ok);
  assert(
    "extracted summary is the model's content",
    extracted.ok && extracted.summary.startsWith("The user asked how to reverse"),
  );

  // [LAW:no-silent-failure] A malformed / empty envelope is a typed configured
  // failure, never a throw and never an empty ok:true summary.
  const emptyContent = extractSummary({ choices: [{ message: { content: "   " } }] });
  assert("blank content → ok:false", !emptyContent.ok);
  assert("blank content is a configured failure (provider misbehaved)", !emptyContent.ok && emptyContent.configured);
  const noChoices = extractSummary({});
  assert("missing choices → ok:false", !noChoices.ok);
  const nullBody = extractSummary(null);
  assert("null body → ok:false, no throw", !nullBody.ok);

  // [LAW:one-source-of-truth] The content hash is deterministic in the turns and
  // changes when the turns change — this is what makes the cache serve a summary
  // only for the exact content it describes.
  await (async () => {
    const h1 = await turnsContentHash(dialogueTurns);
    const h2 = await turnsContentHash(dialogueTurns);
    assertEq("turnsContentHash is deterministic", h1, h2);
    assert("hash is a 64-char sha-256 hex string", /^[0-9a-f]{64}$/.test(h1));
    const editedTurns: Turn[] = [...dialogueTurns, { kind: "message", role: "user", content: "thanks" }];
    const h3 = await turnsContentHash(editedTurns);
    assert("editing the turns mints a NEW hash (cache-busting)", h3 !== h1);

    // [LAW:no-silent-failure] A missing key is surfaced as configured:false BEFORE
    // any network call — no throw, no 500. summarize short-circuits on the empty env.
    const notConfigured = await summarize(dialogue, {});
    assert("missing DEEPSEEK_API_TOKEN → ok:false", !notConfigured.ok);
    assert("missing key is reported as configured:false (not a crash)", !notConfigured.ok && !notConfigured.configured);
  })();
}

console.log("\nFallback parser for unclaimed hosts (url-ingestion-wfd.4):");
{
  // [LAW:no-silent-failure] The CORE acceptance: a fetched page whose host no
  // registered provider claims is still split into a CONVERSATION, never rendered
  // as a single raw bubble. parseFallback never sees the URL — it races the text
  // arms over the fetched bytes — so the witness is host-independent: a conversation
  // carrying generic speaker markers no provider claims must produce many turns
  // across both roles. (chatgpt.com is now a registered provider — see the dedicated
  // parseChatgptShare block — so its bytes would no longer route through the fallback.)
  const unclaimedFetched = [
    "## User", "what is the airspeed velocity of an unladen swallow?",
    "## Assistant", "African or European?",
    "## User", "European.",
    "## Assistant", "Roughly 11 metres per second.",
  ].join("\n\n");
  const fbTurns = parseFallback(unclaimedFetched);
  assert("unclaimed-host bytes split into many turns (NOT one bubble)", fbTurns.length > 1);
  const fbMessages = fbTurns.filter((t): t is Extract<Turn, { kind: "message" }> => t.kind === "message");
  const fbRoles = new Set(fbMessages.map((m) => m.role));
  assert("fallback recovers BOTH user and assistant turns", fbRoles.has("user") && fbRoles.has("assistant"));

  // [LAW:no-silent-failure] A page with no conversational structure is surfaced
  // honestly — one raw bubble of the fetched CONTENT (not dropped), and never null:
  // parseFallback is total, so a url ingest can always render something honest.
  const prose = parseFallback("Just a plain article with no speaker markers at all.");
  assertEq("structureless content → exactly one bubble (honest surface)", prose.length, 1);
  assert("the single bubble carries the content", prose[0]?.kind === "message");

  // reprojectOrigin replays a stored url origin through the SAME resolver: a
  // provider:null origin re-derives via parseFallback (the unclaimed-host plan),
  // and a named provider still re-derives via ITS parser — known providers win
  // ahead of the fallback, exactly as ingest resolves them.
  const fallbackOrigin: Origin = { kind: "url", url: "https://example.com/x", fetched: unclaimedFetched, provider: null };
  const replayedFallback = reprojectOrigin(fallbackOrigin);
  assertEq("reproject(provider:null) === parseFallback(bytes)",
    JSON.stringify(replayedFallback), JSON.stringify(fbTurns));

  const shareFixture = readFileSync("test/fixtures/claude-share.md", "utf8");
  const namedOrigin: Origin = { kind: "url", url: "https://claude.ai/share/x", fetched: shareFixture, provider: "claude-share" };
  const replayedNamed = reprojectOrigin(namedOrigin);
  assertEq("reproject(provider:claude-share) === parseClaudeShare(bytes)",
    JSON.stringify(replayedNamed), JSON.stringify(parseClaudeShare(shareFixture)));

  // A null-provider url origin styles as generic (honest absence), never crashes.
  assertEq("provider:null url origin → generic styling (null source)", sourceOf(fallbackOrigin), null);
}

console.log("\nChatGPT share parser (chatgpt-share-nfs.1):");
{
  // [LAW:behavior-not-structure] parseChatgptShare against the real captured
  // fixture (firecrawl scrape of the reference share link). Its level-4 role
  // markers ("#### You said:" / "#### ChatGPT said:") must split into a clean
  // alternation of messages with page chrome stripped and code fences intact —
  // the measurable improvement over parseFallback, which leaks the page footer
  // ("Voice", the AI disclaimer) into the final turn and applies no ChatGPT styling.
  const fixture = readFileSync("test/fixtures/chatgpt-share.md", "utf8");
  const turns = parseChatgptShare(fixture);
  assert("chatgpt fixture parses to non-null", turns !== null);
  if (turns) {
    const messages = turns.filter((t): t is Extract<Turn, { kind: "message" }> => t.kind === "message");
    assert("every turn is a message (no tool-call shapes in this scrape)", messages.length === turns.length);
    assertEq("fixture splits into 36 turns", turns.length, 36);
    const roles = new Set(messages.map((m) => m.role));
    assert("recovers BOTH user and assistant turns", roles.has("user") && roles.has("assistant"));
    assert("first turn is the user's opening question",
      turns[0]!.kind === "message" && turns[0]!.role === "user" &&
      turns[0]!.content.includes("$1 million per software engineer"));
    assert("second turn is the assistant's answer",
      turns[1]!.kind === "message" && turns[1]!.role === "assistant" &&
      turns[1]!.content.includes("revenue per software engineer"));
    const allText = messages.map((m) => m.content).join("\n");
    // Page chrome (header + footer) is stripped from every turn — the leak class
    // the dedicated provider exists to fix.
    assert("'Chat history' header stripped", !allText.includes("## Chat history"));
    assert("'copy of a shared ChatGPT' notice stripped", !allText.includes("This is a copy of a shared ChatGPT conversation"));
    assert("'Report conversation' stripped", !/^Report conversation$/m.test(allText));
    assert("'Voice' footer button stripped", !/^Voice$/m.test(allText));
    assert("AI disclaimer footer stripped", !allText.includes("ChatGPT is AI and can make mistakes"));
    assert("[Skip to content] link stripped", !allText.includes("[Skip to content]"));
    // In-body headings and fenced code are conversation content, preserved verbatim.
    assert("in-body markdown headings survive (not treated as turn delimiters)",
      allText.includes("### Why this metric exists"));
    assert("fenced code blocks survive verbatim", /```/.test(allText));
  }

  // The marker shape is exact: a level-2 "## You said:" (the claude.ai/share
  // heading level) is NOT a chatgpt turn delimiter, and a single exchange does
  // not reach the >= 2 turn floor → null, never a half-parsed guess.
  assert("non-chatgpt heading levels do not parse",
    parseChatgptShare("## You said:\nq\n\n## Claude responded:\na") === null);
  assert("a lone exchange below the 2-turn floor → null",
    parseChatgptShare("#### You said:\n\nonly one turn here") === null);
  assert("a clean two-turn exchange parses",
    parseChatgptShare("#### You said:\n\nhi\n\n#### ChatGPT said:\n\nhello")?.length === 2);
}

console.log("\nProvider registry URL resolution (url-ingestion.3):");
{
  // [LAW:behavior-not-structure] resolveProvider is the one URL→Provider mapping
  // ingestPaste, reprojectOrigin, and capture all share. Assert its contract:
  // a claude.ai/share URL resolves to claude-share; trailing slash, query, and
  // surrounding whitespace are tolerated; a non-share claude URL, a different
  // host, a multi-line string, and empty input all resolve to null (no provider).
  assert("resolves a claude.ai/share URL", resolveProvider("https://claude.ai/share/abc123") === "claude-share");
  assert("tolerates trailing slash + query", resolveProvider("https://claude.ai/share/abc-123/?x=1") === "claude-share");
  assert("trims surrounding whitespace", resolveProvider("  https://claude.ai/share/abc123  ") === "claude-share");
  assert("resolves a chatgpt.com/share URL", resolveProvider("https://chatgpt.com/share/abc123") === "chatgpt-share");
  assert("chatgpt-share tolerates trailing slash + query", resolveProvider("https://chatgpt.com/share/abc-123/?x=1") === "chatgpt-share");
  assert("rejects a non-share claude.ai URL", resolveProvider("https://claude.ai/chat/abc123") === null);
  assert("rejects a non-share chatgpt.com URL", resolveProvider("https://chatgpt.com/c/abc123") === null);
  assert("rejects a different host", resolveProvider("https://gemini.google.com/share/abc123") === null);
  assert("rejects a multi-line string", resolveProvider("https://claude.ai/share/abc\nhttps://claude.ai/share/def") === null);
  // [LAW:single-enforcer] Same single-line rule as isUrl (shared singleLineUrl): a
  // CR-only break or internal tab the URL parser would strip is rejected here too.
  assert("rejects a CR-only multi-line string", resolveProvider("https://claude.ai/share/abc\rhttps://claude.ai/share/def") === null);
  assert("rejects an internal tab", resolveProvider("https://claude.ai/share/a\tbc") === null);
  assert("rejects empty input", resolveProvider("   ") === null);
}

// [LAW:verifiable-goals] The async ingress guards (url-ingestion-wfd.5). These
// exercise the network boundary (ingestPaste) and the wire-format trust boundary
// (decodeRequest) — both async — so they run inside an async IIFE whose awaits are
// function-scoped (top-level await is unavailable under tsx's CJS output). The
// final pass/fail report moves inside so it prints AFTER these complete; the sync
// checks above have already set process.exitCode on any failure.
void (async () => {
  console.log("\nSingle network boundary re-validates its URL (ingestPaste isUrl guard, url-ingestion.5):");
  {
    // [LAW:single-enforcer] isUrl is enforced at THE network boundary, not just at
    // /api/fetch. A crafted url-arm input with a non-URL string is rejected BEFORE
    // any Firecrawl call — so the env carries no key and no network is touched, yet
    // the guard still fails the paste cleanly. (A valid URL would fetch; not unit-
    // tested here to keep the suite offline — the live smoke in .4 covered that.)
    const offline = { FIRECRAWL_API_KEY: undefined };
    const bad = await ingestPaste({ kind: "url", url: "not a url" }, offline);
    assert("ingestPaste rejects a non-URL url-arm before fetching", !bad.ok);
    const alsoBad = await ingestPaste({ kind: "url", url: "ftp://example.com/x" }, offline);
    assert("ingestPaste rejects a non-http(s) scheme before fetching", !alsoBad.ok);
    // A text arm never reaches the network — it parses locally regardless of env.
    const text = await ingestPaste({ kind: "raw", content: "Human: hi\n\nAssistant: yo" }, offline);
    assert("ingestPaste parses a text arm with no network", text.ok);
    // [LAW:one-source-of-truth] A whitespace-wrapped link is still rejected/accepted
    // by the trimmed predicate, then canonicalized — but we can't assert the stored
    // origin offline (it requires a live fetch). What we CAN assert offline: leading/
    // trailing whitespace does not defeat the isUrl guard (it would reach the fetch),
    // proving the guard and resolveProvider see the same trimmed form.
    const padded = await ingestPaste({ kind: "url", url: "   not a url   " }, offline);
    assert("ingestPaste's isUrl guard trims before judging (padded non-URL still rejected)", !padded.ok);
  }

  console.log("\nAny posted link is a conversation on EVERY ingress (decodeRequest, url-ingestion.5):");
  {
    // [LAW:behavior-not-structure] The contract: a bare http(s) link, however it
    // arrives at /api/paste, decodes to the url FETCH arm — never a text arm that
    // would render the link as a one-message raw bubble. Tested against the real
    // decoder over constructed Requests (no network: decodeRequest only classifies;
    // ingestPaste does the fetch downstream).
    const formReq = (fields: Record<string, string>): Request => {
      const body = new URLSearchParams(fields);
      return new Request("https://x/api/paste", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    };
    const jsonReq = (obj: unknown): Request =>
      new Request("https://x/api/paste", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(obj),
      });

    const url = "https://chatgpt.com/share/abc-123";

    const formUrl = await decodeRequest(formReq({ source: "raw", content: url }));
    assertEq("no-JS form: a bare link → url fetch arm (not the selected text arm)",
      formUrl, { ok: true, input: { kind: "url", url } });

    const formText = await decodeRequest(formReq({ source: "raw", content: "Human: hi\n\nAssistant: yo" }));
    assertEq("no-JS form: real text stays a text arm",
      formText, { ok: true, input: { kind: "raw", content: "Human: hi\n\nAssistant: yo" } });

    const legacyUrl = await decodeRequest(jsonReq({ content: url }));
    assertEq("legacy JSON: a bare link → url fetch arm",
      legacyUrl, { ok: true, input: { kind: "url", url } });

    const legacyText = await decodeRequest(jsonReq({ content: "just some prose with no markers" }));
    assertEq("legacy JSON: non-link content stays the legacy arm",
      legacyText, { ok: true, legacy: "just some prose with no markers" });

    const structured = await decodeRequest(jsonReq({ source: { kind: "raw", content: url } }));
    assertEq("structured text-arm carrying a bare link → url fetch arm",
      structured, { ok: true, input: { kind: "url", url } });

    // [LAW:no-silent-failure] A multi-line transcript that merely BEGINS with a
    // link is NOT a bare link — isUrl rejects newlines — so it keeps its text arm.
    const startsWithLink = `${url}\n\n## User\nwhat is this?`;
    const multiline = await decodeRequest(formReq({ source: "markdown", content: startsWithLink }));
    assertEq("multi-line content beginning with a link stays a text arm (not reclassified)",
      multiline, { ok: true, input: { kind: "markdown", content: startsWithLink } });

    // The claude-share form guard still fires for claude-share TEXT (no URL to
    // fetch) — a craftable wire SourceKind that the form dropdown never offers.
    const shareText = await decodeRequest(formReq({ source: "claude-share", content: "Human said something" }));
    assert("form-encoded claude-share with non-URL text fails loudly (no silent raw bubble)",
      !shareText.ok);

    // …but claude-share-as-content that IS a link is fetched, not refused.
    const shareUrl = "https://claude.ai/share/deadbeef";
    const shareLink = await decodeRequest(formReq({ source: "claude-share", content: shareUrl }));
    assertEq("a pasted claude.ai/share link is fetched even on the no-JS form",
      shareLink, { ok: true, input: { kind: "url", url: shareUrl } });
  }

  if (process.exitCode) {
    console.error("\nFAILED");
  } else {
    console.log("\nAll checks passed.");
  }
})();
