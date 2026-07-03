// [LAW:types-are-the-program] A paste is an ordered list of typed events plus
// identity + lifetime. Each event kind carries exactly the fields it needs and
// no more — illegal states (a tool-call without a tool name, an insight with a
// role) are not representable.
//
// Source format (Claude Code / ChatGPT / Claude.ai / markdown headers) is a
// value the parser consumes and discards. It is *not* a type axis: there is
// no `CCConversation` vs `ChatGPTConversation`. Every parser converges to this
// same union, and downstream rendering operates on `kind` alone.

// [LAW:one-source-of-truth] The runtime tuple is the source; the type is
// derived from it. isTurn (below) iterates the tuple to validate wire JSON —
// so the set of legal roles cannot drift between the type and the validator.
export const ROLES = ["user", "assistant", "system"] as const;
export type Role = (typeof ROLES)[number];

export const TOOL_OUTPUT_KINDS = ["terminal", "file-read", "diff", "generic"] as const;
export type ToolOutputKind = (typeof TOOL_OUTPUT_KINDS)[number];

// [LAW:types-are-the-program] A tool result carries its rendered text AND whether
// it errored. `isError` is real source structure (the Claude tool_result block's
// `is_error`), not a heuristic over `text` — a pass/fail badge derived from a
// substring search would be a synthesized summary that drifts ([LAW:no-silent-
// failure]). Formats with no structured error marker (cc transcripts, claude-share)
// report `false`: honest absence of a captured error, never a guess. The absence
// of a *result* is modeled one level up by `output: ToolOutput | null` — so the
// three honest display states (no result / ok / error) are all representable.
export interface ToolOutput {
  readonly kind: ToolOutputKind;
  readonly text: string;
  readonly isError: boolean;
}

// [LAW:types-are-the-program] Token usage is a property of one *logical
// assistant message* (one API response), not of a line or a single content
// block. Every field is a non-negative count present in the source; there is
// no "unknown" member, because the ABSENCE of usage is modeled by the absence
// of a `usage` Turn — not by a usage object full of zeros. A source that
// carries no token data (claude-share, pasted text) therefore emits no usage
// Turns at all. [LAW:no-silent-failure] — counts are never fabricated.
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
}

// [LAW:types-are-the-program] The `usage` arm is a typed event in the ordered
// stream like any other — it carries exactly a Usage and nothing else. It is
// the one Turn kind that is NOT author-able: it is derived from source token
// accounting, never typed by a human. The editor excludes it by operating on
// the AuthorableTurn subtype (see src/editor/blocks.ts), so a usage event can
// be parsed, stored, and rendered, but never hand-edited into existence.
export type Turn =
  | { readonly kind: "message"; readonly role: Role; readonly content: string }
  | {
      readonly kind: "tool-call";
      readonly tool: string;
      readonly args: string;
      readonly output: ToolOutput | null;
    }
  | { readonly kind: "insight"; readonly content: string }
  | { readonly kind: "thinking"; readonly content: string }
  | { readonly kind: "turn-summary"; readonly text: string }
  | { readonly kind: "usage"; readonly usage: Usage }
  | {
      // [LAW:types-are-the-program] A subagent run owned by the spawning Agent
      // tool-call. It is recursive: a captured transcript is itself a Turn[],
      // rendered by the same recursive renderer one level nested. Like `usage`,
      // it is source-DERIVED, never hand-authored (the editor excludes it via
      // AuthorableTurn). agentType/description identify the run on the condensed
      // line; stepCount is the source's own tool-use count (0 when the source
      // carried none — honest absence, never invented). [LAW:no-silent-failure]
      readonly kind: "subagent";
      readonly agentType: string | null;
      readonly description: string | null;
      readonly stepCount: number;
      readonly transcript: SubagentTranscript;
    };

// [LAW:types-are-the-program] A captured transcript always has at least the
// subagent's spawn prompt, so it is a NON-EMPTY list of turns. Encoding that as a
// tuple type makes "captured but empty" — a captured run that captured nothing,
// indistinguishable from summary-only — unrepresentable, rather than a state the
// producers merely promise to avoid.
export type NonEmptyTurns = readonly [Turn, ...ReadonlyArray<Turn>];

// [LAW:types-are-the-program] The two — and only two — honest outcomes of
// capturing a subagent's run. `captured` carries the full nested transcript (the
// run reattached from the stored original); `summary-only` is graceful
// degradation when that transcript was never captured (uploaded before the
// subagent files were bundled, or the file was absent) — all the source still
// holds is the spawn prompt and the final returned result. A "captured but
// empty" or "both" state is unrepresentable. The prompt of a captured run is its
// transcript's first user turn, so it is not duplicated here.
export type SubagentTranscript =
  | { readonly kind: "captured"; readonly turns: NonEmptyTurns }
  | { readonly kind: "summary-only"; readonly prompt: string; readonly result: string };

