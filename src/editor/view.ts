// lit-html templates as pure functions of the store. No state lives here; every
// template is `state -> TemplateResult`. mount.ts runs `autorun(() =>
// render(appTemplate(store), root))`, so any observable a template reads
// re-renders it.
//
// [LAW:dataflow-not-control-flow] One card template dispatches on `turn.kind`;
// each arm emits exactly the fields that kind carries and, on edit, hands the
// store a freshly-narrowed Turn value. lit-html keyed `repeat` (by Block.id)
// reuses DOM nodes across edit + reorder — the acknowledged "last inch of UI"
// carve-out that preserves cursor focus during inline editing.

import { html, nothing, type TemplateResult } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import type { Platform, Role, SourceKind, ToolOutputKind, Turn } from "../types";
import { PLATFORMS, ROLES, SOURCE_LABEL, TOOL_OUTPUT_KINDS } from "../types";
import type { AuthorableTurn, Block, Kind } from "./blocks";
import { convertKind, KINDS } from "./blocks";
import type { EditorStore } from "./store";

const KIND_LABEL: Record<Kind, string> = {
  "message": "Message",
  "tool-call": "Tool call",
  "insight": "Insight",
  "thinking": "Thinking",
  "turn-summary": "Turn summary",
};

const ROLE_LABEL: Record<Role, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

// [LAW:no-silent-failure] Re-narrow a <select>'s string value back to its enum.
// Every option is rendered from the enum tuple, so the lookup never misses in
// practice — but if markup and enum ever diverge we throw, not silently coerce.
const asKind = (v: string): Kind => {
  const found = KINDS.find((k) => k === v);
  if (found === undefined) throw new Error(`unknown block kind: ${v}`);
  return found;
};

const asRole = (v: string): Role => {
  const found = ROLES.find((r) => r === v);
  if (found === undefined) throw new Error(`unknown role: ${v}`);
  return found;
};

