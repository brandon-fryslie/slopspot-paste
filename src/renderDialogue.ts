// [LAW:single-enforcer] The progressive-disclosure renderer: the one path that
// turns the derived nested model (a Dialogue — see dialogue.ts) into HTML. The
// permalink page renders it via set:html; the editor preview renders it through
// the same function (store.previewHtml), so the two surfaces render through one
// component and cannot drift. There is no second renderer.
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
// back on it. The shared tool-output body lives in render.ts, so this is the sole
// renderer — the flat Turn renderer it replaced (renderTurns.ts) is gone.

import type { AssistantBlock, ViewableDialogue } from "./dialogue";
import { turnAnchorId, spineNodeLabel, plainView } from "./dialogue";
import type { Role, Usage } from "./types";
import { condenseToolCall, type ToolStatus } from "./toolCall";
import { escapeHtml, escapeAttr, renderMarkdown, toolOutputHtml } from "./render";

// The spine carries only the two non-assistant roles as spoken nodes (assistant
// speech is the interleaved `assistant` arm, not a spoken node). This is the one
// role-label vocabulary in the codebase — the flat renderer that once held a
// second copy is gone.
const SPOKEN_LABEL: { readonly [R in Exclude<Role, "assistant">]: string } = {
  user: "User",
  system: "System",
};

const roleHeader = (role: Role, label: string): string =>
  `<div class="bubble-role">` +
  `<span class="role-dot role-dot-${role}" aria-hidden="true"></span>` +
  `<span class="role-name">${label}</span>` +
  `</div>`;

// [LAW:dataflow-not-control-flow] Spine prose — spoken text, assistant text,
// insight — is wrapped so its body can be clamped to a default height with a
// bottom Expand toggle. The wrapper is INERT markup: the clamp class and the
// toggle are added by enhanceClampBlocks (the client capability in clampBlocks.ts)
// only for blocks that MEASURE as overflowing — a short block renders untouched,
// a no-JS viewer sees the full prose. The renderer never guesses overflow from
// text length; presence of the control is derived from rendered geometry at the
// client boundary.
//
// [LAW:no-silent-failure] The `clampable` flag is the seam that keeps the marker
// HONEST: it is true only for top-level spine prose, which is always laid out.
// A subagent transcript renders nested inside a collapsed <details>, so its prose
// would measure at zero height (a closed <details> isn't laid out) and cache as
// "fits" forever — the marker would claim a clamp it never delivers. Marking only
// always-visible prose removes that case by construction rather than papering it
// with a remeasure loop. [LAW:decomposition] Detail kinds (thinking, tool-call,
// subagent) are NOT clampable anyway: they already collapse behind disclosure.
const clampableBody = (leadingClass: string, content: string, clampable: boolean): string =>
  clampable
    ? `<div class="${leadingClass} clampable">` +
      `<div class="clamp-content">${renderMarkdown(content)}</div>` +
      `</div>`
    : `<div class="${leadingClass}">${renderMarkdown(content)}</div>`;

// [LAW:types-are-the-program] The spine-node chrome, shared by every top-level node. It
// carries the ONE navigational contract the page's minimap reads (`:scope > [data-index]`)
// and the permalink anchor: data-index/data-kind/data-role/data-topic + the `id="t<index>"`.
// data-topic is the node's derived label (spineNodeLabel) — the SAME text the static topic
// outline shows, so the marker and the outline row name a turn identically. Only top-level
// spine nodes carry these; nested detail blocks and subagent transcripts do not.
//
// [LAW:one-type-per-behavior] A shown node is an <article>; a COLLAPSED node is a native
// <details> WEARING THE SAME attrs — so a folded turn stays navigable and keeps its single
// t<N> id (the id lives on the wrapper, never duplicated onto a nested article), and the
// browser owns the fold with no client timing [LAW:no-ambient-temporal-coupling], exactly as
// the detail blocks do. The summary shows the node's label so the reader sees WHAT is folded.
const spineNode = (
  bubbleClass: string,
  role: Role,
  index: number,
  collapsed: boolean,
  anchorAttr: string,
  topicAttr: string,
  label: string,
  inner: string,
): string => {
  const attrs = `data-kind="message" data-role="${role}" data-index="${index}"${topicAttr}${anchorAttr}`;
  return collapsed
    ? `<details class="${bubbleClass} collapsed-turn" ${attrs}>` +
      `<summary class="collapsed-turn-summary">` +
      `<span class="collapsed-turn-label">${escapeHtml(label)}</span>` +
      `<span class="condensed-caret" aria-hidden="true">▸</span>` +
      `</summary>` +
      `<div class="collapsed-turn-body">${inner}</div>` +
      `</details>`
    : `<article class="${bubbleClass}" ${attrs}>${inner}</article>`;
};

