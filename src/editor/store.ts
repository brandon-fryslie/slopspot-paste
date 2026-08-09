// The editor's reactive core. mobx owns state + derived values. Text mode edits
// sourceText — the plain-text original the architecture declares authoritative —
// and the blocks re-derive from it continuously; Preview mode edits the derived
// blocks directly, at which point the turns become the authority and the origin
// is kept as provenance (see submitOrigin). The two directions meet at one gate
// (accept): any replacement that would discard non-derived work stages for
// confirmation instead of clobbering.
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
import type { DraftRecord, InputKind, Origin, ParseResult, Platform, SourceKind, Turn } from "../types";
import { platformOf, sourceOf, sourceTextOf, textArmInput } from "../types";
import type { AuthorableTurn, Block, Kind } from "./blocks";
import { emptyTurn, isAuthorable, mergeTurns, newId, splitTurn, toBlocks, toTurns } from "./blocks";
import { detectSources, isUrl, parseInput, reprojectOrigin } from "../parser";
import { claudeCodeSessionId } from "../url";
import { scanTurnsForSecrets, type TurnSecretWarning } from "../secret-warnings";
import { scrubOrigin, scrubTurn } from "../secret-scrub";

export type View = "text" | "preview";

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

// [LAW:one-type-per-behavior][LAW:one-source-of-truth] The unit the editor authors:
// turns plus the Origin they were imported from (null = authored from scratch, no
// parser ran). This is the editor-facing name for the canonical DraftRecord shape
// (types.ts) — the SAME contract the server KV record speaks, defined once so the
// client and server cannot drift. Submit and draft persistence both move this one
// shape — the origin is never separated from the turns it describes, so it cannot
// be dropped at one seam and kept at another. The origin a Draft carries is the
// IMPORT origin (where the turns came from); the store derives the origin to STAMP
// at submit time (see submitOrigin). platformOverride carries the user's explicit
// theme pick to the paste API so the permalink honors it instead of re-deriving.
export type Draft = DraftRecord;

// [LAW:types-are-the-program] Loading a server draft (an agent handoff via
// /api/draft) has exactly two outcomes. Unlike ImportResult it carries a Draft —
// origin may be null (an editor-origin or provenance-less draft) — so the restore
// reuses the editor's one load path. A missing/expired draft is the {ok:false}
// arm, surfaced through the same importError channel as a failed fetch.
export type DraftLoadResult =
  | { readonly ok: true; readonly draft: Draft }
  | { readonly ok: false; readonly reason: string };

// [LAW:types-are-the-program] A staged replacement remembers HOW it must commit
// when confirmed: a batch load (fetch/handoff — full adoption: provenance, theme,
// landing view) or a continuous text derive (light adoption: blocks + origin
// only, so confirming mid-typing never yanks the view or resets the theme pick).
// The discriminator is data the confirm dispatches on, not a second confirm
// method per path [LAW:dataflow-not-control-flow].
export type AdoptionVia = "load" | "derive";
export interface PendingAdoption {
  readonly draft: Draft;
  readonly via: AdoptionVia;
}

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
  // [LAW:dataflow-not-control-flow] Revoke the server-side handoff draft this editor
  // was opened from (DELETE /api/draft). The id is a VALUE the store passes through —
  // null when the editor wasn't opened from a server draft (from-scratch authoring or
  // a localStorage restore), so the boundary no-ops with no network call, exactly as
  // clearDraft is unconditional + idempotent. Fire-and-forget: the DRAFT_TTL is the
  // authoritative backstop, so discard never waits on (or branches on) revocation.
  readonly deleteDraft: (id: string | null) => void;
  // [LAW:no-ambient-temporal-coupling] The single input-settle timer for the url
  // arm's auto-fetch. One slot: each call supersedes the previously scheduled
  // fire, so `fire` runs once, after input has been quiet for the boundary's
  // settle delay. The timer is deliberately dumb — every decision (is this still
  // a fetchable link, is it already adopted or in flight) is made by the store at
  // FIRE time against current state, never captured at schedule time. It lives in
  // EditorIo because a timer is a world effect: mount.ts owns the real
  // setTimeout; a test fires it by hand. Without the settle, detectSources
  // classifies "https://c" as a link mid-hand-typing and every keystroke would
  // fire a paid Firecrawl fetch of a partial URL.
  readonly scheduleFetch: (fire: () => void) => void;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(n, hi));

