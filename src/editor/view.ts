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
import type { InputKind, Platform, Role, ToolOutputKind, Turn } from "../types";
import { inputLabel, PLATFORMS, ROLES, TOOL_OUTPUT_KINDS } from "../types";
import { describeSecretKind } from "../secret-scan";
import { condenseToolCall, type ToolStatus } from "../toolCall";
import type { AuthorableTurn, Block, BlockGroup, Kind, NumberedBlock } from "./blocks";
import { convertKind, groupBlocks, KINDS } from "./blocks";
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
// kind-agnostic preview overlay, so from the clicked button it locates this
// block's primary text field via the data-block-id wrapper the preview marks
// (every kind tags exactly one `.primary-text`) and returns its caret offset.
// The store clamps, so a never-focused field's 0 is a valid edge split, not an
// error. [LAW:no-silent-failure] a block with no primary field throws.
const caretOffsetIn = (origin: HTMLElement): number => {
  const field = origin
    .closest("[data-block-id]")
    ?.querySelector<HTMLTextAreaElement | HTMLInputElement>(".primary-text");
  if (field === null || field === undefined)
    throw new Error("block has no .primary-text field");
  return field.selectionStart ?? field.value.length;
};

// [LAW:single-enforcer] The one drag protocol for block reordering in the
// preview. A custom MIME type marks a drag as a block drag: an OS file drag
// or a text drag from another window carries no such entry, so it neither
// unlocks the drop target (allowBlockDrop leaves the browser default) nor
// decodes to an index. Without the marker, an external drag's empty — or
// coincidentally numeric — text/plain payload would silently move a block.
// [LAW:no-silent-failure]
const BLOCK_DRAG_MIME = "application/x-slopspot-block";

const startBlockDrag = (e: DragEvent, index: number): void => {
  e.dataTransfer?.setData(BLOCK_DRAG_MIME, String(index));
};

// Accept a block drag only where a drop will actually act — over a marked block
// wrapper. The cursor affordance and dropOnBlock's outcome derive from the same
// [data-block-id] predicate, so the browser never shows an accepting cursor for
// a drop that would no-op (container gaps show the native not-allowed cursor).
const allowBlockDrop = (e: DragEvent): void => {
  if (
    e.dataTransfer?.types.includes(BLOCK_DRAG_MIME) === true &&
    e.target instanceof Element &&
    e.target.closest("[data-block-id]") !== null
  ) {
    e.preventDefault();
  }
};

// The dragged block's flat index, or null when the drag is not a block drag.
const draggedIndex = (e: DragEvent): number | null => {
  const raw = e.dataTransfer?.getData(BLOCK_DRAG_MIME) ?? "";
  return raw === "" ? null : Number(raw);
};

// ── Shared edit controls ────────────────────────────────────────────────────
// Each receives a turn already narrowed to its kind, so the new-turn value it
// builds on edit is checked by the compiler against that exact arm.

// [LAW:one-source-of-truth] The one role-editing control, hosted by the
// preview's per-block controls — one set of options, one re-narrowing, one
// store mutation.
const roleSelect = (
  store: EditorStore,
  id: string,
  turn: Extract<Turn, { kind: "message" }>,
): TemplateResult => html`
  <select
    class="block-role"
    @change=${(e: Event) => store.replaceTurn(id, { ...turn, role: asRole(valueOf(e)) })}
  >
    ${ROLES.map((r) => html`<option value=${r} ?selected=${r === turn.role}>${ROLE_LABEL[r]}</option>`)}
  </select>
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
        @change=${(e: Event) => store.replaceTurn(id, setOutputKind(turn, valueOf(e)))}
      >
        <option value="none" ?selected=${output === null}>No output</option>
        ${TOOL_OUTPUT_KINDS.map((k) => html`<option value=${k} ?selected=${k === output?.kind}>${OUTPUT_KIND_LABEL[k]}</option>`)}
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

const kindBadge = (store: EditorStore, id: string, turn: AuthorableTurn): TemplateResult => html`
  <select
    class="block-badge"
    @change=${(e: Event) => store.replaceTurn(id, convertKind(turn, asKind(valueOf(e))))}
  >
    ${KINDS.map((k) => html`<option value=${k} ?selected=${k === turn.kind}>${KIND_LABEL[k]}</option>`)}
  </select>