// [LAW:types-are-the-program] The runtime witness of the Turn union. It lives
// beside the type so the two cannot drift: add an arm above and the exhaustive
// switch below stops compiling until this validator learns it. The editor
// submits an already-pristine Turn[] (its editor-only `id` is mapped away
// client-side), but the API trust boundary cannot trust that — a directly
// crafted request is classified here, where every illegal shape is rejected by
// construction rather than crashing downstream render/store.
const isToolOutput = (v: unknown): v is ToolOutput => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; text?: unknown; isError?: unknown };
  return (
    typeof o.text === "string" &&
    typeof o.isError === "boolean" &&
    (TOOL_OUTPUT_KINDS as ReadonlyArray<string>).includes(o.kind as string)
  );
};

const isRole = (v: unknown): v is Role =>
  typeof v === "string" && (ROLES as ReadonlyArray<string>).includes(v);

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

const isUsage = (v: unknown): v is Usage => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    isCount(o.input) &&
    isCount(o.output) &&
    isCount(o.cacheCreation) &&
    isCount(o.cacheRead)
  );
};

export const isTurn = (v: unknown): v is Turn => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // [LAW:dataflow-not-control-flow] One switch on the discriminator; each arm
  // checks exactly the fields its kind carries. The default closes the
  // enumeration gap: an unknown kind is rejected, never silently accepted.
  switch (o.kind) {
    case "message":
      return isRole(o.role) && typeof o.content === "string";
    case "tool-call":
      return (
        typeof o.tool === "string" &&
        typeof o.args === "string" &&
        (o.output === null || isToolOutput(o.output))
      );
    case "insight":
      return typeof o.content === "string";
    case "thinking":
      return typeof o.content === "string";
    case "turn-summary":
      return typeof o.text === "string";
    case "usage":
      return isUsage(o.usage);
    case "subagent":
      return (
        (o.agentType === null || typeof o.agentType === "string") &&
        (o.description === null || typeof o.description === "string") &&
        isCount(o.stepCount) &&
        isSubagentTranscript(o.transcript)
      );
    default:
      return false;
  }
};

// [LAW:types-are-the-program] The runtime witness for the recursive transcript.
// `captured` validates its nested turns through isTurns (mutual recursion with
// isTurn — sound because both are only invoked at call time, never module-init).
// [LAW:dataflow-not-control-flow] One switch on the discriminator; the default
// closes the enumeration gap so an unknown transcript kind is rejected.
const isSubagentTranscript = (v: unknown): v is SubagentTranscript => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; turns?: unknown; prompt?: unknown; result?: unknown };
  switch (o.kind) {
    case "captured":
      // Non-empty: a captured transcript with zero turns is the unrepresentable
      // "captured but empty" state, rejected here at the KV trust boundary too.
      return isTurns(o.turns) && o.turns.length > 0;
    case "summary-only":
      return typeof o.prompt === "string" && typeof o.result === "string";
    default:
      return false;
  }
};

// [LAW:types-are-the-program] Refine a list to NonEmptyTurns by its length — the
// one checked narrowing the parser uses so a `captured` transcript is non-empty
// by construction, never an unchecked cast.
export const isNonEmptyTurns = (turns: ReadonlyArray<Turn>): turns is NonEmptyTurns =>
  turns.length > 0;

// [LAW:types-are-the-program] An empty array IS a Turn[]; this guard answers
// only "is every element a Turn". The "a paste must have ≥1 turn" rule is a
// separate invariant the API boundary enforces, so this predicate stays honest
// to its name.
export const isTurns = (v: unknown): v is Turn[] =>
  Array.isArray(v) && v.every(isTurn);

// [LAW:types-are-the-program] A paste's lifetime has exactly two honest shapes:
// it expires at a known instant, or it is pinned and never expires. "Never"
// cannot be a number — a sentinel (0 / Infinity / null) on an `expiresAt: number`
// would be a representation that lies, forcing every reader to special-case it.
// The discriminated union makes "pinned" a first-class value: the `pinned` arm
// carries no deadline because it has none, so an illegal "pinned but expiring"
// state is unrepresentable.
export type Lifetime =
  | { readonly kind: "expires"; readonly expiresAt: number }
  | { readonly kind: "pinned" };