export class EditorStore {
  blocks: Block[] = [];
  // [LAW:one-source-of-truth] The plain-text source under edit in Text mode —
  // the live copy of the original the architecture declares authoritative. Every
  // change re-derives the blocks (setSource → derive), and a text-arm load syncs
  // it from the origin it adopts (loadTurns), so the pane and the captured
  // origin cannot drift while Text mode is the authority.
  sourceText = "";
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
  // by applyDerive (the single adoption core every derive/fetch/draft-restore
  // passes through). null = authored from scratch. Block edits don't change
  // where the content came from, so they never touch it; `source` (styling),
  // `submitOrigin` (what to stamp) and the dirty baseline (replayedTurns) are
  // all DERIVED from it, never stored apart.
  importOrigin: Origin | null = null;
  view: View = "text";
  importError: string | null = null;
  submitError: string | null = null;
  // [LAW:no-ambient-temporal-coupling] A replacement that would discard
  // non-derived work is a two-phase action (derive/fetch -> confirm -> commit).
  // The middle phase is typed state carrying the already-parsed draft AND the
  // committer it belongs to, not an ordering assumption or a `force` boolean.
  // null = no decision pending.
  pendingReparse: PendingAdoption | null = null;
  // In-flight flag for submit and the server-draft restore. The url fetch has
  // its own richer state (fetchingUrl, below) because it must name WHICH url is
  // in flight; these two only need "running or not".
  busy = false;
  // [LAW:no-ambient-temporal-coupling] The url whose fetch is in flight; null =
  // none. Carrying the URL (not a boolean) is what makes overlapping fetches
  // safe by VALUE: starting a new fetch overwrites it (the newer request is the
  // authority), and a completion applies its result only if it still matches —
  // a superseded response is dropped no matter which order the network returns
  // them in. setSource also nulls it the moment the pane stops holding the
  // fetched url, so a zombie response can never adopt over content the user
  // pasted mid-flight. Also the view's "Fetching…" indicator.
  fetchingUrl: string | null = null;
  // [LAW:no-ambient-temporal-coupling] Two-phase discard: arm (click "Discard
  // draft") → confirm (click "Discard") mirrors the pendingReparse pattern. false
  // = no decision pending; true = the confirm strip is visible.
  pendingDiscard = false;

  // [LAW:one-source-of-truth] The server-side handoff draft this editor was opened
  // from (set by loadServerDraft on success). It is the ONLY in-editor copy of that
  // handle: mount strips ?draft from the URL after a successful restore so the URL
  // stops being a second authoritative copy, leaving this the single place that knows
  // which KV draft a discard should revoke. null = not opened from a server draft.
  serverDraftId: string | null = null;

  constructor(private readonly io: EditorIo) {
    makeAutoObservable<this, "io">(this, { io: false }, { autoBind: true });
  }

  // ── Derived (computed) ──────────────────────────────────────────────────
  // [LAW:one-source-of-truth] turns (and everything Preview draws) are derived
  // from blocks, never stored alongside them — and the blocks themselves are a
  // derived projection of sourceText while Text mode is the authority. The
  // editable preview (view.ts groups blocks with dialogue.ts's spine-split rule
  // and dresses them in the reader's bubble classes) is a projection of this one
  // blocks array; there is no second copy to drift. The block model never holds
  // subagent or usage turns (applyDerive filters to AuthorableTurn), so the
  // editor shows the editable content exactly; subagents that only the stored
  // original carries appear on the permalink, not here, which is correct:
  // authoring nested subagent structure is out of scope, so the editor mirrors
  // what is editable, not what is stored.

