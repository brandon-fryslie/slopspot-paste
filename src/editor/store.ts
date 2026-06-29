// The editor's reactive core. mobx owns state + derived values; this module is
// the single source of truth for editing state AFTER parse (the import textarea
// re-parses INTO blocks via an explicit action; it is never a second live copy).
//
// [LAW:effects-at-boundaries] The store computes; it does not act on the world.
// Network (fetch/submit) and navigation are *world* effects, so they enter as an
// injected `EditorIo` capability rather than `fetch`/`location` calls baked into
// actions. mount.ts supplies the real IO; a test supplies a fake. The store's
// async actions orchestrate status (busy/error) around those capabilities but
// never reach the network or the address bar themselves.
//
// [LAW:dataflow-not-control-flow] Card editing is ONE mutation — replaceTurn.
// The view narrows a turn by kind and hands back a new Turn value; there is no
// fan of per-field, per-kind setters (which would be a field×kind mode
// explosion). Variability lives in the turn value crossing one seam.

import { makeAutoObservable, runInAction } from "mobx";
import type { InputKind, Origin, ParseResult, Platform, SourceKind, Turn } from "../types";
import { platformOf, sourceOf, textArmInput } from "../types";
import type { AuthorableTurn, Block, Kind } from "./blocks";
import { emptyTurn, isAuthorable, mergeTurns, newId, splitTurn, toBlocks, toTurns } from "./blocks";
import { detectSources, parseInput } from "../parser";
import { claudeCodeSessionId } from "../url";
import { renderDialogueHtml } from "../renderDialogue";
import { deriveDialogue } from "../dialogue";

export type View = "blocks" | "preview";

// [LAW:types-are-the-program] Submit has exactly two outcomes; the discriminated
// result forces the boundary (and the store) to handle both, never a bare slug
// that might be undefined on failure.
export type SubmitResult =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: string };

// [LAW:one-type-per-behavior] An editor import IS a parse result: turns plus the
// captured Origin that produced them. Both the sync parse and the async
// /api/fetch path now carry the FULL origin (for share, its url + fetched bytes),
// so the editor holds the whole source of truth rather than a narrowed `source`.
// It is the same outcome shape the parser returns; aliasing keeps the one type.
export type ImportResult = ParseResult;

// [LAW:one-type-per-behavior] The unit the editor authors: turns plus the Origin
// they were imported from (null = authored from scratch, no parser ran). Submit
// and draft persistence both move this one shape — the origin is never separated
// from the turns it describes, so it cannot be dropped at one seam and kept at
// another. The origin a Draft carries is the IMPORT origin (where the turns came
// from); the store derives the origin to STAMP at submit time (see submitOrigin).
// platformOverride carries the user's explicit theme pick to the paste API so
// the permalink honors it instead of re-deriving from source.
export interface Draft {
  readonly turns: ReadonlyArray<Turn>;
  readonly origin: Origin | null;
  readonly platformOverride?: Platform;
}

// [LAW:types-are-the-program] Loading a server draft (an agent handoff via
// /api/draft) has exactly two outcomes. Unlike ImportResult it carries a Draft —
// origin may be null (an editor-origin or provenance-less draft) — so the restore
// reuses the editor's one load path. A missing/expired draft is the {ok:false}
// arm, surfaced through the same importError channel as a failed fetch.
export type DraftLoadResult =
  | { readonly ok: true; readonly draft: Draft }
  | { readonly ok: false; readonly reason: string };

// [LAW:effects-at-boundaries] The store's entire contact with the world, named
// as capabilities. fetchShare hits /api/fetch (URL -> turns + Origin), fetchDraft
// hits /api/draft (id -> Draft, the agent-handoff restore), submit hits /api/paste
// (Draft -> slug), navigate changes the page; saveDraft/loadDraft/clearDraft
// persist the in-progress Draft to localStorage so an accidental reload doesn't
// lose work. mount.ts is the one place these are real.
//
// loadDraft returns the empty Draft ({ turns: [], origin: null }) for "no
// draft" (absent or unparseable) — the same empty editor a fresh visit gets,
// so restore is unconditional dataflow, not a branch.
export interface EditorIo {
  readonly fetchShare: (url: string) => Promise<ImportResult>;
  readonly fetchDraft: (id: string) => Promise<DraftLoadResult>;
  readonly submit: (draft: Draft) => Promise<SubmitResult>;
  readonly navigate: (slug: string) => void;
  readonly saveDraft: (draft: Draft) => void;
  readonly loadDraft: () => Draft;
  readonly clearDraft: () => void;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(n, hi));