// [LAW:types-are-the-program] An author display-overlay: directives that alter how the
// stored conversation is DISPLAYED without touching the verbatim original
// (ARCHITECTURE.md). Each directive targets a range. The overlay is AUTHORED intent — it
// cannot be re-derived from the turns, so it is authoritative source data stored ON the
// record [LAW:one-source-of-truth], never a turns-hash cache (which would silently drop
// redactions on an edit — [LAW:no-silent-failure] in a security feature). It is applied
// at render by applyOverlay (overlay.ts) to the derived Dialogue; the stored
// turns/origin are never mutated.
//
// [LAW:types-are-the-program] The target is a union: the `turn` arm names a whole
// top-level spine node (the t<N> permalink already addresses it); the `span` arm names a
// HALF-OPEN [start,end) character range WITHIN one of that node's prose pieces, so a
// redaction can hide a leaked secret INSIDE a turn without hiding the turn. A span is a
// finer target of the SAME `hide` directive, not a new directive kind — sub-turn and
// whole-turn redaction are one behavior differing only in the target value
// [LAW:one-type-per-behavior].
//
// `piece` is a 0-based index into the node's ordered prose pieces (overlay.ts:spanPieces):
// a spoken node has exactly one piece (its content); an assistant node has one per
// free-prose block (text/insight/thinking) in block order. Structured/nested content
// (tool calls, subagent transcripts) is not span-addressable — whole-turn `hide` is its
// superset. `start < end` (below) makes an empty or inverted range — one that would redact
// nothing — unrepresentable [LAW:no-silent-failure].
//
// [LAW:types-are-the-program] TurnTarget is named because it is the target shape the
// WHOLE-turn directives (collapse, feature — below) share: they fold or omit an entire
// spine node, so a sub-turn span target is nonsensical for them and is made unrepresentable
// by typing their `target` as TurnTarget, not the wider OverlayTarget. Only `hide` (content
// redaction) reaches inside a turn, so only `hide` carries the span arm.
export type TurnTarget = { readonly kind: "turn"; readonly index: number };
export type OverlayTarget =
  | TurnTarget
  | {
      readonly kind: "span";
      readonly index: number;
      readonly piece: number;
      readonly start: number;
      readonly end: number;
    };

// [LAW:one-type-per-behavior] Redact/fold/feature are INSTANCES of one range-directive
// family, not three unrelated features — each names a range (a turn, or a sub-turn span)
// and one display effect. `hide` replaces content in place (length/anchor preserving, zero
// renderer branch); `collapse` folds a whole spine node behind a disclosure; `feature`
// whitelists — the presence of ANY feature directive shows ONLY the featured turns
// (highlight reel). collapse/feature operate on whole turns (TurnTarget); only hide reaches
// sub-turn spans. [LAW:types-are-the-program] The kind is the discriminator applyOverlay's
// exhaustive dispatch (overlay.ts) is compiler-forced to handle — never a parallel path.
export type OverlayDirective =
  | { readonly kind: "hide"; readonly target: OverlayTarget }
  | { readonly kind: "collapse"; readonly target: TurnTarget }
  | { readonly kind: "feature"; readonly target: TurnTarget };

export type Overlay = ReadonlyArray<OverlayDirective>;

// [LAW:types-are-the-program] The runtime witnesses of the overlay types. A stored
// overlay (KV) and a POSTed directives body are both unknown JSON until classified
// here; every illegal shape is rejected by construction, so no caller downstream
// re-defends. [LAW:single-enforcer] this ONE validator is shared by the read boundary
// (storage.normalizeOverlay) and the write boundary (the /api/overlay handler) — the two
// cannot disagree about what a legal overlay is.
//
// Every coordinate is a NON-NEGATIVE INTEGER: index names a top-level spine node (t0, t1,
// …), piece a prose piece within it, start/end offsets into that piece. A fractional or
// negative coordinate addresses nothing — an illegal state made unrepresentable at the
// boundary rather than a silent no-op downstream. The span arm additionally requires
// start < end, so an empty or inverted range (which would redact nothing) cannot be stored
// [LAW:no-silent-failure]. Whether the coordinates point at a REAL node/piece/range of a
// given paste is a per-paste fact outOfRangeTarget (overlay.ts) checks at the write edge.
const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

// A whole-turn target: the `turn` arm alone, for the directives that address a node and
// never a span. Shared by isOverlayTarget's turn case so the two cannot disagree.
const isTurnTarget = (v: unknown): v is TurnTarget => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; index?: unknown };
  return o.kind === "turn" && isNonNegInt(o.index);
};

const isOverlayTarget = (v: unknown): v is OverlayTarget => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; index?: unknown; piece?: unknown; start?: unknown; end?: unknown };
  switch (o.kind) {
    case "turn":
      return isTurnTarget(o);
    case "span":
      return (
        isNonNegInt(o.index) &&
        isNonNegInt(o.piece) &&
        isNonNegInt(o.start) &&
        isNonNegInt(o.end) &&
        o.start < o.end
      );
    default:
      return false;
  }
};

// [LAW:dataflow-not-control-flow] One switch on the discriminator; the default closes
// the enumeration gap — an unknown kind is rejected, never silently accepted. hide accepts
// either target arm (turn or span); collapse/feature accept the whole-turn target only, so
// a stored `{kind:"collapse", target:{kind:"span",…}}` is rejected at the boundary rather
// than reaching a renderer that cannot fold a char range.
export const isOverlayDirective = (v: unknown): v is OverlayDirective => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; target?: unknown };
  switch (o.kind) {
    case "hide":
      return isOverlayTarget(o.target);
    case "collapse":
    case "feature":
      return isTurnTarget(o.target);
    default:
      return false;
  }
};

