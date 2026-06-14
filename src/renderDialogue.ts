// [LAW:single-enforcer] The progressive-disclosure renderer: the one path that
// turns the derived nested model (a Dialogue — see dialogue.ts) into HTML. The
// permalink page renders it via set:html; cbm.5 points the editor preview at the
// same function, so the two surfaces render through one component and cannot drift.
//
// [LAW:dataflow-not-control-flow] Each node and block declares its own disclosure
// behavior by KIND — visibility is read from blockVisibility (a value), never a
// branch the renderer re-decides per block. Spine kinds (spoken, assistant text,
// insight) render always-visible; detail kinds (thinking, tool-call) render as a
// collapsed native <details> the browser owns; meta kinds (usage, turn-summary)
// render as always-visible annotations.
//
// [LAW:one-way-deps] renderDialogue depends on dialogue (the model), toolCall (the
// condensed projection), and render (shared body frames + escaping). None depend
// back on it. It does NOT depend on renderTurns — the shared tool-output body
// lives in render.ts, so this renderer never reaches into the flat renderer that
// cbm.5 retires.

import type { Dialogue, AssistantBlock } from "./dialogue";
import type { Role, Usage } from "./types";
import { condenseToolCall, type ToolStatus } from "./toolCall";
import { escapeHtml, escapeAttr, renderMarkdown, toolOutputHtml } from "./render";

// The spine carries only the two non-assistant roles as spoken nodes (assistant
// speech is the interleaved `assistant` arm, not a spoken node). A local label
// map keeps this renderer free of a dependency on the flat renderer; cbm.5
// unifies the role-label vocabulary when it deletes renderTurns.ts.
const SPOKEN_LABEL: { readonly [R in Exclude<Role, "assistant">]: string } = {
  user: "User",
  system: "System",
};

const roleHeader = (role: Role, label: string): string =>
  `<div class="bubble-role">` +
  `<span class="role-dot role-dot-${role}" aria-hidden="true"></span>` +
  `<span class="role-name">${label}</span>` +
  `</div>`;

// [LAW:types-are-the-program] A spoken node is always visible — it is the readable
// conversation, never collapsible. So it is a plain article, not a <details>: the
// "collapsed" state it would carry is unrepresentable, not merely defaulted-off.
// data-index/data-kind/data-role are the navigational contract the page's minimap
// reads (`:scope > [data-index]`); only top-level spine nodes carry them, so the
// minimap projects the conversation spine and skips the nested detail blocks.
const spokenHtml = (
  role: Exclude<Role, "assistant">,
  content: string,
  index: number,
): string =>
  `<article class="bubble bubble-${role}" data-kind="message" data-role="${role}" data-index="${index}">` +
  roleHeader(role, SPOKEN_LABEL[role]) +
  `<div class="bubble-body">${renderMarkdown(content)}</div>` +
  `</article>`;

// Assistant TEXT and INSIGHT are spine: always-visible prose inside the turn.
const textHtml = (content: string): string =>
  `<div class="assistant-text bubble-body">${renderMarkdown(content)}</div>`;

const insightHtml = (content: string): string =>
  `<div class="assistant-insight" data-kind="insight">` +
  `<span class="insight-mark" aria-hidden="true">★</span>` +
  `<div class="bubble-body">${renderMarkdown(content)}</div>` +
  `</div>`;

// [LAW:no-ambient-temporal-coupling] Every detail block is a native <details>:
// the browser owns the open/closed lifecycle — no client script, no timing
// authority. Collapsed-by-default is the ABSENCE of the `open` attribute. The
// caret on the summary rotates via CSS on [open]. [LAW:one-type-per-behavior]
// thinking, tool-call (and cbm.4's subagent) are all detail blocks and share this
// one condensed-row shape — they differ only in their summary content and body.
const condensedRow = (
  kind: string,
  attrs: string,
  summaryInner: string,
  body: string,
): string =>
  `<details class="condensed condensed-${kind}" data-kind="${kind}"${attrs}>` +
  `<summary class="condensed-summary">${summaryInner}` +
  `<span class="condensed-caret" aria-hidden="true">▸</span>` +
  `</summary>` +
  `<div class="condensed-body">${body}</div>` +
  `</details>`;