  get detected(): ReadonlyArray<InputKind> {
    return detectSources(this.sourceText);
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

  // [LAW:dataflow-not-control-flow][LAW:single-enforcer] The warn-only guard, as a DERIVED
  // value: the same pure scanner that owns "what is a secret" (secret-scan.ts), run over the
  // turns the author is about to publish — not a second detection site that could drift. It is
  // recomputed only when `turns` changes (mobx computed), so the warning tracks every edit
  // live, BEFORE a permanent public link exists, whatever path the content entered by (typed,
  // imported, restored). Purely advisory: nothing here gates canSubmit — the author decides,
  // because a detector has false positives and a hard veto is the wrong contract [LAW:no-silent-failure].
  get secretWarnings(): ReadonlyArray<TurnSecretWarning> {
    return scanTurnsForSecrets(this.turns);
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
    return claudeCodeSessionId(this.sourceText);
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

  // [LAW:one-source-of-truth] The origin to STAMP at submit, keyed on the origin
  // shape and the derived isDirty:
  //   1. Replayable origin, clean: stamp it directly — the stored turns are a pure
  //      projection of parse(origin), so the server's canonicalize replays it.
  //   2. Replayable origin, dirty: the turns are the authority; stamp an editor arm
  //      carrying the origin as `input`, so the imported source is preserved as
  //      provenance rather than silently discarded ([LAW:no-silent-failure]) and
  //      canonicalize keeps the turns verbatim.
  //   3. Editor-arm origin (a restored draft that had already collapsed): the turns
  //      were already the authority when it was captured — it rides through
  //      unchanged, nested provenance intact.
  //   4. No origin: from-scratch authoring — bare editor arm, no provenance.
  get submitOrigin(): Origin {
    const o = this.importOrigin;
    if (o === null) return { kind: "editor", source: null };
    if (o.kind === "editor") return o;
    return this.isDirty ? { kind: "editor", source: sourceOf(o), input: o } : o;
  }

  get fetching(): boolean {
    return this.fetchingUrl !== null;
  }

  // [LAW:one-source-of-truth] The pane's link IS the adopted origin — derived by
  // comparing the two authorities, never stored as a flag that could go stale.
  // Gates the auto-fetch (re-fetching an adopted link would pointlessly re-load
  // and yank the view) and drives the view's "Fetched" affirmation.
  get urlAdopted(): boolean {
    return this.importOrigin?.kind === "url" && this.importOrigin.url === this.sourceText.trim();
  }

  get canSubmit(): boolean {
    return this.blocks.length > 0 && !this.busy && !this.fetching;
  }

  // [LAW:no-ambient-temporal-coupling] Gated exactly as canSubmit: a discard
  // during an in-flight fetch or submit would be overwritten by the completion.
  get canDiscard(): boolean {
    return this.blocks.length > 0 && !this.busy && !this.fetching;
  }

  // [LAW:one-source-of-truth] The baseline dirtiness is judged against is the
  // captured origin ITSELF: the authorable turns replaying it reproduces, or null
  // when nothing replays (no origin, an editor arm, or a capture that reproduces
  // nothing). Derived on demand, never a load-time snapshot — a snapshot goes
  // stale the moment a hand-edited draft is restored: it would report "clean",
  // submit would stamp the raw origin, and the server's canonicalize would
  // re-derive the origin and silently drop the edits [LAW:no-silent-failure].
  private get replayedTurns(): ReadonlyArray<AuthorableTurn> | null {
    if (this.importOrigin === null || this.importOrigin.kind === "editor") return null;
    const replayed = reprojectOrigin(this.importOrigin);
    return replayed === null ? null : replayed.filter(isAuthorable);
  }

  // Dirty = the blocks are NOT a pure projection of a replayable origin: edited
  // since derive/fetch, hand-authored from scratch, or restored already diverged.
  // Turn is pure JSON data (exactly what crosses the wire to /api/paste), so
  // structural-string equality is exact for content and stable for identically-
  // shaped turns. The asymmetry is the whole point: a false "dirty" only
  // over-warns (harmless); it can never under-warn into the silent clobber
  // [LAW:no-silent-failure] forbids.
  get isDirty(): boolean {
    const replayed = this.replayedTurns;
    if (replayed === null) return this.blocks.length > 0;
    return JSON.stringify(this.turns) !== JSON.stringify(replayed);
  }

  // The concept the load-side confirm guards: there is visible non-derived work a
  // replacement would destroy. Empty editor or a pure projection: nothing to lose.
  get wouldClobber(): boolean {
    return this.blocks.length > 0 && this.isDirty;
  }

  // The Text pane's derive replaces the blocks with parse(sourceText). That is
  // silent only when the blocks already ARE a projection of the pane's text (a
  // clean text-arm origin). A pristine url fetch is clean yet NOT derived from
  // the pane — its source is the fetched bytes (text-editing those is s3j.4) —
  // so deriving over it must also confirm rather than silently swap a fetched
  // conversation for a raw parse of whatever sits in the pane.
  get deriveWouldClobber(): boolean {
    return this.wouldClobber || (this.blocks.length > 0 && this.importOrigin?.kind === "url");
  }

  // ── Source pane ─────────────────────────────────────────────────────────

  // [LAW:one-source-of-truth] Editing the source IS editing the authority; the
  // blocks re-derive on every change through the same accept gate every other
  // replacement passes, so a derive that would discard non-derived work stages
  // for confirmation instead of clobbering. importKind is derived from
  // sourceText + userKind, so it re-snaps to the best detection the instant the
  // text changes; an override that no longer matches is dropped by the getter.
  setSource(text: string): void {
    this.sourceText = text;
    this.importError = null;
    // Any previously staged offer no longer matches the pane; derive() below
    // re-stages against the current text or commits cleanly.
    this.pendingReparse = null;
    // [LAW:no-ambient-temporal-coupling] An in-flight fetch is valid only while
    // the pane still holds its url. The moment it doesn't, invalidate it — the
    // completion check in fetchShare then drops the stale response, so a fetch
    // racing a mid-flight paste can never adopt over the newer content, and the
    // "Fetching…" indicator stops lying the same instant.
    if (this.fetchingUrl !== null && this.fetchingUrl !== text.trim()) this.fetchingUrl = null;
    this.derive();
  }

  setImportKind(kind: InputKind): void {
    this.userKind = kind;
    this.importError = null;
    this.pendingReparse = null;
    this.derive();
  }

  setPlatform(platform: Platform | null): void {
    this.userPlatform = platform;
  }

  // [LAW:dataflow-not-control-flow] The continuous projection: parse the pane's
  // text under the active kind and adopt the result. The url guard is the one
  // honest branch — url is the async fetch arm, so it schedules the settle-timed
  // auto-fetch instead of parsing synchronously. importKind is drawn from
  // detectSources, which offers only kinds that parse this exact text, so the
  // only reachable failure is the empty pane — which derives the empty
  // conversation, the same state a fresh visit holds.
  private derive(): void {
    const kind = this.importKind;
    if (kind === "url") {
      this.io.scheduleFetch(this.autoFetch);
      return;
    }
    const result = parseInput(textArmInput(kind, this.sourceText));
    if (!result.ok && this.sourceText.trim().length > 0) {
      // Unreachable while the detection invariant holds; surfaced loudly rather
      // than wiping the blocks under an error [LAW:no-silent-failure].
      this.importError = result.reason;
      return;
    }
    const draft: Draft = result.ok
      ? { turns: result.turns, origin: result.origin }
      : { turns: [], origin: null };
    this.accept(draft, "derive");
  }

  // The settle timer's fire. Every precondition is re-derived from CURRENT
  // state, because the pane may have changed since the fetch was scheduled
  // [LAW:no-ambient-temporal-coupling]:
  //   - isUrl is THE fetchable-link predicate [LAW:single-enforcer] — it also
  //     screens out the empty pane, whose importKind is "url" only as the
  //     all-options priming state, not because a link is present;
  //   - a claude.ai/code link is never fetched (the handoff notice is its path);
  //   - an adopted or already-in-flight link has nothing new to fetch.
  // A declined fire is a genuine no-op (the world moved on), not a swallow.
  autoFetch(): void {
    const url = this.sourceText.trim();
    if (!isUrl(url) || this.claudeCodeLinkId !== null) return;
    if (this.urlAdopted || this.fetchingUrl === url) return;
    void this.fetchShare(url);
  }

  // Manual re-fetch of the pane's link — the retry affordance after a failed
  // auto-fetch. Immediate (no settle: the user just asked), same one fetch path.
  async fetchUrl(): Promise<void> {
    await this.fetchShare(this.sourceText.trim());
  }

  private async fetchShare(url: string): Promise<void> {
    this.fetchingUrl = url;
    this.importError = null;
    const result = await this.io.fetchShare(url);
    runInAction(() => {
      // Superseded: a newer fetch took the slot, or setSource invalidated it
      // because the pane no longer holds this url. The current authority's own
      // completion (or the already-adopted newer content) is the outcome the
      // user sees — this response has no consumer, so dropping it is a genuine
      // no-op, not a swallowed failure.
      if (this.fetchingUrl !== url) return;
      this.fetchingUrl = null;
      if (!result.ok) {
        this.importError = result.reason;
        return;
      }
      this.accept({ turns: result.turns, origin: result.origin }, "load");
    });
  }

  // [LAW:single-enforcer] An agent handoff: restore a server-stored draft
  // (/api/draft) for review. Mirrors fetchShare's busy/error orchestration and
  // converges on the SAME accept() gate, so a handed-off draft enters editing
  // exactly as a fetched import does — dirtiness re-derives against the adopted
  // origin (clean when the turns are its pure projection), and a missing/expired
  // draft surfaces through the same importError channel, never a silent empty
  // editor [LAW:no-silent-failure].
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
      // [LAW:one-source-of-truth] Bind the revocable handle now, so a later discard
      // can DELETE this exact KV draft. Set only on success — a failed restore leaves
      // serverDraftId null, so discarding the resulting empty editor revokes nothing.
      this.serverDraftId = id;
      this.accept(result.draft, "load");
    });
  }

  // ── Blocks ──────────────────────────────────────────────────────────────

  // [LAW:single-enforcer] The one decision every replacement batch passes
  // through: commit now, or stage for confirmation. The gate is via-specific — a
  // load may silently replace any clean projection, a derive only one whose
  // source is the pane's own text — but the stage/commit mechanism is this
  // single point. No `force` flag duplicates the decision at callsites.
  private accept(draft: Draft, via: AdoptionVia): void {
    const clobbers = via === "load" ? this.wouldClobber : this.deriveWouldClobber;
    if (clobbers) {
      this.pendingReparse = { draft, via };
      return;
    }
    this.commit({ draft, via });
  }

  // [LAW:dataflow-not-control-flow] The adoption's own discriminator selects the
  // committer: a load is a full adoption (loadTurns), a derive a light one
  // (applyDerive) — so a confirmed mid-typing derive never yanks the view.
  private commit(adoption: PendingAdoption): void {
    if (adoption.via === "load") this.loadTurns(adoption.draft);
    else this.applyDerive(adoption.draft);
  }

  // The user confirmed a clobbering replacement. Commit the staged adoption
  // through its own committer; a no-op when nothing is staged (idempotent).
  confirmReparse(): void {
    const pending = this.pendingReparse;
    if (pending === null) return;
    this.commit(pending);
  }

  cancelReparse(): void {
    this.pendingReparse = null;
  }

  // [LAW:single-enforcer] Restoring a persisted draft reuses the one loader every
  // batch load passes through; dirtiness then re-derives against the adopted
  // origin, so a draft whose turns already diverged from it restores as dirty by
  // design — its edits keep surviving submit instead of being re-derived away.
  // Called once at mount before any edit; an empty draft ([]) loads to the same
  // empty editor a fresh visit gets, so the caller never branches on "is there
  // a draft".
  restoreDraft(draft: Draft): void {
    this.loadTurns(draft);
  }

  // The light adoption — blocks + provenance only, shared core of every commit.
  // [LAW:types-are-the-program] usage/subagent turns are source-derived, not
  // author-able content; the editor holds only AuthorableTurns, so they are
  // dropped here at the single seam where turns become blocks. The dirty
  // baseline needs no reset: it is DERIVED from the adopted origin
  // (replayedTurns), which reprojects to this same filtered set.
  private applyDerive(draft: Draft): void {
    this.blocks = toBlocks(draft.turns.filter(isAuthorable));
    this.importOrigin = draft.origin;
    this.pendingReparse = null;
  }

  // [LAW:single-enforcer] The full adoption every batch load (fetch, handoff,
  // restore, discard, confirmed load) passes through, built on the same light
  // core the derive uses, plus the load-only resets:
  //   - Theme: a VALUE the draft carries, not a branch on how loadTurns was
  //     reached. A fresh fetch carries no override, so theme re-snaps to
  //     detection; a restored draft's explicit pick is honored, so the editor
  //     reopens — and later republishes — the theme that was saved.
  //   - Source pane: syncs to the plain-text source the adopted origin carries
  //     (a restored draft would otherwise show a stale pane over new blocks);
  //     origins without one (url/editor/none) leave the pane alone.
  //   - Landing view: loaded content is for reviewing — Preview; an empty load
  //     (discard, fresh visit) lands in Text, the paste target.
  private loadTurns(draft: Draft): void {
    this.applyDerive(draft);
    this.userPlatform = draft.platformOverride ?? null;
    const src = sourceTextOf(draft.origin);
    if (src !== null) this.sourceText = src;
    this.view = this.blocks.length === 0 ? "text" : "preview";
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

  // Appends in place — no view snap: both views are editable, so the new block
  // appears wherever the author is working.
  addBlock(kind: Kind): void {
    this.blocks.push({ id: newId(), turn: emptyTurn(kind) });
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

  // [LAW:no-silent-failure] The author acts on the secret warning: REMOVE the flagged
  // secrets from what will be STORED, not merely from the display. It rewrites the two
  // authorities the stored paste derives from — the editable blocks (whose content becomes
  // the published turns) and importOrigin (whose preserved text reproject would otherwise
  // resurrect the secret from). Every derived value (turns, secretWarnings, submitOrigin,
  // both views' rendered blocks) recomputes off them, so the banner clears and the author
  // SEES the redaction BEFORE publishing.
  //
  // This is the deliberate, author-triggered, secret-only exception to store-the-original-
  // verbatim (ARCHITECTURE.md, [LAW:one-source-of-truth]): a leaked credential is the one
  // payload where keeping the original bytes is a liability, so here — and ONLY here — the
  // stored original is edited, not overlaid. Each block keeps its id (scrubTurn is a content
  // edit, never a shape change), so the keyed render survives. importOrigin === null is the
  // genuine "authored from scratch" state — no upstream text to scrub, and the turns are the
  // sole stored copy already scrubbed via the blocks [LAW:no-defensive-null-guards].
  //
  // The importOrigin scrub is LOAD-BEARING for a text/url import: an edit makes isDirty true,
  // so submitOrigin nests the (now-scrubbed) importOrigin as `input`, and that scrubbed
  // provenance is what reaches KV (the reproject source). For an editor-arm importOrigin,
  // submitOrigin drops `input` entirely, so scrubbing it there does not flow to storage — the
  // scrub of that arm is belt-and-suspenders: scrubOrigin stays exhaustive over every Origin
  // shape so the pure transform is honest and any future path that re-reads `input` inherits a
  // clean value, never a resurrected secret.
  redactSecrets(): void {
    this.blocks = this.blocks.map((b) => ({ id: b.id, turn: scrubTurn(b.turn) }));
    if (this.importOrigin !== null) this.importOrigin = scrubOrigin(this.importOrigin);
    // [LAW:one-source-of-truth] The pane is the live copy of the origin's text,
    // so it re-syncs from the freshly-scrubbed origin — the same origin→pane
    // sync loadTurns performs. Without this the pane keeps DISPLAYING the
    // secret the author just removed, and the next keystroke's derive would
    // silently re-adopt it from the un-scrubbed text [LAW:no-silent-failure].
    // scrubOrigin stays the one scrub enforcer; the pane never gets its own.
    const src = sourceTextOf(this.importOrigin);
    if (src !== null) this.sourceText = src;
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
  // The source-pane scratch (sourceText, userKind, importError, submitError) is
  // cleared here because loadTurns deliberately leaves it alone for origins that
  // carry no text — discard returns to the fresh-visit state.
  // [LAW:effects-at-boundaries] The store never touches localStorage directly.
  discard(): void {
    this.loadTurns({ turns: [], origin: null });
    this.sourceText = "";
    this.userKind = null;
    this.importError = null;
    this.submitError = null;
    this.pendingDiscard = false;
    // [LAW:effects-at-boundaries] Revoke both copies of the draft: the localStorage
    // copy (clearDraft) and the server-side KV handoff copy (deleteDraft). The id is
    // passed as a value — null when this wasn't a server handoff, which the boundary
    // no-ops — then cleared, so a second discard doesn't re-issue a stale revoke.
    this.io.clearDraft();
    this.io.deleteDraft(this.serverDraftId);
    this.serverDraftId = null;
  }
}