export class EditorStore {
  blocks: Block[] = [];
  importText = "";
  // [LAW:one-source-of-truth] The selected input kind is DERIVED (see importKind),
  // not stored. userKind is an explicit override the user picked from the
  // dropdown; null means "follow detection". Storing the resolved kind directly
  // would drift from the text — "raw" is always detected, so a stored default
  // could never re-snap to a more-specific format once set.
  userKind: InputKind | null = null;
  // [LAW:one-source-of-truth] Explicit platform override; null = auto-derive from
  // source. Cleared on every loadTurns so new content re-snaps to detection.
  // activePlatform = userPlatform ?? platformOf(source) is the single resolution.
  userPlatform: Platform | null = null;
  // [LAW:one-source-of-truth] The Origin the loaded turns were imported from —
  // the captured source of truth (for share, its url + fetched bytes), set only
  // by loadTurns (the single loader every parse/fetch/draft-restore passes
  // through). null = authored from scratch. Hand-edits don't change where the
  // content came from, so edits never touch it; `source` (styling) and
  // `submitOrigin` (what to stamp) are both DERIVED from it, never stored apart.
  importOrigin: Origin | null = null;
  view: View = "blocks";
  importError: string | null = null;
  submitError: string | null = null;
  // [LAW:one-source-of-truth] The baseline a reparse is judged against: the turns
  // as last loaded (parse/fetch/confirmed-reparse). NOT a second live copy of
  // blocks — it's a snapshot of a *different moment*, so isDirty is derivable
  // (current blocks vs this baseline) rather than tracked as a flag that drifts.
  pristineTurns: ReadonlyArray<AuthorableTurn> = [];
  // [LAW:no-ambient-temporal-coupling] A reparse that would discard hand-edits is
  // a two-phase action (parse -> confirm -> commit). The middle phase is typed
  // state carrying the already-parsed turns, not an ordering assumption or a
  // `force` boolean. null = no decision pending.
  pendingReparse: Draft | null = null;
  // One in-flight flag for any network action (fetch OR submit): while either is
  // running, both buttons disable. There is no legitimate state where a fetch
  // and a submit race, so a single flag is the honest representation.
  busy = false;
  // [LAW:no-ambient-temporal-coupling] Two-phase discard: arm (click "Discard
  // draft") → confirm (click "Discard") mirrors the pendingReparse pattern. false
  // = no decision pending; true = the confirm strip is visible.
  pendingDiscard = false;

  constructor(private readonly io: EditorIo) {
    makeAutoObservable<this, "io">(this, { io: false }, { autoBind: true });
  }

  // ── Derived (computed) ──────────────────────────────────────────────────
  // [LAW:one-source-of-truth] turns/previewHtml are derived from blocks, never
  // stored alongside them. The preview derives the nested Dialogue and renders it
  // through renderDialogueHtml — the SAME path the permalink uses — so the two
  // surfaces render through one component and cannot drift. The editor's block
  // model never holds subagent or usage turns (loadTurns filters to AuthorableTurn),
  // so this preview shows the editable content exactly; subagents that only the
  // stored original carries appear on the permalink, not here, which is correct:
  // authoring nested subagent structure is out of scope, so the preview mirrors
  // what is editable, not what is stored.

  get detected(): ReadonlyArray<InputKind> {
    return detectSources(this.importText);
  }

  // [LAW:dataflow-not-control-flow] The active source kind is a pure function of
  // (detection, optional override): honor the user's pick while it stays a
  // detected kind, else fall to the highest-priority detection. detected is
  // ordered most-specific-first (SOURCE_KINDS), so detected[0] is the best
  // auto-detection — paste markdown -> "markdown", not a sticky "raw".
  get importKind(): InputKind {
    return this.userKind !== null && this.detected.includes(this.userKind)
      ? this.userKind
      : (this.detected[0] ?? "raw");
  }

  get turns(): Turn[] {
    return toTurns(this.blocks);
  }

  get previewHtml(): string {
    return renderDialogueHtml(deriveDialogue(this.turns));
  }