export const isOverlay = (v: unknown): v is Overlay =>
  Array.isArray(v) && v.every(isOverlayDirective);

export interface Conversation {
  readonly slug: string;
  readonly createdAt: number;
  readonly lifetime: Lifetime;
  // [LAW:types-are-the-program] Deletion is orthogonal to Lifetime — a paste can
  // be soft-deleted before it expires, or it can expire with no explicit delete.
  // null = live; a timestamp = tombstoned at that instant. The KV record survives
  // the tombstone; only the purge step hard-deletes it after the grace window.
  // ([LAW:no-silent-failure]: absence of this field on legacy records normalizes
  // to null on read — never silently treated as "deleted".)
  readonly deletedAt: number | null;
  // [LAW:one-source-of-truth] Turns are a DERIVED CACHE of parse(origin), not an
  // authority. They are stored in KV for read-path speed, but they are
  // regenerable: reprojectOrigin(origin) reproduces them (often *better*, once
  // the parser improves). The authority is `origin` below — the exact input
  // that, replayed through the parser, yields this projection.
  readonly turns: ReadonlyArray<Turn>;
  readonly title: string | null;
  // [LAW:one-source-of-truth] The captured source of truth — the verbatim input
  // this paste was created from. null = legacy pre-capture record (no origin
  // stored). `source` (which SourceKind ingested it, for styling) is DERIVED via
  // sourceOf(origin) — never stored independently, so the two cannot drift.
  readonly origin: Origin | null;
  // [LAW:one-source-of-truth] Optional user-chosen platform override. When set,
  // the permalink uses this instead of deriving from source — makes the editor's
  // theme choice meaningful on the shared link. Absent = derive from source as
  // always. `source` remains authoritative; this is a display override only.
  readonly platformOverride?: Platform;
  // [LAW:one-source-of-truth] Optional AUTHORED display-overlay (redact/fold/feature
  // directives) applied to the derived display at render — it never mutates the verbatim
  // turns/origin. Authored intent, not a derivation, so it lives ON the record rather
  // than in a derived cache. Absent = no overlay = the paste renders exactly as
  // captured. Normalized on read (like deletedAt/platformOverride), so legacy records
  // need no migration.
  readonly overlay?: Overlay;
}

// [LAW:single-enforcer] Three distinct time windows, stated once:
//   TTL_SECONDS     — active lifetime; paste hides from public reads at W+30d
//   GRACE_SECONDS   — grace window; isPurgeable fires at W+60d (TTL+GRACE)
//   PURGE_BUFFER_SECONDS — gap between isPurgeable and KV backstop eviction
// The KV expirationTtl is TTL+GRACE+BUFFER, so KV fires at W+67d — AFTER
// isPurgeable, giving the purge a 7-day window to run and log the deletion
// before KV auto-evicts silently. Without the buffer, both thresholds fire at
// the same instant; KV always wins and the audit trail is empty for natural
// expiry. [LAW:no-silent-failure]: the buffer is the only thing that lets the
// purge's audit log be the authoritative deletion record.
export const TTL_DAYS = 30;
export const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;
export const GRACE_DAYS = 30;
export const GRACE_SECONDS = GRACE_DAYS * 24 * 60 * 60;
export const PURGE_BUFFER_DAYS = 7;
export const PURGE_BUFFER_SECONDS = PURGE_BUFFER_DAYS * 24 * 60 * 60;

// [LAW:one-source-of-truth] "Expires a full TTL from now" is one policy, stated
// once here and shared by paste creation and refresh. Both compute the deadline
// from the same `now` + TTL_SECONDS, so a refreshed paste and a freshly created
// one get an identical lifetime by construction — the clock cannot drift between
// the two call sites. `now` is passed in (the clock is an effect owned by the
// boundary), keeping this constructor pure.
export const lifetimeFromChoice = (choice: LifetimeChoice, now: number): Lifetime =>
  choice === "pinned"
    ? { kind: "pinned" }
    : { kind: "expires", expiresAt: now + TTL_SECONDS * 1000 };

// [LAW:types-are-the-program] The wire-level *intent* a client may express is
// narrower than a full Lifetime: a caller picks pin-or-expire, never an
// arbitrary deadline. The expires intent carries no `expiresAt` — the server
// stamps it via lifetimeFromChoice — so a client cannot forge a far-future
// expiry. The tuple is the source; the type and the /api/refresh validator both
// derive from it so the legal set cannot drift.
export const LIFETIME_CHOICES = ["expires", "pinned"] as const;
export type LifetimeChoice = (typeof LIFETIME_CHOICES)[number];

