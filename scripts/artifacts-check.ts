// Artifact extraction check (slopspot-code-export-i0g.2). extractArtifacts is a
// classifier, so the accept/reject SHAPE TABLE below is its spec [LAW:types-are-
// the-program]. Every row is asserted verbatim: the jsonl-shaped rows are built as
// inline Turn[] (args = JSON.stringify(input), exactly as jsonl.ts's argsAsText
// produces), and the FORMAT-reject + snippet rows are driven by the REAL captured
// claude-share fixtures through the real parser [LAW:behavior-not-structure].
//
// ─── THE ACCEPT / REJECT SHAPE TABLE (verbatim) ──────────────────────────────
// Turn kind -> contribution
//   message | thinking | insight            -> fenced code blocks in prose -> snippet
//   tool-call                               -> a file operation, or nothing
//   subagent (captured)                     -> RECURSE into the nested transcript
//   subagent (summary-only)                 -> nothing
//   turn-summary | usage                    -> nothing
//
// tool-call -> file operation
//   Write     {file_path, content:str}                    -> full(content)          ACCEPT
//   Read      {file_path} + non-null output               -> full(output.text)      ACCEPT
//   Read      {file_path} + null output                   -> (no content)           REJECT
//   Edit      {file_path, old_string, new_string}         -> diff([{old,new}])      ACCEPT
//   MultiEdit {file_path, edits:[{old_string,new_string}]}-> diff(edits)            ACCEPT
//   <file tool> args are RAW TEXT (parseJsonObject null)  -> (format boundary)      REJECT
//   <file tool> JSON, file_path missing/non-string/empty  -> (no honest path)       REJECT
//   Write     JSON, content missing/non-string            -> (no content)           REJECT
//   Edit      JSON, old_string/new_string missing          -> (no diff)              REJECT
//   NotebookEdit                                           -> (cell != file/diff)   REJECT
//   Bash | Grep | Glob | Task | ... | unknown tool         -> (not a file tool)      REJECT
//
// per-path aggregation (across every accepted op for one path)
//   >=1 full op (Write/Read)  -> full(LAST full snapshot in source order)
//   only diff ops             -> diff(all edits, source order)
//
// fenced block -> snippet
//   fenced ```lang, non-empty text  -> snippet(lang = first info word)   ACCEPT
//   fenced bare ```, non-empty text -> snippet(lang = null)              ACCEPT
//   fenced with empty text          -> (zero bytes)                      REJECT
//   indented (4-space) code block   -> (no fence)                        REJECT
//   4-space-indented w/ backticks   -> (indented, not fenced)            REJECT
//   inline codespan `x`             -> (not a block)                     REJECT
//
// output order: files first (first-seen path order), then snippets (source order).

import { readFileSync } from "node:fs";
import { extractArtifacts, type CodeArtifact, type FileContent } from "../src/artifacts";
import { parseClaudeShare } from "../src/parsers/claude-share";
import type { Turn, ToolOutput } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── Turn builders mirroring the two origins ───────────────────────────────────
// jsonl-origin tool call: args is serialized JSON (argsAsText in jsonl.ts).
const jsonTool = (tool: string, input: unknown, output: ToolOutput | null = null): Turn => ({
  kind: "tool-call",
  tool,
  args: JSON.stringify(input, null, 2),
  output,
});
// cc/claude-share-origin tool call: args is raw prose text.
const rawTool = (tool: string, args: string): Turn => ({ kind: "tool-call", tool, args, output: null });
const fileOut = (text: string): ToolOutput => ({ kind: "file-read", text, isError: false });
const msg = (content: string): Turn => ({ kind: "message", role: "assistant", content });

const files = (arts: ReadonlyArray<CodeArtifact>): ReadonlyArray<Extract<CodeArtifact, { kind: "file" }>> =>
  arts.filter((a): a is Extract<CodeArtifact, { kind: "file" }> => a.kind === "file");
const snippets = (arts: ReadonlyArray<CodeArtifact>): ReadonlyArray<Extract<CodeArtifact, { kind: "snippet" }>> =>
  arts.filter((a): a is Extract<CodeArtifact, { kind: "snippet" }> => a.kind === "snippet");
const fileAt = (arts: ReadonlyArray<CodeArtifact>, path: string): FileContent | null =>
  files(arts).find((f) => f.path === path)?.content ?? null;