  get counts(): Record<Kind, number> {
    const acc: Record<Kind, number> = {
      "message": 0,
      "tool-call": 0,
      "insight": 0,
      "thinking": 0,
      "turn-summary": 0,
    };
    for (const block of this.blocks) acc[block.turn.kind] += 1;
    return acc;
  }

  get isUrlImport(): boolean {
    return this.importKind === "url";
  }

  // [LAW:one-source-of-truth] Recognize a claude.ai/code session link via the one
  // shared matcher (url.ts). Non-null = the import text IS such a link (value is
  // its session id): the view offers the agent-handoff workaround instead of a
  // fetch, because slopspot cannot fetch these server-side yet. Drives a DISPLAY
  // branch only; the link is never silently fetched as a doomed url import.
  get claudeCodeLinkId(): string | null {
    return claudeCodeSessionId(this.importText);
  }

  // [LAW:one-source-of-truth] Styling provenance is DERIVED from the import
  // origin, never stored beside it — the same derivation the rest of the app
  // uses. The view reads this to theme the preview; it cannot drift from the
  // origin the turns actually came from.
  get source(): SourceKind | null {
    return sourceOf(this.importOrigin);
  }

  // [LAW:one-source-of-truth] userPlatform ?? derived — mirrors the userKind /
  // importKind seam. The view reads this one getter; it never inspects both.
  get activePlatform(): Platform {
    return this.userPlatform ?? platformOf(this.source);
  }

  // [LAW:one-source-of-truth] The origin to STAMP at submit. Three cases, keyed on
  // import state and dirty flag:
  //   1. Pristine import (!isDirty, importOrigin set): stamp origin directly — stored
  //      turns are a pure projection of parse(origin), reproject is safe.
  //   2. Edited import (isDirty, importOrigin is a text/share arm): stamp editor arm
  //      carrying the import origin as `input`, so the original submitted content is
  //      preserved as provenance ([LAW:no-silent-failure]). Turns are authoritative;
  //      canonicalize/reproject see the editor arm and keep them verbatim.
  //   3. From-scratch authoring or edited editor-origin draft: bare editor arm with
  //      source for styling — no upstream text to preserve.
  // isDirty is the reliable signal: it compares same-source turns, and text/share
  // imports have no usage events to be stripped, so "not dirty" guarantees turns
  // equal reproject(origin).
  get submitOrigin(): Origin {
    const o = this.importOrigin;
    if (o !== null && !this.isDirty) return o;
    if (o !== null && o.kind !== "editor") {
      return { kind: "editor", source: sourceOf(o), input: o };
    }
    return { kind: "editor", source: sourceOf(o) };
  }

  get canSubmit(): boolean {
    return this.blocks.length > 0 && !this.busy;
  }

  // [LAW:no-ambient-temporal-coupling] Also gated on !busy to match canSubmit:
  // a discard during an in-flight fetch would be overwritten by the completion.
  get canDiscard(): boolean {
    return this.blocks.length > 0 && !this.busy;
  }

  // [LAW:one-source-of-truth] "Were the blocks hand-edited since the last parse?"
  // is derived, never a stored flag. Turn is pure JSON data (it is exactly what
  // crosses the wire to /api/paste), so structural-string equality is exact for
  // content and stable for identically-shaped turns. The asymmetry is the whole
  // point: a false "dirty" only over-warns (harmless); it can never under-warn
  // into the silent clobber [LAW:no-silent-failure] forbids.
  get isDirty(): boolean {
    return JSON.stringify(this.turns) !== JSON.stringify(this.pristineTurns);
  }

  // The one concept the reparse-confirm guards: there is visible edited work a
  // reparse would destroy. Empty editor or an untouched parse: nothing to lose.
  get wouldClobber(): boolean {
    return this.blocks.length > 0 && this.isDirty;
  }

  // ── Import box ──────────────────────────────────────────────────────────

  setImport(text: string): void {
    this.importText = text;
    // [LAW:one-source-of-truth] No reconciliation needed: importKind is derived
    // from importText + userKind, so it re-snaps to the best detection the
    // instant the text changes. A user override that no longer matches the text
    // is dropped by the getter, not patched here.
    this.importError = null;
    // Editing the import box invalidates any staged reparse: the confirm offered
    // "replace with THAT parse", which no longer matches the text on screen.
    this.pendingReparse = null;
  }

  setImportKind(kind: InputKind): void {
    this.userKind = kind;
    this.importError = null;
    this.pendingReparse = null;
  }