// [LAW:dataflow-not-control-flow] The remaining-days math lives once. Views read
// this projection and format their own words; neither view recomputes the
// formula nor decides whether to render the column. The `pinned` case is a value
// here, not a branch a caller might forget — so "Disappears in 0 days" for a
// pinned paste is unrepresentable.
export type LifetimeView =
  | { readonly kind: "expires"; readonly days: number }
  | { readonly kind: "pinned" };

export const viewLifetime = (lifetime: Lifetime, now: number): LifetimeView =>
  lifetime.kind === "pinned"
    ? { kind: "pinned" }
    : { kind: "expires", days: Math.max(0, Math.ceil((lifetime.expiresAt - now) / 86_400_000)) };

// [LAW:types-are-the-program] A paste is hidden from public reads when it has
// been explicitly soft-deleted (deletedAt set) OR when its expiry has passed
// (lifetime expired). Both are separate axes: a paste can expire while pinned
// is unrepresentable (pinned has no expiresAt), but an expires paste can be
// deleted before its natural deadline. This is the single gate for all callers
// ([LAW:single-enforcer]: one place, not scattered "isExpired" checks).
export const isHiddenFromPublic = (c: Conversation, now: number): boolean =>
  c.deletedAt !== null ||
  (c.lifetime.kind === "expires" && c.lifetime.expiresAt < now);

// [LAW:types-are-the-program] A paste is eligible for hard-deletion (purge)
// when it is hidden AND the grace window has elapsed since it was hidden.
// The "hidden since" timestamp: explicit deletedAt takes precedence; expiry
// falls back to expiresAt (the moment the paste became hidden via auto-expiry).
// Pinned pastes that were never deleted are never purgeable.
export const isPurgeable = (c: Conversation, now: number): boolean => {
  if (!isHiddenFromPublic(c, now)) return false;
  const hiddenSince = c.deletedAt ?? (c.lifetime.kind === "expires" ? c.lifetime.expiresAt : null);
  if (hiddenSince === null) return false;
  return now - hiddenSince > GRACE_SECONDS * 1000;
};

// [LAW:one-source-of-truth] The size cap is stated once, as a byte count. The
// API enforces MAX_PASTE_BYTES at the trust boundary; the index page shows
// MAX_PASTE_LABEL in its hint. The label is *derived* from the byte count so the
// advertised limit cannot drift from (or unit-mismatch) the enforced one — a
// hardcoded "256 KB" hint once outlived the real cap.
export const MAX_PASTE_BYTES = 8 * 1024 * 1024;
export const MAX_PASTE_LABEL = `${MAX_PASTE_BYTES / (1024 * 1024)} MiB`;

// [LAW:types-are-the-program] Discriminated result instead of throws/null
// so callers must structurally handle both outcomes.
//
// [LAW:one-source-of-truth] A successful parse carries the `origin` it consumed
// — the verbatim source of truth, reported by the one code that knows it (the
// parser that matched). `turns` is the projection; `origin` is what reproduces
// it. Provenance for styling is derived from origin via sourceOf, never a
// second field that could disagree with the input actually captured.
export type ParseResult =
  | { ok: true; turns: ReadonlyArray<Turn>; origin: Origin }
  | { ok: false; reason: string };

