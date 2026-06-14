// [LAW:one-source-of-truth] The sole Turn[] -> HTML renderer. The permalink page
// renders it via set:html; the live block-editor preview calls the same function.
// A second renderer would let preview and permalink drift, so the markup the five
// deleted .astro components used to emit lives here, once.
//
// [LAW:dataflow-not-control-flow] One dispatch on turn.kind; each arm emits exactly
// the fields that kind carries. Illegal turns (a tool-call without a tool) are not
// representable in the Turn union, so there are no defensive guards.

import type { Role, Turn, Usage } from "./types";
import {
  escapeHtml,
  escapeAttr,
  renderMarkdown,
  toolOutputHtml,
} from "./render";

const roleLabel: Record<Role, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

// [LAW:dataflow-not-control-flow] Collapsed-by-default is a VALUE, not a branch.
// Adding a kind here is a data change; no renderer changes. [LAW:one-type-per-behavior]
const COLLAPSED_BY_DEFAULT = new Set(["thinking"]);

// Returns "" for collapsed-by-default (no open attribute), " open" for others.
const openAttr = (kind: string): string =>
  COLLAPSED_BY_DEFAULT.has(kind) ? "" : " open";

const messageHtml = (role: Role, content: string, index: number): string =>
  `<details class="bubble bubble-${role}" data-kind="message" data-role="${role}" data-index="${index}"${openAttr("message")}>` +
  `<summary class="bubble-role bubble-summary">` +
  `<span class="role-dot role-dot-${role}" aria-hidden="true"></span>` +
  `<span class="role-name">${roleLabel[role]}</span>` +
  `</summary>` +
  `<div class="bubble-body">${renderMarkdown(content)}</div>` +
  `</details>`;

const insightHtml = (content: string, index: number): string =>
  `<details class="bubble bubble-insight" data-kind="insight" data-index="${index}"${openAttr("insight")}>` +
  `<summary class="bubble-role bubble-summary">` +
  `<span class="role-dot role-dot-insight" aria-hidden="true">★</span>` +
  `<span class="role-name">Insight</span>` +
  `</summary>` +
  `<div class="bubble-body">${renderMarkdown(content)}</div>` +
  `</details>`;

// [LAW:no-ambient-temporal-coupling] The browser's native <details>/<summary>
// owns the open/closed lifecycle — no client script, no timing authority.
// Collapsed-by-default is the absence of the `open` attribute, driven by
// COLLAPSED_BY_DEFAULT above. [LAW:dataflow-not-control-flow]
const thinkingHtml = (content: string, index: number): string =>
  `<details class="bubble bubble-thinking" data-kind="thinking" data-index="${index}"${openAttr("thinking")}>` +
  `<summary class="bubble-role bubble-summary thinking-summary">` +
  `<span class="role-dot role-dot-thinking" aria-hidden="true">✻</span>` +
  `<span class="role-name">Thinking</span>` +
  `</summary>` +
  `<div class="bubble-body">${renderMarkdown(content)}</div>` +
  `</details>`;

const turnSummaryHtml = (text: string, index: number): string =>
  `<aside class="bubble-turn-summary" data-kind="turn-summary" data-index="${index}">` +
  `<span>${escapeHtml(text)}</span>` +
  `</aside>`;

const groupThousands = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// [LAW:no-silent-failure] A usage line is rendered ONLY where the source gave
// us a usage Turn — there is no zero-fallback bubble for messages or sources
// without token data. `self` is this message's generated tokens; `cumulative`
// is the running total of generated tokens up to and including it (the renderer
// folds it — see renderTurnsHtml). The full breakdown rides in the title so the
// inline line stays a single legible figure. No data-index: usage is metadata
// attached to the message above it, not a navigable turn, so the minimap (which
// selects `[data-index]`) correctly skips it.
const usageHtml = (usage: Usage, cumulative: number): string => {
  const breakdown =
    `input ${groupThousands(usage.input)} · ` +
    `cache read ${groupThousands(usage.cacheRead)} · ` +
    `cache write ${groupThousands(usage.cacheCreation)} · ` +
    `output ${groupThousands(usage.output)}`;
  return (
    `<aside class="bubble-usage" data-kind="usage" title="${escapeAttr(breakdown)}">` +
    `<span class="usage-self">${groupThousands(usage.output)} tokens</span>` +
    `<span class="usage-total">${groupThousands(cumulative)} total</span>` +
    `</aside>`
  );
};

const toolCallHtml = (
  tool: string,
  args: string,
  output: Extract<Turn, { kind: "tool-call" }>["output"],
  index: number,
): string => {
  const kind = output?.kind ?? "generic";
  const hasArgs = args.trim().length > 0;
  const showHeaderArgs = (kind === "diff" || kind === "file-read") && hasArgs;

  return (
    `<details class="bubble bubble-tool-call" data-kind="tool-call" data-tool="${escapeAttr(tool)}" data-index="${index}"${openAttr("tool-call")}>` +
    `<summary class="tool-header tool-summary">` +
    `<span class="tool-arrow" aria-hidden="true">▸</span>` +
    `<span class="tool-name">${escapeHtml(tool)}</span>` +
    (showHeaderArgs ? `<span class="tool-path">${escapeHtml(args.trim())}</span>` : "") +
    `</summary>` +
    toolOutputHtml(args, output) +
    `</details>`
  );
};

// [LAW:dataflow-not-control-flow] Renders every turn kind EXCEPT usage, whose
// display needs the running total the bare turn doesn't carry. Typing the
// parameter to exclude usage keeps this switch exhaustive over content turns
// while making "renderTurn never sees a usage turn" a compile-time fact rather
// than a convention — renderTurnsHtml owns the usage arm.
const renderTurn = (
  turn: Exclude<Turn, { kind: "usage" }>,
  index: number,
): string => {
  switch (turn.kind) {
    case "message":
      return messageHtml(turn.role, turn.content, index);
    case "insight":
      return insightHtml(turn.content, index);
    case "thinking":
      return thinkingHtml(turn.content, index);
    case "turn-summary":
      return turnSummaryHtml(turn.text, index);
    case "tool-call":
      return toolCallHtml(turn.tool, turn.args, turn.output, index);
  }
};

// [LAW:dataflow-not-control-flow] A fold, not a map: the running token total is
// a value threaded across the stream, accumulated on each usage turn. Content
// turns keep their array-position index for data-index (usage turns leave gaps,
// which is fine — the minimap reads the data-index values that exist, not a
// contiguous range). Absence of usage turns ⇒ no token lines and a total that
// stays 0 unrendered, never a fabricated count. [LAW:no-silent-failure]
export const renderTurnsHtml = (turns: ReadonlyArray<Turn>): string => {
  let cumulativeOutput = 0;
  return turns
    .map((turn, index) => {
      if (turn.kind === "usage") {
        cumulativeOutput += turn.usage.output;
        return usageHtml(turn.usage, cumulativeOutput);
      }
      return renderTurn(turn, index);
    })
    .join("");
};