const valueOf = (e: Event): string =>
  (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;

// [LAW:effects-at-boundaries] Reading the live caret is an irreducible DOM read —
// the acknowledged last-inch-of-UI carve-out. The split control sits in the
// kind-agnostic header, so from the clicked button it locates this card's primary
// text field (every kind tags exactly one `.primary-text`) and returns its caret
// offset. The store clamps, so a never-focused field's 0 is a valid edge split,
// not an error. [LAW:no-silent-failure] a card with no primary field throws.
const caretOffsetIn = (origin: HTMLElement): number => {
  const field = origin
    .closest(".block-card")
    ?.querySelector<HTMLTextAreaElement | HTMLInputElement>(".primary-text");
  if (field === null || field === undefined)
    throw new Error("block card has no .primary-text field");
  return field.selectionStart ?? field.value.length;
};

// ── Per-kind card bodies ────────────────────────────────────────────────────
// Each receives a turn already narrowed to its kind, so the new-turn value it
// builds on edit is checked by the compiler against that exact arm.

const messageBody = (
  store: EditorStore,
  id: string,
  turn: Extract<Turn, { kind: "message" }>,
): TemplateResult => html`
  <div class="block-fields">
    <select
      class="block-role"
      .value=${turn.role}
      @change=${(e: Event) => store.replaceTurn(id, { ...turn, role: asRole(valueOf(e)) })}
    >
      ${ROLES.map((r) => html`<option value=${r}>${ROLE_LABEL[r]}</option>`)}
    </select>
    <textarea
      class="block-content primary-text"
      rows="4"
      .value=${turn.content}
      @input=${(e: Event) => store.replaceTurn(id, { ...turn, content: valueOf(e) })}
    ></textarea>
  </div>
`;

// [LAW:one-type-per-behavior] insight and thinking edit identically — a single
// textarea over their shared `content` field. One body serves both; the kind
// rides through `...turn` so the new Turn keeps its own discriminator.
const contentBody = (
  store: EditorStore,
  id: string,
  turn: Extract<Turn, { kind: "insight" | "thinking" }>,
): TemplateResult => html`
  <div class="block-fields">
    <textarea
      class="block-content primary-text"
      rows="3"
      .value=${turn.content}
      @input=${(e: Event) => store.replaceTurn(id, { ...turn, content: valueOf(e) })}
    ></textarea>
  </div>
`;

const turnSummaryBody = (
  store: EditorStore,
  id: string,
  turn: Extract<Turn, { kind: "turn-summary" }>,
): TemplateResult => html`
  <div class="block-fields">
    <input
      class="block-summary primary-text"
      .value=${turn.text}
      @input=${(e: Event) => store.replaceTurn(id, { ...turn, text: valueOf(e) })}
    />
  </div>
`;

// [LAW:dataflow-not-control-flow] Output presence is a value transition: "No
// output" maps to null, any kind maps to an output carrying the existing text.
// The honest branch (null vs a kind) lives here, once.
const setOutputKind = (
  turn: Extract<Turn, { kind: "tool-call" }>,
  raw: string,
): AuthorableTurn => {
  if (raw === "none") return { ...turn, output: null };
  const kind = TOOL_OUTPUT_KINDS.find((k) => k === raw);
  if (kind === undefined) throw new Error(`unknown output kind: ${raw}`);
  // Authoring carries no error UI (out of scope); preserve an existing flag,
  // default false. [LAW:no-silent-failure] never fabricates an error state.
  return { ...turn, output: { kind, text: turn.output?.text ?? "", isError: turn.output?.isError ?? false } };
};

const OUTPUT_KIND_LABEL: Record<ToolOutputKind, string> = {
  terminal: "Terminal",
  "file-read": "File read",
  diff: "Diff",
  generic: "Generic",
};

const toolCallBody = (
  store: EditorStore,
  id: string,
  turn: Extract<Turn, { kind: "tool-call" }>,
): TemplateResult => {
  const output = turn.output;
  return html`
    <div class="block-fields">
      <input
        class="block-tool"
        placeholder="tool name"
        .value=${turn.tool}
        @input=${(e: Event) => store.replaceTurn(id, { ...turn, tool: valueOf(e) })}
      />
      <textarea
        class="block-args primary-text"
        rows="2"
        placeholder="args"
        .value=${turn.args}
        @input=${(e: Event) => store.replaceTurn(id, { ...turn, args: valueOf(e) })}
      ></textarea>
      <select
        class="block-out-kind"
        .value=${output?.kind ?? "none"}
        @change=${(e: Event) => store.replaceTurn(id, setOutputKind(turn, valueOf(e)))}
      >
        <option value="none">No output</option>
        ${TOOL_OUTPUT_KINDS.map((k) => html`<option value=${k}>${OUTPUT_KIND_LABEL[k]}</option>`)}
      </select>
      ${output === null
        ? nothing
        : html`<textarea
            class="block-out-text"
            rows="3"
            placeholder="output"
            .value=${output.text}
            @input=${(e: Event) =>
              store.replaceTurn(id, { ...turn, output: { ...output, text: valueOf(e) } })}
          ></textarea>`}
    </div>
  `;
};

const cardBody = (store: EditorStore, id: string, turn: AuthorableTurn): TemplateResult => {
  switch (turn.kind) {
    case "message":
      return messageBody(store, id, turn);
    case "insight":
      return contentBody(store, id, turn);
    case "thinking":
      return contentBody(store, id, turn);
    case "turn-summary":
      return turnSummaryBody(store, id, turn);
    case "tool-call":
      return toolCallBody(store, id, turn);
  }
};

const kindBadge = (store: EditorStore, id: string, turn: AuthorableTurn): TemplateResult => html`
  <select
    class="block-badge"
    .value=${turn.kind}
    @change=${(e: Event) => store.replaceTurn(id, convertKind(turn, asKind(valueOf(e))))}
  >
    ${KINDS.map((k) => html`<option value=${k}>${KIND_LABEL[k]}</option>`)}
  </select>
`;

// Drag-reorder: the ⠿ handle is the ONLY drag origin (the card itself is not
// draggable), so a mouse-drag inside a textarea selects text instead of seizing
// the card. The card is the drop target; moveBlock owns the index arithmetic.
const blockCard = (store: EditorStore, block: Block, index: number): TemplateResult => html`
  <article
    class="block-card"
    data-kind=${block.turn.kind}
    @dragover=${(e: DragEvent) => e.preventDefault()}
    @drop=${(e: DragEvent) => {
      e.preventDefault();
      store.moveBlock(Number(e.dataTransfer?.getData("text/plain")), index);
    }}
  >
    <header class="block-card-head">
      <span
        class="drag-handle"
        draggable="true"
        title="Drag to reorder"
        @dragstart=${(e: DragEvent) => e.dataTransfer?.setData("text/plain", String(index))}
        >⠿</span
      >
      ${kindBadge(store, block.id, block.turn)}
      <button
        class="block-act block-split"
        title="Split at cursor"
        @click=${(e: Event) => store.splitBlock(block.id, caretOffsetIn(e.currentTarget as HTMLElement))}
      >
        ✂
      </button>
      <button
        class="block-act block-merge"
        title="Merge into the block above"
        ?disabled=${index === 0}
        @click=${() => store.mergeBlocks(block.id)}
      >
        ↥
      </button>
      <button
        class="block-del"
        title="Delete block"
        @click=${() => store.deleteBlock(block.id)}
      >
        ✕
      </button>
    </header>
    ${cardBody(store, block.id, block.turn)}
  </article>
`;

const blockList = (store: EditorStore): TemplateResult => html`
  <div class="block-list">
    ${repeat(
      store.blocks,
      (block) => block.id,
      (block, index) => blockCard(store, block, index),
    )}
    <div class="add-row">
      ${KINDS.map(
        (k) => html`<button class="add-block" @click=${() => store.addBlock(k)}>+ ${KIND_LABEL[k]}</button>`,
      )}
    </div>
  </div>
`;

// ── Import box ──────────────────────────────────────────────────────────────

const asSourceKind = (store: EditorStore, v: string): SourceKind => {
  const found = store.detected.find((k) => k === v);
  if (found === undefined) throw new Error(`undetected source kind: ${v}`);
  return found;
};

// [LAW:no-silent-failure] Re-narrow a platform <select> value back to Platform.
// "" represents "Auto" (null override); any other value must be a Platform.
const parsePlatformSelect = (v: string): Platform | null => {
  if (v === "") return null;
  const found = PLATFORMS.find((p) => p === v);
  if (found === undefined) throw new Error(`unknown platform: ${v}`);
  return found;
};

const PLATFORM_DISPLAY: Record<Platform, string> = {
  "claude-web": "Claude",
  "claude-code": "Claude Code",
  "chatgpt": "ChatGPT",
  "generic": "Generic",
};

const importBox = (store: EditorStore): TemplateResult => html`
  <div class="import-box">
    <label class="visually-hidden" for="import-text">Conversation to import</label>
    <textarea
      id="import-text"
      class="import-text"
      rows="8"
      placeholder="Paste a transcript, then parse it into editable blocks."
      .value=${store.importText}
      @input=${(e: Event) => store.setImport(valueOf(e))}
    ></textarea>
    <div class="import-row">
      <select
        class="source-select"
        .value=${store.importKind}
        @change=${(e: Event) => store.setImportKind(asSourceKind(store, valueOf(e)))}
      >
        ${store.detected.map((k) => html`<option value=${k}>${SOURCE_LABEL[k]}</option>`)}
      </select>
      <button class="btn-secondary" ?disabled=${store.busy} @click=${() => store.ingest()}>
        ${store.isUrlImport
          ? store.busy
            ? "Fetching…"
            : "Fetch & parse"
          : "Parse into blocks"}
      </button>
    </div>
    ${store.importError === null
      ? nothing
      : html`<p class="form-error" role="alert">${store.importError}</p>`}
    ${reparseConfirm(store)}
  </div>
`;

// [LAW:no-silent-failure] The no-clobber gate. When a parse would overwrite
// hand-edited blocks, the store stages it (pendingReparse) instead of replacing;
// this strip is the explicit choice. No pending decision -> renders nothing, so
// the common path (first parse, or reparse of untouched blocks) is silent.
const reparseConfirm = (store: EditorStore): TemplateResult | typeof nothing => {
  if (store.pendingReparse === null) return nothing;
  const n = store.blocks.length;
  return html`
    <div class="reparse-confirm" role="alert">
      <span
        >Replace ${n} edited block${n === 1 ? "" : "s"}? This discards your changes.</span
      >
      <button class="btn-secondary" @click=${() => store.cancelReparse()}>Keep editing</button>
      <button class="btn-danger" @click=${() => store.confirmReparse()}>Replace</button>
    </div>
  `;
};

// ── Toolbar + preview ───────────────────────────────────────────────────────

const countsLabel = (counts: Record<Kind, number>): string => {
  const parts = KINDS.filter((k) => counts[k] > 0).map(
    (k) => `${counts[k]} ${KIND_LABEL[k].toLowerCase()}${counts[k] === 1 ? "" : "s"}`,
  );
  return parts.length === 0 ? "No blocks yet" : parts.join(" · ");
};

const platformSelect = (store: EditorStore): TemplateResult => html`
  <select
    class="source-select"
    .value=${store.userPlatform ?? ""}
    @change=${(e: Event) => store.setPlatform(parsePlatformSelect(valueOf(e)))}
  >
    <option value="">Theme: Auto</option>
    ${PLATFORMS.map((p) => html`<option value=${p}>${PLATFORM_DISPLAY[p]}</option>`)}
  </select>
`;

const toolbar = (store: EditorStore): TemplateResult => html`
  <div class="editor-toolbar">
    <div class="view-toggle" role="tablist">
      <button
        class="toggle ${store.view === "blocks" ? "active" : ""}"
        @click=${() => store.setView("blocks")}
      >
        Blocks
      </button>
      <button
        class="toggle ${store.view === "preview" ? "active" : ""}"
        @click=${() => store.setView("preview")}
      >
        Preview
      </button>
    </div>
    <span class="block-counts">${countsLabel(store.counts)}</span>
    ${platformSelect(store)}
    <button class="btn-primary" ?disabled=${!store.canSubmit} @click=${() => store.submit()}>
      ${store.busy ? "Sharing…" : "Share it"}
    </button>
    ${store.submitError === null
      ? nothing
      : html`<span class="form-error" role="alert">${store.submitError}</span>`}
  </div>
`;

// [LAW:one-source-of-truth] previewHtml comes from renderDialogueHtml — the SAME
// renderer the permalink uses (store derives the nested Dialogue first), so the
// preview shows the exact disclosure UI a reader sees. data-platform reads
// store.activePlatform:
// - Override: userPlatform === conversation.platformOverride by construction.
// - Auto: all three submitOrigin arms preserve source: sourceOf(importOrigin),
//   so sourceOf(submitOrigin) === sourceOf(importOrigin) and platformOf is equal.
// unsafeHTML is correct: that string is the renderer's own escaped output.
const previewPane = (store: EditorStore): TemplateResult => html`
  <section class="preview-pane bubbles" data-platform=${store.activePlatform}>
    ${unsafeHTML(store.previewHtml)}
  </section>
`;

export const appTemplate = (store: EditorStore): TemplateResult => html`
  <div class="editor">
    ${toolbar(store)}
    ${store.view === "blocks"
      ? html`${importBox(store)}${blockList(store)}`
      : previewPane(store)}
  </div>
`;
