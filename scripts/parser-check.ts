// Quick parser sanity check. Run with: `node scripts/parser-check.ts`.
// Asserts the user's pasted CC example produces the expected sequence of
// turn kinds, plus regressions on the existing markdown-header format.
//
// No test framework — just throws on failure. Run before deploys to keep the
// parser honest as we add new sources.

import { parsePaste } from "../src/parser";
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

if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nAll checks passed.");
}