// Assistant TEXT and INSIGHT are spine: always-visible prose inside the turn.
const textHtml = (content: string, clampable: boolean): string =>
  clampableBody("assistant-text bubble-body", content, clampable);

const insightHtml = (content: string, clampable: boolean): string =>
  `<div class="assistant-insight" data-kind="insight">` +
  `<span class="insight-mark" aria-hidden="true">★</span>` +
  clampableBody("bubble-body", content, clampable) +
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

// [LAW:one-type-per-behavior] A subagent is a detail row like any other — same
// condensedRow shape as thinking/tool-call — differing only in its summary and
// body. The summary is glanceable: agent type, the short description, and the
// source's own step count. The body is the run itself.
// [LAW:one-source-of-truth] The captured body renders through renderDialogueHtml
// — the SAME function, one level nested — so a subagent transcript is drawn by
// the exact renderer the outer conversation uses, at any depth.
const subagentSummary = (
  block: Extract<AssistantBlock, { kind: "subagent" }>,
): string => {
  const type = block.agentType
    ? `<span class="subagent-type">${escapeHtml(block.agentType)}</span>`
    : "";
  const desc = block.description
    ? `<span class="condensed-arg">${escapeHtml(block.description)}</span>`
    : "";
  // [LAW:dataflow-not-control-flow] The step count is a value gate, not a branch
  // that builds a different row: 0 (source carried no count) renders no chip,
  // any positive count renders one. Pluralization is a value too.
  const steps =
    block.stepCount > 0
      ? `<span class="subagent-steps">${block.stepCount} ${block.stepCount === 1 ? "step" : "steps"}</span>`
      : "";
  return (
    `<span class="condensed-icon subagent-icon" aria-hidden="true">↳</span>` +
    `<span class="condensed-label">Subagent</span>` +
    type +
    desc +
    steps
  );
};

// [LAW:no-silent-failure] The degraded body is HONEST about the gap: it names
// that the nested transcript was not captured and shows exactly what the source
// still holds (the spawn prompt and the final result), rather than pretending the
// run is empty. data-subagent-degraded is the seam cbm.7's backfill button reads
// to offer "copy a prompt for an agent to send the missing files".
const subagentDegradedHtml = (prompt: string, result: string): string =>
  `<div class="subagent-degraded" data-subagent-degraded="true">` +
  `<p class="subagent-degraded-note">Nested transcript not captured for this subagent.</p>` +
  `<div class="subagent-field subagent-prompt">` +
  `<div class="bubble-role"><span class="role-name">Prompt</span></div>` +
  `<div class="bubble-body">${renderMarkdown(prompt)}</div>` +
  `</div>` +
  `<div class="subagent-field subagent-result">` +
  `<div class="bubble-role"><span class="role-name">Result</span></div>` +
  `<div class="bubble-body">${renderMarkdown(result)}</div>` +
  `</div>` +
  // [LAW:effects-at-boundaries] The button is inert markup; the page's client
  // script (permalink only — degraded subagents never reach the editor preview)
  // builds the slug-keyed backfill prompt from location and wires the clipboard.
  // It stays hidden until that script confirms clipboard support, like copy-code.
  `<button type="button" class="copy-agent-prompt" data-copy-agent-prompt>` +
  `Copy a prompt to backfill this transcript` +
  `</button>` +
  `</div>`;

