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
import type { ParseResult, SourceKind, Turn } from "../types";
import { textArmInput } from "../types";
import type { Block, Kind } from "./blocks";
import { emptyTurn, newId, toBlocks, toTurns } from "./blocks";
import { detectSources, parseInput } from "../parser";
import { renderTurnsHtml } from "../renderTurns";

export type View = "blocks" | "preview";

// [LAW:types-are-the-program] Submit has exactly two outcomes; the discriminated
// result forces the boundary (and the store) to handle both, never a bare slug
// that might be undefined on failure.
export type SubmitResult =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly reason: string };

// [LAW:effects-at-boundaries] The store's entire contact with the world, named
// as capabilities. fetchShare hits /api/fetch (URL -> turns), submit hits
// /api/paste ({ turns } -> slug), navigate changes the page. mount.ts is the one
// place these are real.
export interface EditorIo {
  readonly fetchShare: (url: string) => Promise<ParseResult>;
  readonly submit: (turns: ReadonlyArray<Turn>) => Promise<SubmitResult>;
  readonly navigate: (slug: string) => void;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(n, hi));

export class EditorStore {
  blocks: Block[] = [];
  importText = "";
  // [LAW:one-source-of-truth] The selected source is DERIVED (see importKind),
  // not stored. userKind is an explicit override the user picked from the
  // dropdown; null means "follow detection". Storing the resolved kind directly
  // would drift from the text — "raw" is always detected, so a stored default
  // could never re-snap to a more-specific format once set.
  userKind: SourceKind | null = null;
  view: View = "blocks";
  importError: string | null = null;
  submitError: string | null = null;
  // One in-flight flag for any network action (fetch OR submit): while either is
  // running, both buttons disable. There is no legitimate state where a fetch
  // and a submit race, so a single flag is the honest representation.
  busy = false;

  constructor(private readonly io: EditorIo) {
    makeAutoObservable<this, "io">(this, { io: false }, { autoBind: true });
  }

  // ── Derived (computed) ──────────────────────────────────────────────────
  // [LAW:one-source-of-truth] turns/previewHtml are derived from blocks, never
  // stored alongside them. The preview calls the SAME renderer as the permalink.

  get detected(): ReadonlyArray<SourceKind> {
    return detectSources(this.importText);
  }

  // [LAW:dataflow-not-control-flow] The active source kind is a pure function of
  // (detection, optional override): honor the user's pick while it stays a
  // detected kind, else fall to the highest-priority detection. detected is
  // ordered most-specific-first (SOURCE_KINDS), so detected[0] is the best
  // auto-detection — paste markdown -> "markdown", not a sticky "raw".
  get importKind(): SourceKind {
    return this.userKind !== null && this.detected.includes(this.userKind)
      ? this.userKind
      : (this.detected[0] ?? "raw");
  }

  get turns(): Turn[] {
    return toTurns(this.blocks);
  }

  get previewHtml(): string {
    return renderTurnsHtml(this.turns);
  }

  get counts(): Record<Kind, number> {
    const acc: Record<Kind, number> = {
      "message": 0,
      "tool-call": 0,
      "insight": 0,
      "turn-summary": 0,
    };
    for (const block of this.blocks) acc[block.turn.kind] += 1;
    return acc;
  }

  get isUrlImport(): boolean {
    return this.importKind === "claude-share";
  }

  get canSubmit(): boolean {
    return this.blocks.length > 0 && !this.busy;
  }

  // ── Import box ──────────────────────────────────────────────────────────

  setImport(text: string): void {
    this.importText = text;
    // [LAW:one-source-of-truth] No reconciliation needed: importKind is derived
    // from importText + userKind, so it re-snaps to the best detection the
    // instant the text changes. A user override that no longer matches the text
    // is dropped by the getter, not patched here.
    this.importError = null;
  }

  setImportKind(kind: SourceKind): void {
    this.userKind = kind;
    this.importError = null;
  }

  // The single import action. claude-share is the async URL arm (delegates to
  // the injected capability); every other kind parses synchronously and purely.
  // [LAW:dataflow-not-control-flow] One entry point; the kind value selects the
  // path, and `kind` narrows to a text arm after the URL arm returns.
  async ingest(): Promise<void> {
    const kind = this.importKind;
    this.importError = null;
    if (kind === "claude-share") {
      await this.fetchShare(this.importText.trim());
      return;
    }
    const result = parseInput(textArmInput(kind, this.importText));
    if (!result.ok) {
      this.importError = result.reason;
      return;
    }
    this.loadTurns(result.turns);
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
      this.loadTurns(result.turns);
    });
  }

  // ── Blocks ──────────────────────────────────────────────────────────────

  // [LAW:single-enforcer] The only place parsed/fetched turns become editable
  // blocks. Replaces the list wholesale and snaps to the blocks view so the user
  // sees what they imported.
  private loadTurns(turns: ReadonlyArray<Turn>): void {
    this.blocks = toBlocks(turns);
    this.view = "blocks";
  }

  // [LAW:dataflow-not-control-flow] The one card mutation. The view computes the
  // new turn (content edit, role change, kind conversion, tool-call fields all
  // collapse to "this block now holds this turn"). Replacing the block object
  // keeps Block readonly (immutable coordination); the stable id rides through so
  // keyed lit-html reuses the DOM node.
  replaceTurn(id: string, turn: Turn): void {
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

  // ── View + submit ───────────────────────────────────────────────────────

  setView(view: View): void {
    this.view = view;
  }

  async submit(): Promise<void> {
    if (!this.canSubmit) return;
    this.busy = true;
    this.submitError = null;
    const result = await this.io.submit(this.turns);
    runInAction(() => {
      this.busy = false;
      if (!result.ok) this.submitError = result.reason;
    });
    // [LAW:effects-at-boundaries] Navigation is a world effect performed through
    // the capability, outside the state transaction.
    if (result.ok) this.io.navigate(result.slug);
  }
}
