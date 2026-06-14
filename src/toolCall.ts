// [LAW:one-source-of-truth] The condensed, one-line projection of a tool call —
// derived from the stored original, never a synthesized summary. A condensed row
// carries the ONE fact that distinguishes a call from its neighbors (which file,
// which command), pulled straight from the source args, plus a pass/fail status
// pulled straight from the source result. cbm.3 renders this model into a row;
// it does not re-decide which arg matters or whether the call errored.
//
// [LAW:one-way-deps] toolCall depends on dialogue (AssistantBlock) and types
// (ToolOutput); neither depends on toolCall.

import type { AssistantBlock } from "./dialogue";
import type { ToolOutput } from "./types";

// [LAW:dataflow-not-control-flow] [LAW:no-mode-explosion] The whole per-tool
// behavior lives in ONE table: tool name → the single arg key whose value
// identifies the call. Adding a tool is adding a row — no new code path, no
// per-tool branch. A tool ABSENT from the table is not an error: it falls through
// the one NAMED fallback below (primaryArgValue → null = render name-only).
export const TOOL_PRIMARY_ARG: { readonly [tool: string]: string } = {
  Edit: "file_path",
  Write: "file_path",
  Read: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Bash: "command",
  Grep: "pattern",
  Glob: "pattern",
  Task: "description",
  WebFetch: "url",
  WebSearch: "query",
};

// Parse args as a JSON object, or null if it is not one. A jsonl tool call stores
// its args as serialized JSON; a cc/claude-share tool call stores raw text. This
// is the one place that classifies which shape we hold.
// [LAW:no-silent-failure] The catch is NOT swallowing a failure — "args is not
// JSON" is a legitimate, expected outcome (cc/share), routed to the raw-text
// branch below. It never hides a broken state behind a default.
const parseJsonObject = (s: string): { readonly [k: string]: unknown } | null => {
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as { readonly [k: string]: unknown })
      : null;
  } catch {
    return null;
  }
};

const stringifyValue = (v: unknown): string =>
  typeof v === "string" ? v : JSON.stringify(v);

// Collapse to a single line: runs of whitespace (including the newlines in
// pretty-printed JSON or a multi-line command) become one space. Pixel-width
// truncation is the renderer's concern (CSS ellipsis); this only guarantees the
// value is line-SHAPED.
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// The condensed value of a tool call's args, or null to fall back to name-only.
// A total function over the three honest shapes of `args`, each its own outcome —
// not a mode flag, but the parsed data discriminating its own case:
//   • tool absent from table        → null  (NAMED name-only fallback)
//   • args is raw text (cc/share)   → the text verbatim, ALREADY the source's
//                                     condensed form
//   • args is JSON for a table tool → the primary key's value, or null when that
//                                     key is absent/empty — NEVER the raw JSON
//                                     blob, which is neither a real value nor the
//                                     name-only fallback. [LAW:no-silent-failure]
//                                     the shown value is real source data or it is
//                                     nothing; a synthesized blob is the drift the
//                                     ticket forbids.
export const primaryArgValue = (tool: string, args: string): string | null => {
  const key = TOOL_PRIMARY_ARG[tool];
  if (key === undefined) return null;
  const obj = parseJsonObject(args);
  if (obj === null) return oneLine(args);
  const value = obj[key];
  if (value === undefined || value === null) return null;
  return oneLine(stringifyValue(value));
};

// [LAW:types-are-the-program] The three honest display states of a tool call's
// result, exhaustively. `no-result` is the absence of a result (output null),
// distinct from a result that passed or failed — so the renderer shows no badge,
// a pass badge, or a fail badge with no fourth ambiguous case.
export type ToolStatus = "no-result" | "ok" | "error";

const toolStatus = (output: ToolOutput | null): ToolStatus =>
  output === null ? "no-result" : output.isError ? "error" : "ok";

// [LAW:types-are-the-program] The rendered condensed line as DATA: the tool name,
// its one identifying value (null = unknown tool, render name-only), and its
// pass/fail status. The icon and badge GLYPHS are the renderer's styling concern
// (cbm.3); the facts that drive them are fixed here.
export interface CondensedToolCall {
  readonly tool: string;
  readonly primaryArg: string | null;
  readonly status: ToolStatus;
}

export const condenseToolCall = (
  block: Extract<AssistantBlock, { kind: "tool-call" }>,
): CondensedToolCall => ({
  tool: block.tool,
  primaryArg: primaryArgValue(block.tool, block.args),
  status: toolStatus(block.output),
});