const subagentHtml = (
  block: Extract<AssistantBlock, { kind: "subagent" }>,
): string => {
  const body =
    block.body.kind === "captured"
      ? // [LAW:no-silent-failure] topLevel=false: this render is nested. Its prose
        // must NOT be marked clampable (a closed <details> measures at zero height
        // and would never clamp), AND its spine nodes must carry no permalink id
        // (they would repeat t0,t1,… and collide with the outer conversation). Both
        // fall out of the one nested fact. The plain nested transcript is lifted to
        // the renderer's ViewableDialogue via plainView — never overlay-targeted, so
        // every node is shown at its positional index.
        `<div class="subagent-transcript">${renderDialogueHtml(plainView(block.body.transcript), false)}</div>`
      : subagentDegradedHtml(block.body.prompt, block.body.result);
  const attrs = block.agentType ? ` data-agent-type="${escapeAttr(block.agentType)}"` : "";
  return condensedRow("subagent", attrs, subagentSummary(block), body);
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
// fields that kind carries. The switch is exhaustive over AssistantBlock — adding
// a block arm stops compiling until it is handled here. The `subagent` arm renders
// one level nested through the SAME function (renderDialogueHtml), lifting the plain
// nested transcript through plainView (it is never overlay-targeted, so every node
// is shown at its positional index). The usage fold is threaded by closure so a
// usage block reads the running total accumulated by the blocks before it; a nested
// subagent transcript folds its OWN total because it renders through a fresh call
// (cumulativeOutput resets).
//
// [LAW:types-are-the-program] The input is a ViewableDialogue — each node paired with
// its ORIGINAL spine index and fold state (dialogue.ts). Reading the anchor off that
// carried `index` (never the array position) is what lets an overlay OMIT nodes
// (feature) without renumbering the survivors: a filtered projection keeps every
// permalink stable [LAW:one-source-of-truth]. This subsumes the old positional
// baseIndex — the single-turn card now passes a one-element view whose node still
// carries its true index, so a sliced render keeps its `id="t<N>"` with no offset arg.
//
// [LAW:one-source-of-truth] `topLevel` defaults true for the outer render (the
// permalink page and the editor preview). subagentHtml re-enters false, so depth is
// not a number — the one fact that matters is "is this the outer render". A permalink
// `id` is emitted only at top level, so a nested transcript's nodes (which would
// repeat t0,t1,…) carry no id at all — duplicate DOM ids are unrepresentable, never
// minted rather than deduped. Prose is clampable only when it is always laid out:
// top-level AND not folded — a closed <details> measures at zero height, so a
// collapsed turn's prose (like a nested transcript's) must not carry the clamp marker.
const renderDialogueHtml = (view: ViewableDialogue, topLevel: boolean = true): string => {
  // Usage is a running fold scoped to THIS dialogue — a nested subagent transcript
  // (cbm.4) folds its own total, since it renders through a fresh call below.
  let cumulativeOutput = 0;

  const renderBlock = (block: AssistantBlock, clampable: boolean): string => {
    switch (block.kind) {
      case "text":
        return textHtml(block.content, clampable);
      case "insight":
        return insightHtml(block.content, clampable);
      case "thinking":
        return thinkingHtml(block.content);
      case "tool-call":
        return toolCallHtml(block);
      case "subagent":
        return subagentHtml(block);
      case "turn-summary":
        return turnSummaryHtml(block.text);
      case "usage":
        cumulativeOutput += block.usage.output;
        return usageHtml(block.usage, cumulativeOutput);
    }
  };

  return view
    .map(({ index, node, collapsed }) => {
      const clampable = topLevel && !collapsed;
      const anchorAttr = topLevel ? ` id="${turnAnchorId(index)}"` : "";
      // [LAW:one-source-of-truth] The label the outline and the minimap both show,
      // carried on the node as data — derived once here from the node's own text.
      const label = spineNodeLabel(node);
      const topicAttr = ` data-topic="${escapeAttr(label)}"`;
      // [LAW:dataflow-not-control-flow] The two node kinds differ only in three values —
      // the bubble class, the data-role, and the inner HTML — which the shared spineNode
      // chrome then wraps identically (article, or <details> when folded).
      const { bubbleClass, role, inner } =
        node.kind === "spoken"
          ? {
              bubbleClass: `bubble bubble-${node.role}`,
              role: node.role as Role,
              inner: roleHeader(node.role, SPOKEN_LABEL[node.role]) + clampableBody("bubble-body", node.content, clampable),
            }
          : {
              bubbleClass: "bubble bubble-assistant assistant-turn",
              role: "assistant" as Role,
              inner:
                roleHeader("assistant", "Assistant") +
                `<div class="assistant-blocks">${node.blocks.map((b) => renderBlock(b, clampable)).join("")}</div>`,
            };
      return spineNode(bubbleClass, role, index, collapsed, anchorAttr, topicAttr, label, inner);
    })
    .join("");
};

export { renderDialogueHtml };