// ══ FILE FIDELITY BY TOOL (boundary 1) ════════════════════════════════════════
console.log("\nArtifact extraction — file fidelity by tool (slopspot-code-export-i0g.2):");
{
  // ACCEPT: Write -> full(content).
  const w = extractArtifacts([jsonTool("Write", { file_path: "/a.ts", content: "const a = 1;\n" })]);
  const wc = fileAt(w, "/a.ts");
  assert(
    "Write {file_path,content} -> full(content)",
    wc !== null && wc.kind === "full" && wc.text === "const a = 1;\n",
  );

  // ACCEPT: Read -> full(output.text). Content is in the RESULT, never the args.
  const r = extractArtifacts([jsonTool("Read", { file_path: "/b.ts" }, fileOut("read body\n"))]);
  const rc = fileAt(r, "/b.ts");
  assert("Read {file_path} + output -> full(output.text)", rc !== null && rc.kind === "full" && rc.text === "read body\n");

  // ACCEPT: Read of an EMPTY file -> full(""). A real empty file is a genuine tree
  // node (unlike an empty fenced block, which is nothing to copy).
  const rEmpty = extractArtifacts([jsonTool("Read", { file_path: "/empty.ts" }, fileOut(""))]);
  const rEmptyC = fileAt(rEmpty, "/empty.ts");
  assert("Read with empty output -> full('') (real empty file)", rEmptyC !== null && rEmptyC.kind === "full" && rEmptyC.text === "");

  // REJECT: Read with NO captured output knows no content -> no file.
  const rNull = extractArtifacts([jsonTool("Read", { file_path: "/c.ts" }, null)]);
  assert("Read {file_path} + null output -> REJECT (no file)", files(rNull).length === 0);

  // ACCEPT: Edit -> diff-only, one old->new pair. NEVER a synthesized whole file.
  const e = extractArtifacts([jsonTool("Edit", { file_path: "/d.ts", old_string: "x", new_string: "y" })]);
  const ec = fileAt(e, "/d.ts");
  assert(
    "Edit {old_string,new_string} -> diff([{old,new}]) (never full)",
    ec !== null && ec.kind === "diff" && ec.edits.length === 1 && ec.edits[0]?.old === "x" && ec.edits[0]?.new === "y",
  );

  // ACCEPT: MultiEdit -> diff-only carrying every edit.
  const m = extractArtifacts([
    jsonTool("MultiEdit", {
      file_path: "/e.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    }),
  ]);
  const mc = fileAt(m, "/e.ts");
  assert(
    "MultiEdit {edits:[...]} -> diff(all edits, order preserved)",
    mc !== null && mc.kind === "diff" && mc.edits.length === 2 && mc.edits[1]?.new === "d",
  );
}

// ══ FILE REJECTS — malformed structured args ══════════════════════════════════
console.log("\nArtifact extraction — structured-args reject rows:");
{
  // REJECT: Write with no content — never fabricate content [LAW:no-silent-failure].
  assert(
    "Write JSON missing content -> REJECT",
    files(extractArtifacts([jsonTool("Write", { file_path: "/a.ts" })])).length === 0,
  );
  // REJECT: content present but non-string -> strField rejects, no fabricated file.
  assert(
    "Write JSON with non-string content -> REJECT",
    files(extractArtifacts([jsonTool("Write", { file_path: "/a.ts", content: 42 })])).length === 0,
  );
  // REJECT: file_path missing/non-string/empty -> no honest path.
  assert(
    "Write JSON missing file_path -> REJECT",
    files(extractArtifacts([jsonTool("Write", { content: "orphan" })])).length === 0,
  );
  assert(
    "Edit JSON with non-string file_path -> REJECT",
    files(extractArtifacts([jsonTool("Edit", { file_path: 42, old_string: "x", new_string: "y" })])).length === 0,
  );
  // REJECT: an empty-string file_path is a string but not a valid path — a pathless
  // file is nonsensical, so it must not slip past the path check.
  assert(
    "Write JSON with empty-string file_path -> REJECT",
    files(extractArtifacts([jsonTool("Write", { file_path: "", content: "x" })])).length === 0,
  );
  // REJECT: Edit missing a diff half -> no honest diff.
  assert(
    "Edit JSON missing new_string -> REJECT",
    files(extractArtifacts([jsonTool("Edit", { file_path: "/d.ts", old_string: "x" })])).length === 0,
  );
  // REJECT: MultiEdit with a malformed entry -> reject whole call (no partial diff).
  assert(
    "MultiEdit with a malformed edit entry -> REJECT (no partial diff)",
    files(extractArtifacts([jsonTool("MultiEdit", { file_path: "/e.ts", edits: [{ old_string: "a" }] })])).length === 0,
  );
  // REJECT: NotebookEdit — a single cell's new_source is neither a whole file nor
  // an old->new diff; representing it as either would fabricate.
  assert(
    "NotebookEdit -> REJECT (cell source is neither whole file nor diff)",
    files(extractArtifacts([jsonTool("NotebookEdit", { notebook_path: "/n.ipynb", new_source: "print(1)" })])).length === 0,
  );
  // REJECT: non-file tools and unknown tools produce no file artifact.
  assert(
    "Bash -> REJECT (not a file tool)",
    files(extractArtifacts([jsonTool("Bash", { command: "ls" })])).length === 0,
  );
  assert(
    "unknown tool -> REJECT (no file semantics)",
    files(extractArtifacts([jsonTool("Frobnicate", { file_path: "/x", content: "y" })])).length === 0,
  );
}

// ══ FILE FIDELITY BY FORMAT (boundary 2) — real claude-share fixtures ══════════
console.log("\nArtifact extraction — format boundary (real claude-share fixtures):");
{
  // A raw-text (claude-share) tool-call carries no structured args (parseJsonObject
  // -> null), so structured file extraction is impossible — a jsonl-only capability.
  const raw = extractArtifacts([rawTool("Write", "Wrote the config file")]);
  assert("raw-text 'Write' tool-call -> REJECT (format boundary, no file)", files(raw).length === 0);

  // The real captured fixture: every tool-call is condensed prose ("Ran a command",
  // "Viewed 9 files") — none yields a file artifact, no matter how many there are.
  const fixture = parseClaudeShare(readFileSync("test/fixtures/claude-share-tools-artifact.md", "utf8"));
  assert("claude-share tools fixture parses", fixture !== null);
  if (fixture) {
    const toolCalls = fixture.filter((t) => t.kind === "tool-call").length;
    assert("fixture has tool-calls to reject (guards a vacuous pass)", toolCalls > 0);
    assert(
      "no claude-share tool-call yields a file artifact (format boundary)",
      files(extractArtifacts(fixture)).length === 0,
    );
  }
}

// ══ PER-PATH AGGREGATION (boundary 1, across a transcript) ═════════════════════
console.log("\nArtifact extraction — per-path aggregation:");
{
  // A path with a Write base is full-content even if later Edited (base exists).
  const writeThenEdit = extractArtifacts([
    jsonTool("Write", { file_path: "/f.ts", content: "v1\n" }),
    jsonTool("Edit", { file_path: "/f.ts", old_string: "v1", new_string: "v2" }),
  ]);
  const wtc = fileAt(writeThenEdit, "/f.ts");
  assert(
    "Write then Edit same path -> full (base exists, diff not synthesized onto it)",
    wtc !== null && wtc.kind === "full" && wtc.text === "v1\n",
  );
  assert("aggregated path appears once, not per-op", files(writeThenEdit).length === 1);

  // Only-Edits path (no Write/Read base) -> diff-only, all edits in source order.
  const onlyEdits = extractArtifacts([
    jsonTool("Edit", { file_path: "/g.ts", old_string: "a", new_string: "b" }),
    jsonTool("Edit", { file_path: "/g.ts", old_string: "b", new_string: "c" }),
  ]);
  const gc = fileAt(onlyEdits, "/g.ts");
  assert(
    "only Edits (no base) -> diff(all edits, source order)",
    gc !== null && gc.kind === "diff" && gc.edits.length === 2 && gc.edits[0]?.old === "a" && gc.edits[1]?.new === "c",
  );

  // Two full snapshots on one path -> the LAST snapshot in source order wins.
  const twoFull = extractArtifacts([
    jsonTool("Read", { file_path: "/h.ts" }, fileOut("first\n")),
    jsonTool("Write", { file_path: "/h.ts", content: "second\n" }),
  ]);
  const hc = fileAt(twoFull, "/h.ts");
  assert("two full snapshots -> LAST wins", hc !== null && hc.kind === "full" && hc.text === "second\n");
}

// ══ SUBAGENT RECURSION ════════════════════════════════════════════════════════
console.log("\nArtifact extraction — subagent recursion:");
{
  const captured = extractArtifacts([
    msg("spawning"),
    {
      kind: "subagent",
      agentType: "general-purpose",
      description: "do work",
      stepCount: 1,
      transcript: {
        kind: "captured",
        turns: [jsonTool("Write", { file_path: "/nested.ts", content: "inner\n" })],
      },
    },
  ]);
  const nc = fileAt(captured, "/nested.ts");
  assert("captured subagent -> its files fold into the tree", nc !== null && nc.kind === "full" && nc.text === "inner\n");

  const summaryOnly = extractArtifacts([
    {
      kind: "subagent",
      agentType: null,
      description: null,
      stepCount: 0,
      transcript: { kind: "summary-only", prompt: "```ts\ncode()\n```", result: "done" },
    },
  ]);
  assert("summary-only subagent -> nothing (degraded capture)", summaryOnly.length === 0);
}

// ══ FENCED SNIPPETS (format-agnostic) ═════════════════════════════════════════
console.log("\nArtifact extraction — fenced snippets:");
{
  const langed = snippets(extractArtifacts([msg("intro\n\n```ts\nconst x = 1;\n```\n")]));
  assert("fenced ```lang -> snippet(lang=first word)", langed.length === 1 && langed[0]?.lang === "ts" && langed[0]?.text === "const x = 1;");

  const bare = snippets(extractArtifacts([msg("```\nplain\n```\n")]));
  assert("fenced bare ``` -> snippet(lang=null)", bare.length === 1 && bare[0]?.lang === null && bare[0]?.text === "plain");

  // REJECT: an empty fenced block is zero bytes -> not an artifact.
  assert("empty fenced block -> REJECT (no snippet)", snippets(extractArtifacts([msg("```ts\n```\n")])).length === 0);

  // REJECT: an indented (4-space) code block carries no fence.
  assert("indented code block -> REJECT (no fence)", snippets(extractArtifacts([msg("text\n\n    indented\n")])).length === 0);

  // REJECT: a 4-space-INDENTED block whose text contains backticks is still an
  // indented block per CommonMark (0–3 space fences only) — it must NOT become a
  // false snippet carrying literal ``` markers.
  const indentedBackticks = snippets(extractArtifacts([msg("    ```python\n    print(1)\n    ```")]));
  assert("4-space-indented block with backticks -> REJECT (not a fence)", indentedBackticks.length === 0);

  // ACCEPT boundary: a fence indented up to 3 spaces IS a valid opening fence.
  const threeSpaceFence = snippets(extractArtifacts([msg("   ```js\n   ok\n   ```")]));
  assert("3-space-indented fence -> ACCEPT (valid opening fence)", threeSpaceFence.length === 1 && threeSpaceFence[0]?.lang === "js");

  // REJECT: inline codespan is not a block.
  assert("inline codespan -> REJECT (not a block)", snippets(extractArtifacts([msg("use `x` inline")])).length === 0);

  // thinking and insight prose are snippet sources too.
  const think = snippets(extractArtifacts([{ kind: "thinking", content: "```py\nprint(1)\n```" } as Turn]));
  assert("thinking prose -> snippet", think.length === 1 && think[0]?.lang === "py");
  const insight = snippets(extractArtifacts([{ kind: "insight", content: "```sh\nls\n```" } as Turn]));
  assert("insight prose -> snippet", insight.length === 1 && insight[0]?.lang === "sh");

  // turn-summary and usage carry no authored code.
  const noneKinds = extractArtifacts([
    { kind: "turn-summary", text: "```ts\nx\n```" } as Turn,
    { kind: "usage", usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } } as Turn,
  ]);
  assert("turn-summary/usage -> nothing", noneKinds.length === 0);

  // Real fixture: fenced code in captured claude-share prose IS extracted (format-agnostic).
  const artifactFixture = parseClaudeShare(readFileSync("test/fixtures/claude-share-fenced-art.md", "utf8"));
  assert("fenced-art fixture parses", artifactFixture !== null);
  if (artifactFixture) {
    assert("fenced code in claude-share prose IS extracted (format-agnostic)", snippets(extractArtifacts(artifactFixture)).length > 0);
  }
}

// ══ OUTPUT ORDER ══════════════════════════════════════════════════════════════
console.log("\nArtifact extraction — output order:");
{
  const mixed = extractArtifacts([
    msg("```ts\nsnip1\n```"),
    jsonTool("Write", { file_path: "/z1.ts", content: "z1\n" }),
    jsonTool("Write", { file_path: "/z2.ts", content: "z2\n" }),
    msg("```ts\nsnip2\n```"),
  ]);
  assert("files come before snippets", mixed[0]?.kind === "file" && mixed[1]?.kind === "file");
  assert(
    "files in first-seen path order",
    mixed[0]?.kind === "file" && mixed[0].path === "/z1.ts" && mixed[1]?.kind === "file" && mixed[1].path === "/z2.ts",
  );
  const snips = snippets(mixed);
  assert("snippets in source order", snips.length === 2 && snips[0]?.text === "snip1" && snips[1]?.text === "snip2");
}

if (process.exitCode) {
  console.error("\nFAILED");
} else {
  console.log("\nAll artifact checks passed.");
}