  setPlatform(platform: Platform | null): void {
    this.userPlatform = platform;
  }

  // The single import action. "url" is the async fetch arm (delegates to the
  // injected capability); every text kind parses synchronously and purely.
  // [LAW:dataflow-not-control-flow] One entry point; the kind value selects the
  // path, and `kind` narrows to a text arm after the url arm returns.
  async ingest(): Promise<void> {
    const kind = this.importKind;
    this.importError = null;
    if (kind === "url") {
      await this.fetchShare(this.importText.trim());
      return;
    }
    const result = parseInput(textArmInput(kind, this.importText));
    if (!result.ok) {
      this.importError = result.reason;
      return;
    }
    this.accept({ turns: result.turns, origin: result.origin });
  }

  private async fetchShare(url: string): Promise<void> {
    this.busy = true;
    this.importError = null;
    const result = await this.io.fetchShare(url);
    runInAction(() => {
      this.busy = false;
      if (!result.ok) {
        this.importError = result.reason;
        return;
      }
      this.accept({ turns: result.turns, origin: result.origin });
    });
  }

  // [LAW:single-enforcer] An agent handoff: restore a server-stored draft
  // (/api/draft) for review. Mirrors fetchShare's busy/error orchestration and
  // converges on the SAME accept() loader, so a handed-off draft enters editing
  // exactly as a fetched import does — its turns become the dirty baseline (not
  // instantly "dirty"), and a missing/expired draft surfaces through the same
  // importError channel, never a silent empty editor [LAW:no-silent-failure].
  async loadServerDraft(id: string): Promise<void> {
    this.busy = true;
    this.importError = null;
    const result = await this.io.fetchDraft(id);
    runInAction(() => {
      this.busy = false;
      if (!result.ok) {
        this.importError = result.reason;
        return;
      }
      this.accept(result.draft);
    });
  }

  // ── Blocks ──────────────────────────────────────────────────────────────

  // [LAW:single-enforcer] The one decision every freshly-parsed/fetched batch
  // passes through: replace now, or stage for confirmation. The value
  // (wouldClobber) selects the outcome — both are legitimate data states, not a
  // skipped operation. No `force` flag duplicates this decision at callsites.
  private accept(draft: Draft): void {
    if (this.wouldClobber) {
      this.pendingReparse = draft;
      return;
    }
    this.loadTurns(draft);
  }

  // The user confirmed a clobbering reparse. Commit the staged turns through the
  // same single loader; a no-op when nothing is staged (idempotent confirm).
  confirmReparse(): void {
    const pending = this.pendingReparse;
    if (pending === null) return;
    this.loadTurns(pending);
  }

  cancelReparse(): void {
    this.pendingReparse = null;
  }

  // [LAW:single-enforcer] Restoring a persisted draft reuses the one loader every
  // parse/fetch passes through, so the dirty baseline (pristineTurns) is set to
  // the restored turns and the draft is not instantly "dirty". Called once at
  // mount before any edit; an empty draft ([]) loads to the same empty editor a
  // fresh visit gets, so the caller never branches on "is there a draft".
  restoreDraft(draft: Draft): void {
    this.loadTurns(draft);
  }

  // [LAW:single-enforcer] The only place parsed/fetched turns become editable
  // blocks. Replaces the list wholesale, resets the dirty baseline to the loaded
  // turns, adopts the batch's provenance, clears any pending decision, and snaps
  // to the blocks view.
  private loadTurns(draft: Draft): void {
    // [LAW:types-are-the-program] usage turns are source-derived token
    // accounting, not author-able content; the editor holds only AuthorableTurns,
    // so they are dropped here at the single load seam. Editing a transcript
    // discards token counts that no longer describe the edited content — the
    // baseline is set to the same filtered set so the editor isn't instantly
    // "dirty" against turns it never held.
    const editable = draft.turns.filter(isAuthorable);
    this.blocks = toBlocks(editable);
    this.pristineTurns = editable;
    this.importOrigin = draft.origin;
    this.pendingReparse = null;
    this.view = "blocks";
    // [LAW:no-mode-explosion] New content snaps theme back to auto-detection;
    // a stale override silently diverging from new content is a hidden mode.
    this.userPlatform = null;
  }