`;

// The preview's add-block row — one button per kind, one store.addBlock.
const addRow = (store: EditorStore): TemplateResult => html`
  <div class="add-row">
    ${KINDS.map(
      (k) => html`<button class="add-block" @click=${() => store.addBlock(k)}>+ ${KIND_LABEL[k]}</button>`,
    )}
  </div>
`;

// ── Source pane (Text mode) ─────────────────────────────────────────────────

const asInputKind = (store: EditorStore, v: string): InputKind => {
  const found = store.detected.find((k) => k === v);
  if (found === undefined) throw new Error(`undetected input kind: ${v}`);
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

// [LAW:no-silent-failure] applied to the PRODUCT message: a claude.ai/code link
// cannot be fetched server-side yet (slopspot-cc-share-4nc.2/.10), so the editor
// says so plainly and hands the user a workaround instead of silently fetching
// the login wall. The agent that owns the session extracts it and POSTs to
// /api/draft, which opens it here unsubmitted for review. The instruction is
// self-contained (works whether or not the share-slop skill is installed).
const CLAUDE_CODE_HANDOFF_PROMPT = `Share my current Claude Code session to slopspot for review. If the share-slop skill is installed, run it. Otherwise: read this session's transcript at ~/.claude/projects/<slug>/$CLAUDE_CODE_SESSION_ID.jsonl (slug = $PWD with every "/" and "." replaced by "-"), append any ~/.claude/projects/<slug>/$CLAUDE_CODE_SESSION_ID/subagents/agent-*.jsonl files, then POST {"source":{"kind":"claude-jsonl","content":"<the full jsonl text>"}} with header "content-type: application/json" to https://paste.slopspot.ai/api/draft. The response is {"draftId","url"}; open https://paste.slopspot.ai followed by that "url" to review the rendered conversation, then publish it.`;

// [LAW:effects-at-boundaries] A leaf UI affordance: copy the handoff text to the
// clipboard. Optional-chained because jsdom/older browsers may lack the API; a
// missing clipboard is a no-op, never a throw mid-handler.
const copyHandoff = (): void => {
  void navigator.clipboard?.writeText(CLAUDE_CODE_HANDOFF_PROMPT);
};

const codeLinkNotice = (): TemplateResult => html`
  <div class="code-link-notice" role="note">
    <p class="code-link-title">
      Direct fetch of <code>claude.ai/code</code> links isn’t available yet
      <span class="code-link-temp">(temporary)</span>.
    </p>
    <p class="code-link-body">
      A shared Claude Code session is private to your Claude account, so slopspot
      can’t fetch it server-side yet. Paste the instruction below into the Claude
      Code session you want to share — your agent extracts it and opens it here,
      filled in and ready for you to review before publishing.
    </p>
    <textarea class="code-link-prompt" readonly rows="5" .value=${CLAUDE_CODE_HANDOFF_PROMPT}></textarea>
    <button class="btn-secondary code-link-copy" @click=${copyHandoff}>Copy instructions</button>
  </div>
`;

// [LAW:no-silent-failure] The url arm's lifecycle, made visible as a pure
// projection of store state — there is no "Fetch & parse" step left
// (slopspot-editor-s3j.3): pasting a link IS the fetch. In flight → a live
// status; failed → the error renders below and this offers the retry (error
// recovery, not a parse step — the same one fetch path, fired immediately);
// adopted → a quiet affirmation of why nothing is happening. The idle remainder
// is the sub-second settle window and the empty pane — silence is honest there.
const urlFetchStatus = (store: EditorStore): TemplateResult | typeof nothing => {
  if (store.fetching) return html`<span class="fetch-status" role="status">Fetching conversation…</span>`;
  // The retry gates on the pane actually holding a link (hasFetchableUrl), not
  // on the error alone: importError is shared with non-fetch paths (a failed
  // draft restore over an empty pane), and a retry there would fetch nothing.
  if (store.importError !== null && store.hasFetchableUrl)
    return html`<button class="btn-secondary" @click=${() => store.fetchUrl()}>Try again</button>`;
  if (store.urlAdopted) return html`<span class="fetch-status" role="status">Fetched ✓</span>`;
  return nothing;
};