// [LAW:one-type-per-behavior] A Provider is which recognized conversation host a
// fetched URL came from — a VALUE the url arm carries, never a per-provider arm
// kind. Every provider shares one behavior (fetch the link, store the original
// bytes, derive turns from a pure parser), differing only in the URL pattern that
// identifies it and the parser that projects it — values the registry holds
// (slopspot-url-ingestion-wfd.3). A Provider is also the styling identity of a
// fetched paste: every Provider is a SourceKind, so it maps to a Platform exactly
// as the text kinds do. Today the one provider whose parser exists is
// claude-share; .3/.4 widen this set as their parsers land.
export const PROVIDERS = ["claude-share", "chatgpt-share"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (v: unknown): v is Provider =>
  typeof v === "string" && (PROVIDERS as ReadonlyArray<string>).includes(v);

// [LAW:types-are-the-program] PasteInput IS the input to parsing — each arm
// carries exactly the fields its parser needs and no more. A flat enum with a
// separate `content` field would admit illegal pairings (e.g. a URL-kind with
// `content` and no URL); the discriminated shape forbids them by construction.
//
// [LAW:single-enforcer] Network access lives on exactly one arm. Text arms
// dispatch to local pure parsers; only the url arm can reach the network. The
// cost model is visible in the types — no scattered `if (looksLikeUrl(...))
// fetch(...)` gates.
//
// [LAW:one-type-per-behavior] The text kinds are one structural arm keyed by
// TextArmKind — identical "carry the content" behavior — and the url arm is the
// single generic fetch arm. There is no bespoke arm per provider: a new provider
// is a VALUE (its pattern + parser in the registry), not a new PasteInput shape.
// The url arm carries no provider yet — that is resolved from the URL during
// ingestion and stamped on the stored origin below.
export type PasteInput =
  | { readonly kind: TextArmKind; readonly content: string }
  | { readonly kind: "url"; readonly url: string };

// [LAW:types-are-the-program] The URL/text bifurcation IS the type — text arms
// expose `content`, the url arm exposes `url`. Code that needs to read "the
// user-supplied string regardless of shape" goes through this accessor so the
// discriminator stays the single point of dispatch.
export const inputText = (input: PasteInput): string =>
  input.kind === "url" ? input.url : input.content;

// [LAW:types-are-the-program] The kinds a user picks at the input boundary —
// exactly PasteInput's discriminator: the text arms, or the generic "url" fetch
// arm. Deliberately DISTINCT from SourceKind: SourceKind carries Providers
// (claude-share, …) for styling, but the user never PICKS a provider — it is
// resolved from the URL server-side at fetch time. So detection and the dropdown
// speak InputKind ("any link is one 'url' option"), while provenance/styling
// speaks SourceKind. The two axes meet only at ingest, where the url arm's
// resolved Provider becomes the stored origin's styling identity.
export type InputKind = PasteInput["kind"];

// [LAW:one-source-of-truth] SourceKind is the provenance/styling identity set —
// the dropdown options, the parser-dispatch keys, the platform-styling keys. It
// derives from the SOURCE_KINDS tuple (below), NOT from PasteInput["kind"]: the
// url arm's discriminator is the generic "url", while a fetched paste's
// provenance is its Provider (claude-share, …). The two axes are deliberately
// distinct — every Provider is a SourceKind; the text kinds are the rest.
export type SourceKind = (typeof SOURCE_KINDS)[number];

// [LAW:types-are-the-program] The content-bearing kinds (every SourceKind that is
// not a URL Provider) and a typed constructor for building their PasteInput.
// Callers that hold a text kind + content build the arm through textArmInput so
// the union shape is checked by the compiler — no `as PasteInput` assertion that
// would mask the url-shaped arm.
export type TextArmKind = Exclude<SourceKind, Provider>;
export const textArmInput = (kind: TextArmKind, content: string): PasteInput => ({
  kind,
  content,
});

// [LAW:types-are-the-program] Origin is the captured source of truth — the exact
// input a paste was created from, in the strongest shape that lets us replay it
// without the network. It is PasteInput's storable twin: every text arm already
// carries its verbatim `content`, so those collapse to one structural arm keyed
// by kind ([LAW:one-type-per-behavior] — the text kinds, identical "carry the
// content" behavior). The url arm is the one that was lossy: it keeps the link,
// the original fetched markdown (HAR-spirit: the bytes, not just a pointer), AND
// the Provider tag, so re-projection parses the stored bytes through that
// provider's parser rather than re-hitting Firecrawl.
//
// The `editor` arm is in-editor authoring: there is no upstream input the parser
// consumed — the (possibly hand-edited) Turns ARE the source, so reprojectOrigin
// returns null for it. It is a distinct CASE, not a `null` ([LAW:types-are-the-
// program]: absence-of-upstream-input modeled as a variant). It still carries
// `source`: the editor is the universal submit path and knows which platform its
// turns were imported from, and that provenance is the styling authority. Keeping
// it on the variant is what lets `source` stay 100% derived from origin
// ([LAW:one-source-of-truth]) without stripping platform styling from every
// editor-submitted paste.
//
// The optional `input` field captures the original submitted input when the user
// EDITS an imported paste before submitting. In that case the stored turns diverge
// from parse(input) — turns are the authority — but input preserves the provenance
// so it is never silently discarded ([LAW:no-silent-failure]). Absent = authored
// from scratch or edited from an editor-origin draft (no upstream text to replay).
// [LAW:types-are-the-program] `input` is scoped to the replayable arms (text/url)
// — an editor arm has no upstream text and can never be a valid provenance source,
// so that state is unrepresentable. This also keeps isOrigin non-recursive.
// [LAW:types-are-the-program] The url arm's `provider` is `Provider | null`:
// null is the honest "fetched from a host no registered provider claims" state —
// a value distinct from each known provider, not a missing field. Re-projection
// reads it to pick the parser (a named provider's parser, or the best-effort
// fallback for null), and styling derives generic from null. A fetched paste
// whose host gained a provider later still re-derives correctly: the stored
// bytes are the authority, the provider tag only selects which parser replays them.
export type ReplayableOrigin =
  | { readonly kind: TextArmKind; readonly content: string }
  | {
      readonly kind: "url";
      readonly url: string;
      readonly fetched: string;
      readonly provider: Provider | null;
    };

export type Origin =
  | ReplayableOrigin
  | { readonly kind: "editor"; readonly source: SourceKind | null; readonly input?: ReplayableOrigin };

export const isTextArmKind = (v: unknown): v is TextArmKind =>
  typeof v === "string" && (TEXT_ARM_KINDS as ReadonlyArray<string>).includes(v);

const isReplayableOrigin = (v: unknown): v is ReplayableOrigin => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; content?: unknown; url?: unknown; fetched?: unknown; provider?: unknown };
  if (o.kind === "url") {
    return (
      typeof o.url === "string" &&
      typeof o.fetched === "string" &&
      (o.provider === null || isProvider(o.provider))
    );
  }
  return isTextArmKind(o.kind) && typeof o.content === "string";
};