  // [LAW:dataflow-not-control-flow] The one card mutation. The view computes the
  // new turn (content edit, role change, kind conversion, tool-call fields all
  // collapse to "this block now holds this turn"). Replacing the block object
  // keeps Block readonly (immutable coordination); the stable id rides through so
  // keyed lit-html reuses the DOM node.
  replaceTurn(id: string, turn: AuthorableTurn): void {
    const i = this.blocks.findIndex((b) => b.id === id);
    // A concurrent delete can remove the card between render and event; with the
    // card gone there is nothing to update. Genuine absence, not a swallowed bug.
    if (i === -1) return;
    this.blocks[i] = { id, turn };
  }

  addBlock(kind: Kind): void {
    this.blocks.push({ id: newId(), turn: emptyTurn(kind) });
    this.view = "blocks";
  }

  deleteBlock(id: string): void {
    this.blocks = this.blocks.filter((b) => b.id !== id);
  }

  moveBlock(fromIndex: number, toIndex: number): void {
    const max = this.blocks.length - 1;
    // [LAW:no-defensive-null-guards] fromIndex comes from a drag dataTransfer —
    // a real trust boundary (a cross-window drop can deliver garbage). Reject
    // non-integers loudly-by-no-op rather than splicing at NaN.
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
    const from = clamp(fromIndex, 0, max);
    const to = clamp(toIndex, 0, max);
    if (from === to) return;
    const moved = this.blocks.splice(from, 1)[0];
    if (moved === undefined) return;
    this.blocks.splice(to, 0, moved);
  }

  // [LAW:single-enforcer] Split funnels through the same blocks array every other
  // mutation owns. The head reuses the original id so its DOM node + caret survive
  // the re-render; the tail gets a fresh id. splice(i, 1, head, tail) is the atomic
  // "one card becomes two, in place". A pure cut — splitTurn owns the text math.
  splitBlock(id: string, offset: number): void {
    const i = this.blocks.findIndex((b) => b.id === id);
    // A concurrent delete can remove the card between render and click; with it
    // gone there is nothing to split. Genuine absence, not a swallowed bug.
    const block = this.blocks[i];
    if (block === undefined) return;
    const [head, tail] = splitTurn(block.turn, offset);
    this.blocks.splice(i, 1, { id, turn: head }, { id: newId(), turn: tail });
  }

  // Merge a block into the one above it: the previous block keeps its id, kind
  // and shape; this block's text appends and the block is consumed (two cards
  // become one, in place). The first block has nothing above it, so merging it
  // is a no-op the view disables — kept total here so a stale click cannot throw.
  mergeBlocks(id: string): void {
    const i = this.blocks.findIndex((b) => b.id === id);
    const prev = this.blocks[i - 1];
    const cur = this.blocks[i];
    if (prev === undefined || cur === undefined) return;
    this.blocks.splice(i - 1, 2, { id: prev.id, turn: mergeTurns(prev.turn, cur.turn) });
  }

  // ── View + submit ───────────────────────────────────────────────────────

  setView(view: View): void {
    this.view = view;
  }

  async submit(): Promise<void> {
    if (!this.canSubmit) return;
    this.busy = true;
    this.submitError = null;
    const result = await this.io.submit({
      turns: this.turns,
      origin: this.submitOrigin,
      platformOverride: this.userPlatform ?? undefined,
    });
    runInAction(() => {
      this.busy = false;
      if (!result.ok) this.submitError = result.reason;
    });
    // [LAW:effects-at-boundaries] On success the work is now permanently stored,
    // so the local draft is obsolete: clear it, then navigate. Both world effects
    // performed through capabilities, outside the state transaction.
    if (result.ok) {
      this.io.clearDraft();
      this.io.navigate(result.slug);
    }
  }

  armDiscard(): void {
    this.pendingDiscard = true;
  }

  cancelDiscard(): void {
    this.pendingDiscard = false;
  }

  // [LAW:single-enforcer] Route the full block/provenance/view reset through the
  // one loader rather than duplicating loadTurns' resets at a second callsite.
  // The import-scratch fields (importText, userKind, importError, submitError)
  // are cleared here because loadTurns deliberately leaves them alone — the import
  // box must survive a parse/fetch/draft-restore; discard returns to fresh-visit.
  // [LAW:effects-at-boundaries] The store never touches localStorage directly.
  discard(): void {
    this.loadTurns({ turns: [], origin: null });
    this.importText = "";
    this.userKind = null;
    this.importError = null;
    this.submitError = null;
    this.pendingDiscard = false;
    this.io.clearDraft();
  }
}