// Text mode IS the plain-text editor over the original submitted source
// (slopspot-editor-s3j.2): one seamless pane bound to store.sourceText, the
// architectural authority the blocks re-derive from on every keystroke — no
// parse button, no separate import box. The slim row beneath keeps the format
// override and, for a pasted link (the one asynchronous arm), the auto-fetch's
// visible status.
const sourcePane = (store: EditorStore): TemplateResult => html`
  <div class="source-pane">
    <label class="visually-hidden" for="source-text">Conversation source</label>
    <textarea
      id="source-text"
      class="source-text"
      placeholder="Paste a transcript or a conversation link — it becomes an editable conversation as you type."
      .value=${store.sourceText}
      @input=${(e: Event) => store.setSource(valueOf(e))}
    ></textarea>
    ${store.claudeCodeLinkId !== null
      ? codeLinkNotice()
      : html`
        <div class="import-row">
          <select
            class="source-select"
            @change=${(e: Event) => store.setImportKind(asInputKind(store, valueOf(e)))}
          >
            ${store.detected.map((k) => html`<option value=${k} ?selected=${k === store.importKind}>${inputLabel(k)}</option>`)}
          </select>
          ${store.isUrlImport ? urlFetchStatus(store) : nothing}
        </div>`}
    ${store.importError === null
      ? nothing
      : html`<p class="form-error" role="alert">${store.importError}</p>`}
  </div>
`;