const thinkingHtml = (content: string): string =>
  condensedRow(
    "thinking",
    "",
    `<span class="condensed-icon" aria-hidden="true">✻</span>` +
      `<span class="condensed-label">Thinking</span>`,
    `<div class="bubble-body">${renderMarkdown(content)}</div>`,
  );

// [LAW:dataflow-not-control-flow] The status badge is a value mapped from the
// condensed call's status, not a branch: 'ok' and 'error' carry a glyph badge,
// 'no-result' carries the empty string (output was null → no badge), with no
// fourth ambiguous case.
const STATUS_BADGE: { readonly [S in ToolStatus]: string } = {
  ok: `<span class="tool-badge tool-badge-ok" aria-label="succeeded">✓</span>`,
  error: `<span class="tool-badge tool-badge-error" aria-label="failed">✕</span>`,
  "no-result": "",
};

// The condensed tool-call row: icon + tool name + primary arg + status badge.
// [LAW:one-source-of-truth] The row reads condenseToolCall — it does NOT re-decide
// which arg identifies the call or whether it errored. A null primaryArg renders
// NAME-ONLY (no arg span, never a raw JSON blob). The expanded body is the SAME
// toolOutputHtml the flat renderer emits, so the detail view cannot drift.
const toolCallHtml = (
  block: Extract<AssistantBlock, { kind: "tool-call" }>,
): string => {
  const { tool, primaryArg, status } = condenseToolCall(block);
  const arg =
    primaryArg === null
      ? ""
      : `<span class="condensed-arg">${escapeHtml(primaryArg)}</span>`;
  const summaryInner =
    `<span class="condensed-icon tool-icon" aria-hidden="true">❯</span>` +
    `<span class="condensed-label tool-name">${escapeHtml(tool)}</span>` +
    arg +
    STATUS_BADGE[status];
  return condensedRow(
    "tool-call",
    ` data-tool="${escapeAttr(tool)}"`,
    summaryInner,
    toolOutputHtml(block.args, block.output),
  );
};

const turnSummaryHtml = (text: string): string =>
  `<aside class="bubble-turn-summary" data-kind="turn-summary">` +
  `<span>${escapeHtml(text)}</span>` +
  `</aside>`;

const groupThousands = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// [LAW:no-silent-failure] A usage line renders only where the source carried a
// usage block; there is no zero-fallback. `cumulative` is the running output-token
// total folded across this dialogue's assistant blocks in source order.
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

// [LAW:dataflow-not-control-flow] One dispatch on block.kind; each arm emits the
// fields that kind carries. The switch is exhaustive over AssistantBlock — when
// cbm.4 adds the `subagent` arm (carrying a nested Dialogue), this stops compiling
// until the new arm renders `renderDialogueHtml(block.transcript)` one level
// nested through the SAME function. The usage fold is threaded by closure so a
// usage block reads the running total accumulated by the blocks before it.
const renderDialogueHtml = (dialogue: Dialogue): string => {
  // Usage is a running fold scoped to THIS dialogue — a nested subagent transcript
  // (cbm.4) folds its own total, since it renders through a fresh call below.
  let cumulativeOutput = 0;

  const renderBlock = (block: AssistantBlock): string => {
    switch (block.kind) {
      case "text":
        return textHtml(block.content);
      case "insight":
        return insightHtml(block.content);
      case "thinking":
        return thinkingHtml(block.content);
      case "tool-call":
        return toolCallHtml(block);
      case "turn-summary":
        return turnSummaryHtml(block.text);
      case "usage":
        cumulativeOutput += block.usage.output;
        return usageHtml(block.usage, cumulativeOutput);
    }
  };

  return dialogue
    .map((node, index) => {
      if (node.kind === "spoken") {
        return spokenHtml(node.role, node.content, index);
      }
      // The assistant turn is one always-visible card carrying its interleaved
      // blocks in source order. data-index marks it as one navigable spine node.
      return (
        `<article class="bubble bubble-assistant assistant-turn" data-kind="message" data-role="assistant" data-index="${index}">` +
        roleHeader("assistant", "Assistant") +
        `<div class="assistant-blocks">${node.blocks.map(renderBlock).join("")}</div>` +
        `</article>`
      );
    })
    .join("");
};

export { renderDialogueHtml };
