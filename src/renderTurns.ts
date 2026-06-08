// [LAW:one-source-of-truth] The sole Turn[] -> HTML renderer. The permalink page
// renders it via set:html; the live block-editor preview calls the same function.
// A second renderer would let preview and permalink drift, so the markup the five
// deleted .astro components used to emit lives here, once.
//
// [LAW:dataflow-not-control-flow] One dispatch on turn.kind; each arm emits exactly
// the fields that kind carries. Illegal turns (a tool-call without a tool) are not
// representable in the Turn union, so there are no defensive guards.

import type { Role, Turn } from "./types";
import {
  escapeHtml,
  escapeAttr,
  renderMarkdown,
  parseDiff,
  parseFileRead,
  formatBashTerminal,
  type DiffLine,
} from "./render";

const roleLabel: Record<Role, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

const messageHtml = (role: Role, content: string, index: number): string =>
  `<article class="bubble bubble-${role}" data-kind="message" data-role="${role}" data-index="${index}">` +
  `<header class="bubble-role">` +
  `<span class="role-dot role-dot-${role}" aria-hidden="true"></span>` +
  `<span class="role-name">${roleLabel[role]}</span>` +
  `</header>` +
  `<div class="bubble-body">${renderMarkdown(content)}</div>` +
  `</article>`;

const insightHtml = (content: string, index: number): string =>
  `<article class="bubble bubble-insight" data-kind="insight" data-index="${index}">` +
  `<header class="bubble-role">` +
  `<span class="role-dot role-dot-insight" aria-hidden="true">★</span>` +
  `<span class="role-name">Insight</span>` +
  `</header>` +
  `<div class="bubble-body">${renderMarkdown(content)}</div>` +
  `</article>`;

const turnSummaryHtml = (text: string, index: number): string =>
  `<aside class="bubble-turn-summary" data-kind="turn-summary" data-index="${index}">` +
  `<span>${escapeHtml(text)}</span>` +
  `</aside>`;

const diffMarker = (kind: DiffLine["kind"]): string =>
  kind === "added" || kind === "cont-added"
    ? "+"
    : kind === "removed" || kind === "cont-removed"
      ? "-"
      : " ";

const diffRows = (text: string): string => {
  const { summary, lines } = parseDiff(text);
  const pill = summary
    ? `<span class="output-kind-pill" aria-hidden="true">${escapeHtml(summary)}</span>`
    : "";
  const rows = lines
    .map(
      (line) =>
        `<div class="diff-line diff-${line.kind}">` +
        `<span class="diff-lineno">${line.lineNo ?? ""}</span>` +
        `<span class="diff-marker" aria-hidden="true">${diffMarker(line.kind)}</span>` +
        `<span class="diff-content">${escapeHtml(line.content)}</span>` +
        `</div>`,
    )
    .join("");
  return (
    `<figure class="tool-output-frame" data-output-kind="diff">` +
    pill +
    `<div class="diff-block">${rows}</div>` +
    `</figure>`
  );
};

const fileRows = (text: string): string => {
  const { summary, lines } = parseFileRead(text);
  const pill = summary
    ? `<span class="output-kind-pill" aria-hidden="true">${escapeHtml(summary)}</span>`
    : "";
  const rows = lines
    .map(
      (line) =>
        `<div class="file-line">` +
        `<span class="file-lineno">${line.lineNo ?? ""}</span>` +
        `<span class="file-content">${escapeHtml(line.content)}</span>` +
        `</div>`,
    )
    .join("");
  return (
    `<figure class="tool-output-frame" data-output-kind="file-read">` +
    pill +
    `<div class="file-block">${rows}</div>` +
    `</figure>`
  );
};

const codeFrame = (outputKind: string, pill: string, text: string): string =>
  `<figure class="tool-output-frame" data-output-kind="${outputKind}">` +
  `<span class="output-kind-pill" aria-hidden="true">${pill}</span>` +
  `<pre class="code-block tool-output"><code>${escapeHtml(text)}</code></pre>` +
  `</figure>`;

const toolCallHtml = (
  tool: string,
  args: string,
  output: Extract<Turn, { kind: "tool-call" }>["output"],
  index: number,
): string => {
  const kind = output?.kind ?? "generic";
  const hasArgs = args.trim().length > 0;
  const showHeaderArgs = (kind === "diff" || kind === "file-read") && hasArgs;

  const header =
    `<header class="tool-header">` +
    `<span class="tool-arrow" aria-hidden="true">▸</span>` +
    `<span class="tool-name">${escapeHtml(tool)}</span>` +
    (showHeaderArgs ? `<span class="tool-path">${escapeHtml(args.trim())}</span>` : "") +
    `</header>`;

  // [LAW:dataflow-not-control-flow] The body is the output value's shape: each
  // ToolOutputKind maps to exactly one frame. generic-with-args is the only
  // case that emits two frames (an args block + the output block).
  const body =
    kind === "generic" && hasArgs ? codeFrame("args", "args", args) : "";

  const outputFrame =
    output === null
      ? ""
      : kind === "terminal"
        ? codeFrame("terminal", "terminal", formatBashTerminal(args, output.text))
        : kind === "diff"
          ? diffRows(output.text)
          : kind === "file-read"
            ? fileRows(output.text)
            : codeFrame("generic", "output", output.text);

  return (
    `<article class="bubble bubble-tool-call" data-kind="tool-call" data-tool="${escapeAttr(tool)}" data-index="${index}">` +
    header +
    body +
    outputFrame +
    `</article>`
  );
};

const renderTurn = (turn: Turn, index: number): string => {
  switch (turn.kind) {
    case "message":
      return messageHtml(turn.role, turn.content, index);
    case "insight":
      return insightHtml(turn.content, index);
    case "turn-summary":
      return turnSummaryHtml(turn.text, index);
    case "tool-call":
      return toolCallHtml(turn.tool, turn.args, turn.output, index);
  }
};

export const renderTurnsHtml = (turns: ReadonlyArray<Turn>): string =>
  turns.map(renderTurn).join("");