// [LAW:no-silent-failure] The no-clobber gate. When a replacement (a text-pane
// derive or a fetched batch) would overwrite work not derived from its source,
// the store stages it (pendingReparse) instead of replacing; this strip is the
// explicit choice. It renders in the always-visible slot beside the toolbar so
// the pending decision is seen from EITHER view — a staged derive must not hide
// behind a switch to Preview. No pending decision -> renders nothing, so the
// common path (first paste, or re-deriving a pure projection) is silent.
const reparseConfirm = (store: EditorStore): TemplateResult | typeof nothing => {
  if (store.pendingReparse === null) return nothing;
  const n = store.blocks.length;
  // The only pristine state that stages is the url-origin one (deriveWouldClobber),
  // so the adjective is exact: dirty blocks are hand-edited, clean ones are fetched.
  const kind = store.isDirty ? "edited" : "fetched";
  return html`
    <div class="reparse-confirm" role="alert">
      <span
        >Replace ${n} ${kind} block${n === 1 ? "" : "s"} with the new source? This discards
        work the new source can't reproduce.</span
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
    @change=${(e: Event) => store.setPlatform(parsePlatformSelect(valueOf(e)))}
  >
    <option value="" ?selected=${store.userPlatform === null}>Theme: Auto</option>
    ${PLATFORMS.map((p) => html`<option value=${p} ?selected=${p === store.userPlatform}>${PLATFORM_DISPLAY[p]}</option>`)}
  </select>
`;

// [LAW:no-silent-failure] The discard gate. When the confirm is armed
// (pendingDiscard), show a strip identical in shape to reparseConfirm.
// The strip is invisible (nothing) when not armed, so the common path is silent.
const discardConfirm = (store: EditorStore): TemplateResult | typeof nothing => {
  if (!store.pendingDiscard) return nothing;
  return html`
    <div class="discard-confirm" role="alert">
      <span>Discard this draft? This clears the editor and the saved copy.</span>
      <button class="btn-secondary" @click=${() => store.cancelDiscard()}>Keep editing</button>
      <button class="btn-danger" @click=${() => store.discard()}>Discard</button>
    </div>
  `;
};

// [LAW:no-silent-failure] The secret-guard surface: an advisory banner that names each block the
// pure scanner flagged and the kinds found there, then OFFERS to remove them — so the author
// sees a likely secret AND can act on it BEFORE minting a permanent public link. It NEVER blocks
// publish (the submit button is untouched) — a detector has false positives, so the author
// decides. The "remove" action calls store.redactSecrets, which scrubs the flagged bytes from
// the stored original (a true removal, not a display hide); the banner then clears because its
// scan re-derives clean. It renders nothing when clean, and lives in the always-visible slot
// beside the toolbar's submit control so a publish from either view passes it. `role="status"`
// (polite) announces on change without the assertive re-read an alert would fire on every
// keystroke. describeSecretKind is surfaced verbatim [LAW:one-source-of-truth]; the secret text
// itself is never shown — a SecretFinding carries none, so masking is structural.
const secretWarnings = (store: EditorStore): TemplateResult | typeof nothing => {
  const warnings = store.secretWarnings;
  if (warnings.length === 0) return nothing;
  return html`
    <div class="secret-warnings" role="status">
      <p class="secret-warnings-title">
        Heads up — this looks like it contains ${warnings.length === 1 ? "a secret" : "secrets"}.
        Publishing is permanent and public; review before sharing.
      </p>
      <ul class="secret-warnings-list">
        ${warnings.map(
          (w) =>
            html`<li>
              Block ${w.turnIndex + 1}: ${w.kinds.map(describeSecretKind).join(", ")}
            </li>`,
        )}
      </ul>
      <div class="secret-warnings-actions">
        <button class="btn-danger secret-warnings-redact" @click=${() => store.redactSecrets()}>
          Remove ${warnings.length === 1 ? "it" : "them"} from the paste
        </button>
        <span class="secret-warnings-note">
          Edits the content — the secret is not stored, not just hidden.
        </span>
      </div>
    </div>
  `;
};

// [LAW:single-enforcer] The one place the submit/discard button markup lives.
// Both the top toolbar and the bottom bar use this fragment — they cannot
// disagree because they share the same bindings to the same store getters.
const submitControls = (store: EditorStore): TemplateResult => html`
  ${store.canDiscard
    ? html`<button class="btn-secondary" @click=${() => store.armDiscard()}>Discard draft</button>`
    : nothing}
  <button class="btn-primary" ?disabled=${!store.canSubmit} @click=${() => store.submit()}>
    ${store.busy ? "Sharing…" : "Share it"}
  </button>
  ${store.submitError === null
    ? nothing
    : html`<span class="form-error" role="alert">${store.submitError}</span>`}
`;

const toolbar = (store: EditorStore): TemplateResult => html`
  <div class="editor-toolbar">
    <div class="view-toggle" role="tablist">
      <button
        class="toggle ${store.view === "text" ? "active" : ""}"
        @click=${() => store.setView("text")}
      >
        Text
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
    ${submitControls(store)}
  </div>
`;

// Sticky bottom bar, rendered in both views (each is a long editable list).
// `position: sticky; bottom: 0` keeps it pinned to the viewport bottom while
// scrolling, without taking it out of flow — so no overlap with content above.
const bottomBar = (store: EditorStore): TemplateResult => html`
  <div class="editor-bottom-bar">
    ${submitControls(store)}
  </div>
`;

// ── Editable preview ────────────────────────────────────────────────────────
// Preview mode IS the block editor wearing the reader's chrome (slopspot-editor-
// s3j.1): the same blocks, ids and store mutations as the Blocks view, dressed in
// the exact classes global.css styles for the permalink (bubble / assistant-blocks
// / condensed), grouped by dialogue.ts's spine-split rule. [LAW:one-source-of-truth]
// Visual parity with the reader rests on the shared stylesheet and the shared
// grouping guard, not on a second copy of either; the read-only preview pane this
// replaces is gone, so "what readers see" and "what you can edit" are one surface.

// [LAW:one-type-per-behavior] The preview's per-block controls are the SAME
// operations the block-card header offers — reorder, kind convert, role change,
// split, merge, delete — bound to the same store mutations; only the chrome
// differs (a hover/focus-revealed overlay instead of an always-visible header).
const pvControls = (store: EditorStore, block: Block, index: number): TemplateResult => html`
  <div class="pv-controls">
    <span
      class="drag-handle"
      draggable="true"
      title="Drag to reorder"
      @dragstart=${(e: DragEvent) => startBlockDrag(e, index)}
      >⠿</span
    >
    ${kindBadge(store, block.id, block.turn)}
    ${block.turn.kind === "message" ? roleSelect(store, block.id, block.turn) : nothing}
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
    <button class="block-del" title="Delete block" @click=${() => store.deleteBlock(block.id)}>
      ✕
    </button>
  </div>
`;

// Seamless editable text that sizes to its content: the wrapper's ::after mirrors
// the value (CSS grid stacks the two), so the field grows exactly like the prose
// it stands in for — no rows guess, no inner scrollbar inside a bubble.
// [LAW:one-source-of-truth] data-value mirrors the SAME store value the textarea
// renders; both re-render from the store on every input, so the measuring mirror
// cannot drift from the text it measures.
const growText = (
  value: string,
  placeholder: string,
  onInput: (v: string) => void,
): TemplateResult => html`
  <div class="pv-grow" data-value=${value}>
    <textarea
      class="pv-text primary-text"
      rows="1"
      placeholder=${placeholder}
      .value=${value}
      @input=${(e: Event) => onInput(valueOf(e))}
    ></textarea>
  </div>
`;

// [LAW:one-source-of-truth] The condensed tool-call summary reads condenseToolCall
// — the SAME projection the reader's renderer reads — so the editable row and the
// permalink row name a call identically (tool, primary arg, pass/fail). Only the
// glyph markup is restated here (lit templates vs the renderer's HTML strings).
const TOOL_BADGE: { readonly [S in ToolStatus]: TemplateResult | typeof nothing } = {
  ok: html`<span class="tool-badge tool-badge-ok" aria-label="succeeded">✓</span>`,
  error: html`<span class="tool-badge tool-badge-error" aria-label="failed">✕</span>`,
  "no-result": nothing,
};

// A collapsed-by-default detail row, exactly the reader's condensed <details>.
// The controls overlay lives on a wrapper OUTSIDE the <details>: content that
// isn't the <summary> is hidden while closed, and controls inside the summary
// would fight its toggle-on-click. [LAW:no-ambient-temporal-coupling] the browser
// keeps sole ownership of open/closed; the editor never scripts the fold.
const pvToolCall = (
  store: EditorStore,
  block: Block,
  index: number,
  turn: Extract<Turn, { kind: "tool-call" }>,
): TemplateResult => {
  const { tool, primaryArg, status } = condenseToolCall(turn);
  return html`
    <div class="pv-block" data-block-id=${block.id}>
      ${pvControls(store, block, index)}
      <details class="condensed condensed-tool-call" data-kind="tool-call">
        <summary class="condensed-summary">
          <span class="condensed-icon tool-icon" aria-hidden="true">❯</span>
          <span class="condensed-label tool-name">${tool}</span>
          ${primaryArg === null ? nothing : html`<span class="condensed-arg">${primaryArg}</span>`}
          ${TOOL_BADGE[status]}
          <span class="condensed-caret" aria-hidden="true">▸</span>
        </summary>
        <div class="condensed-body pv-tool-fields">${toolCallBody(store, block.id, turn)}</div>
      </details>
    </div>
  `;
};

// [LAW:dataflow-not-control-flow] One dispatch on the turn discriminator, exactly
// mirroring cardBody — each arm wears the reader class its kind renders with.
const pvAssistantBlock = (store: EditorStore, { block, index }: NumberedBlock): TemplateResult => {
  const turn = block.turn;
  switch (turn.kind) {
    case "message":
      return html`
        <div class="assistant-text bubble-body pv-block" data-block-id=${block.id}>
          ${pvControls(store, block, index)}
          ${growText(turn.content, "Assistant text…", (v) => store.replaceTurn(block.id, { ...turn, content: v }))}
        </div>
      `;
    case "insight":
      return html`
        <div class="assistant-insight pv-block" data-kind="insight" data-block-id=${block.id}>
          ${pvControls(store, block, index)}
          <span class="insight-mark" aria-hidden="true">★</span>
          <div class="bubble-body">
            ${growText(turn.content, "Insight…", (v) => store.replaceTurn(block.id, { ...turn, content: v }))}
          </div>
        </div>
      `;
    case "thinking":
      return html`
        <div class="pv-block" data-block-id=${block.id}>
          ${pvControls(store, block, index)}
          <details class="condensed condensed-thinking" data-kind="thinking">
            <summary class="condensed-summary">
              <span class="condensed-icon" aria-hidden="true">✻</span>
              <span class="condensed-label">Thinking</span>
              <span class="condensed-caret" aria-hidden="true">▸</span>
            </summary>
            <div class="condensed-body">
              <div class="bubble-body">
                ${growText(turn.content, "Thinking…", (v) => store.replaceTurn(block.id, { ...turn, content: v }))}
              </div>
            </div>
          </details>
        </div>
      `;
    case "turn-summary":
      return html`
        <aside class="bubble-turn-summary pv-block" data-kind="turn-summary" data-block-id=${block.id}>
          ${pvControls(store, block, index)}
          ${growText(turn.text, "Turn summary…", (v) => store.replaceTurn(block.id, { ...turn, text: v }))}
        </aside>
      `;
    case "tool-call":
      return pvToolCall(store, block, index, turn);
  }
};

// A spoken (user/system) bubble: the reader's chrome with the prose swapped for a
// seamless editable field. The role header stays the reader's static label; the
// role CHANGE affordance lives in the hover controls, uniform with every other
// message block.
const pvSpoken = (
  store: EditorStore,
  group: Extract<BlockGroup, { kind: "spoken" }>,
): TemplateResult => html`
  <article class="bubble bubble-${group.turn.role} pv-block" data-block-id=${group.id}>
    ${pvControls(store, { id: group.id, turn: group.turn }, group.index)}
    <div class="bubble-role">
      <span class="role-dot role-dot-${group.turn.role}" aria-hidden="true"></span>
      <span class="role-name">${ROLE_LABEL[group.turn.role]}</span>
    </div>
    <div class="bubble-body">
      ${growText(group.turn.content, "Message…", (v) =>
        store.replaceTurn(group.id, { ...group.turn, content: v }),
      )}
    </div>
  </article>
`;

// The group article anchors drops on its chrome (role header, gaps between
// entries) to the group's FIRST block, so everywhere the accepting cursor shows,
// the drop acts. Inner blocks still resolve first — closest() finds the nearest
// wrapper — so this only catches drops the entries themselves didn't claim.
const pvAssistant = (
  store: EditorStore,
  entries: Extract<BlockGroup, { kind: "assistant" }>["entries"],
): TemplateResult => html`
  <article class="bubble bubble-assistant assistant-turn" data-block-id=${entries[0].block.id}>
    <div class="bubble-role">
      <span class="role-dot role-dot-assistant" aria-hidden="true"></span>
      <span class="role-name">Assistant</span>
    </div>
    <div class="assistant-blocks">
      ${repeat(entries, (entry) => entry.block.id, (entry) => pvAssistantBlock(store, entry))}
    </div>
  </article>
`;

// Group identity for keyed rendering: a spoken group is its block; an assistant
// group is identified by its first block (the entries tuple is non-empty by
// type). Content edits never change these keys (grouping depends only on
// kind/role), so focused fields keep their DOM nodes; a structural change
// (role flip, delete) legitimately rebuilds the group.
const groupKey = (group: BlockGroup): string =>
  group.kind === "spoken" ? group.id : group.entries[0].block.id;

// [LAW:effects-at-boundaries] One delegated drop seam for the whole preview: the
// dropped-on block is resolved from the DOM wrapper both views mark, then the
// move is the same store.moveBlock the Blocks view calls. A non-block drag
// decodes to null and a drop on group chrome or the container gap has no target
// block — genuine no-ops, not swallows.
const dropOnBlock = (store: EditorStore, e: DragEvent): void => {
  const from = draggedIndex(e);
  if (from === null) return;
  e.preventDefault();
  // A DOM event target is a trust boundary: EventTarget | null. instanceof
  // narrows honestly where a cast would assert; a non-Element target is the
  // same genuine no-target no-op as a drop on the container gap.
  if (!(e.target instanceof Element)) return;
  const id = e.target.closest("[data-block-id]")?.getAttribute("data-block-id");
  if (id === null || id === undefined) return;
  const to = store.blocks.findIndex((b) => b.id === id);
  if (to === -1) return;
  store.moveBlock(from, to);
};

// data-platform reads store.activePlatform, same as the retired read-only pane:
// - Override: userPlatform === conversation.platformOverride by construction.
// - Auto: all three submitOrigin arms preserve source: sourceOf(importOrigin),
//   so sourceOf(submitOrigin) === sourceOf(importOrigin) and platformOf is equal.
const previewEditor = (store: EditorStore): TemplateResult => html`
  <div
    class="bubbles pv-editor"
    data-platform=${store.activePlatform}
    @dragover=${allowBlockDrop}
    @drop=${(e: DragEvent) => dropOnBlock(store, e)}
  >
    ${repeat(groupBlocks(store.blocks), groupKey, (group) =>
      group.kind === "spoken" ? pvSpoken(store, group) : pvAssistant(store, group.entries),
    )}
    ${addRow(store)}
  </div>
`;

export const appTemplate = (store: EditorStore): TemplateResult => html`
  <div class="editor">
    ${toolbar(store)}
    ${discardConfirm(store)}
    ${reparseConfirm(store)}
    ${secretWarnings(store)}
    ${store.view === "text" ? sourcePane(store) : previewEditor(store)}
    ${bottomBar(store)}
  </div>
`;