// [LAW:types-are-the-program] KV is a trust boundary; a stored origin is unknown
// JSON until classified. [LAW:dataflow-not-control-flow] One switch on the
// discriminator, each arm checking exactly the fields its kind carries; the
// default closes the enumeration gap — an unknown kind is rejected, never
// silently accepted.
export const isOrigin = (v: unknown): v is Origin => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; source?: unknown; input?: unknown };
  if (o.kind === "editor") {
    if (o.source !== null && !isSourceKind(o.source)) return false;
    return o.input === undefined || isReplayableOrigin(o.input);
  }
  return isReplayableOrigin(v);
};

// [LAW:single-enforcer] / [LAW:one-source-of-truth] The ONE migration that lifts a
// legacy origin shape to the current one, co-located with Origin and isOrigin so it
// cannot drift from the type it migrates. Records and drafts written before the URL
// arm was generalized store a fetched origin as { kind:"claude-share", url, fetched };
// the current shape is the generic url arm tagged with its provider. BOTH consumers
// run this exact function: the server (storage.normalizeOrigin, reading KV) and the
// client (editor draft loader, reading localStorage). This is the governing
// architecture in action — stored bytes are untouched; the new shape is DERIVED on
// read, so the rename costs zero migration and no caller can forget to apply it.
// [LAW:no-silent-failure] Only the exact legacy share shape is rewritten; any other
// value passes through unchanged to isOrigin, which rejects junk to null.
const upgradeReplayable = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as { kind?: unknown; url?: unknown; fetched?: unknown };
  if (o.kind === "claude-share" && typeof o.url === "string" && typeof o.fetched === "string") {
    return { kind: "url", url: o.url, fetched: o.fetched, provider: "claude-share" };
  }
  return raw;
};

export const upgradeOrigin = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as { kind?: unknown; input?: unknown };
  if (o.kind === "editor") {
    return o.input === undefined ? raw : { ...o, input: upgradeReplayable(o.input) };
  }
  return upgradeReplayable(raw);
};

// [LAW:one-source-of-truth] The single derivation of styling provenance from the
// canonical origin. A text or share arm reports its own kind; the editor arm
// reports the provenance it carried; a url arm reports its Provider (the host it
// was fetched from); legacy (null) origin and from-scratch editor authoring both
// report null — honest absence, rendered as the generic platform. Nothing
// re-guesses the platform from content.
// [LAW:dataflow-not-control-flow] One total projection over the origin shapes;
// each arm names the SourceKind it contributes, so styling is a value, not a
// scattered set of `if (kind === …)` guesses.
export const sourceOf = (origin: Origin | null): SourceKind | null => {
  if (origin === null) return null;
  if (origin.kind === "editor") return origin.source;
  if (origin.kind === "url") return origin.provider;
  return origin.kind;
};

// [LAW:one-source-of-truth] The single derivation of "where on the web this paste
// came from" — the fetched link, or null for every origin without an upstream URL
// (text arms carry verbatim content, editor authoring and legacy records have no
// source URL). The paste page reads this projection of the canonical origin;
// nothing re-guesses a URL from content or stores it as a second field.
export const sourceUrlOf = (origin: Origin | null): string | null =>
  origin?.kind === "url" ? origin.url : null;


// [LAW:one-source-of-truth] The dropdown's option list, the parser's dispatch
// table, AND the T2 detector's iteration order are derived from this one
// tuple. Order is detection-priority: most-specific markers first, raw last.
// claude-share leads — a matching URL pattern is the cheapest, strictest
// classifier we have (one regex on one trimmed line).
export const SOURCE_KINDS = [
  "claude-share",  // https://claude.ai/share/<id> — strictest, no false-positive
  "chatgpt-share", // https://chatgpt.com/share/<id> — URL pattern, no false-positive
  "claude-jsonl",  // CC session JSONL — valid JSON on the first line
  "claude-code",   // ❯ ⏺ ⎿ — most specific markers, can't false-positive
  "markdown",      // ## User / ## Assistant — explicit heading
  "chatgpt",       // "You said:" / "ChatGPT said:" — copy-paste marker
  "claude-paste",  // "Human:" / "Assistant:" — bare name+colon
  "raw",           // always succeeds; fallback bubble
] as const;

// [LAW:one-source-of-truth] The text-arm subset and the wire validator are both
// derived from SOURCE_KINDS, so neither can drift from the canonical tuple.
// TEXT_ARM_KINDS preserves SOURCE_KINDS order — parseAuto's race priority IS
// this order, not a second hand-maintained list. The exclusion is derived from
// PROVIDERS (isProvider), not a hard-coded kind name: TextArmKind is exactly
// "a SourceKind that is not a Provider", so the runtime filter and the type
// predicate state the SAME theorem. Hard-coding "claude-share" here would lie to
// the compiler the moment a second provider joins — it silently leaked the new
// provider into the text-arm race (which has no parser for it) until this derived.
export const TEXT_ARM_KINDS: ReadonlyArray<TextArmKind> = SOURCE_KINDS.filter(
  (k): k is TextArmKind => !isProvider(k),
);

export const isSourceKind = (v: unknown): v is SourceKind =>
  typeof v === "string" && (SOURCE_KINDS as ReadonlyArray<string>).includes(v);

export const isPlatform = (v: unknown): v is Platform =>
  typeof v === "string" && (PLATFORMS as ReadonlyArray<string>).includes(v);

// [LAW:one-type-per-behavior] Several source kinds style identically — they are
// instances of one Platform, not seven independent themes. The grouping is
// stated once here; CSS themes the four platform values, never individual kinds.
//
// [LAW:dataflow-not-control-flow] platformOf is a total projection: every
// source value (including the null of editor-authored / legacy records) maps to
// a platform, and "generic" is a value like any other — the default theme is
// the absence of CSS overrides, not a branch that skips emitting the attribute.
export const PLATFORMS = ["claude-web", "claude-code", "chatgpt", "generic"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_BY_SOURCE: { readonly [K in SourceKind]: Platform } = {
  "claude-share": "claude-web",
  "chatgpt-share": "chatgpt",
  "claude-paste": "claude-web",
  "claude-jsonl": "claude-code",
  "claude-code": "claude-code",
  "chatgpt": "chatgpt",
  "markdown": "generic",
  "raw": "generic",
};

export const platformOf = (source: SourceKind | null): Platform =>
  source === null ? "generic" : PLATFORM_BY_SOURCE[source];

// [LAW:one-source-of-truth] The persisted-draft shape: the editable state a draft
// carries — turns, the import origin they came from, and an optional explicit theme
// override. ONE authoritative definition, shared by the editor's in-memory Draft
// (editor/store.ts aliases this) and the server's KV record (storage.ts imports it),
// so the client/server contract cannot drift. Both modules already depend downward
// on types.ts, so sharing it adds no dependency edge and no cycle [LAW:one-way-deps];
// storage stays independent of the editor store.
export interface DraftRecord {
  readonly turns: ReadonlyArray<Turn>;
  readonly origin: Origin | null;
  readonly platformOverride?: Platform;
}

// Short display name for the conversation meta line. generic carries no badge —
// absence of provenance is shown as absence, never a fabricated label.
export const PLATFORM_LABEL: { readonly [P in Platform]: string | null } = {
  "claude-web": "Claude",
  "claude-code": "Claude Code",
  "chatgpt": "ChatGPT",
  "generic": null,
};

export const SOURCE_LABEL: { readonly [K in SourceKind]: string } = {
  // claude-share is a Provider styling identity, not a dropdown option — the
  // dropdown offers the generic "url" arm (URL_INPUT_LABEL) and resolves the
  // provider server-side. This entry keeps the map total over SourceKind.
  "claude-share": "Claude (claude.ai/share)",
  "chatgpt-share": "ChatGPT (chatgpt.com/share)",
  "claude-jsonl": "Claude Code session JSONL (raw transcript file)",
  "claude-code": "Claude Code transcript",
  "chatgpt": "ChatGPT / Claude.ai (You said: / … said:)",
  "claude-paste": "Claude (Human: / Assistant:)",
  "markdown": "Markdown headings (## User / ## Assistant)",
  "raw": "Raw (single bubble, no parsing)",
};

// [LAW:one-source-of-truth] The input-kind set the detector emits and the
// dropdown renders: the generic url fetch arm plus every text arm, derived from
// TEXT_ARM_KINDS so it cannot drift from SOURCE_KINDS. "url" leads — a link is
// the cheapest, strictest classifier (one isUrl check) and routes straight to
// the fetch arm, never the text-parser race.
export const INPUT_KINDS: ReadonlyArray<InputKind> = ["url", ...TEXT_ARM_KINDS];

// [LAW:one-source-of-truth] The dropdown label for an input kind. Text arms reuse
// SOURCE_LABEL (they ARE SourceKinds); the generic url arm — not a SourceKind —
// carries its own label here. One total projection, no duplicated text-arm
// strings. `kind === "url"` narrows the else to TextArmKind ⊆ SourceKind.
export const URL_INPUT_LABEL = "URL — any conversation link (we fetch + parse it)";
export const inputLabel = (kind: InputKind): string =>
  kind === "url" ? URL_INPUT_LABEL : SOURCE_LABEL[kind];
