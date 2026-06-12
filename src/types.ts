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

export interface ToolOutput {
  readonly kind: ToolOutputKind;
  readonly text: string;
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
  | { readonly kind: "usage"; readonly usage: Usage };

// [LAW:types-are-the-program] The runtime witness of the Turn union. It lives
// beside the type so the two cannot drift: add an arm above and the exhaustive
// switch below stops compiling until this validator learns it. The editor
// submits an already-pristine Turn[] (its editor-only `id` is mapped away
// client-side), but the API trust boundary cannot trust that — a directly
// crafted request is classified here, where every illegal shape is rejected by
// construction rather than crashing downstream render/store.
const isToolOutput = (v: unknown): v is ToolOutput => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; text?: unknown };
  return (
    typeof o.text === "string" &&
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
    default:
      return false;
  }
};

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

// [LAW:types-are-the-program] PasteInput IS the input to parsing — each arm
// carries exactly the fields its parser needs and no more. A flat enum with a
// separate `content` field would admit illegal pairings (e.g. a URL-kind with
// `content` and no URL); the discriminated shape forbids them by construction.
//
// [LAW:single-enforcer] Network access lives on exactly one arm. Text arms
// dispatch to local pure parsers; only the URL arm (claude-share) can reach
// the network. The cost model is visible in the types — no scattered
// `if (looksLikeUrl(...)) fetch(...)` gates.
//
// [LAW:no-mode-explosion] Each arm earns its keep by mapping to a distinct
// header-detector in src/parser.ts (or, for claude-share, an entirely
// distinct ingestion path). No "config bag" — per-source options land as
// new *fields on the relevant arm* rather than as flag combinations.
export type PasteInput =
  | { readonly kind: "claude-code"; readonly content: string }
  | { readonly kind: "claude-jsonl"; readonly content: string }
  | { readonly kind: "chatgpt"; readonly content: string }
  | { readonly kind: "claude-paste"; readonly content: string }
  | { readonly kind: "markdown"; readonly content: string }
  | { readonly kind: "raw"; readonly content: string }
  | { readonly kind: "claude-share"; readonly url: string };

// [LAW:types-are-the-program] The URL/text bifurcation IS the type — text arms
// expose `content`, the URL arm exposes `url`. Code that needs to read "the
// user-supplied string regardless of shape" goes through this accessor so the
// discriminator stays the single point of dispatch.
export const inputText = (input: PasteInput): string =>
  input.kind === "claude-share" ? input.url : input.content;

export type SourceKind = PasteInput["kind"];

// [LAW:types-are-the-program] The content-bearing kinds (everything but the URL
// arm) and a typed constructor for building their PasteInput. Callers that hold
// a non-share kind + content build the arm through textArmInput so the union
// shape is checked by the compiler — no `as PasteInput` assertion that would
// mask a future URL-shaped arm.
export type TextArmKind = Exclude<SourceKind, "claude-share">;
export const textArmInput = (kind: TextArmKind, content: string): PasteInput => ({
  kind,
  content,
});

// [LAW:types-are-the-program] Origin is the captured source of truth — the exact
// input a paste was created from, in the strongest shape that lets us replay it
// without the network. It is PasteInput's storable twin: every text arm already
// carries its verbatim `content`, so those collapse to one structural arm keyed
// by kind ([LAW:one-type-per-behavior] — six text kinds, identical "carry the
// content" behavior). The claude-share arm is the one that was lossy: it keeps
// the link AND the original fetched markdown (HAR-spirit: the bytes, not just a
// pointer), so re-projection parses stored bytes rather than re-hitting Firecrawl.
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
// [LAW:types-are-the-program] `input` is scoped to the replayable arms (text/share)
// — an editor arm has no upstream text and can never be a valid provenance source,
// so that state is unrepresentable. This also keeps isOrigin non-recursive.
export type ReplayableOrigin =
  | { readonly kind: TextArmKind; readonly content: string }
  | { readonly kind: "claude-share"; readonly url: string; readonly fetched: string };

export type Origin =
  | ReplayableOrigin
  | { readonly kind: "editor"; readonly source: SourceKind | null; readonly input?: ReplayableOrigin };

const isTextArmKind = (v: unknown): v is TextArmKind =>
  typeof v === "string" && (TEXT_ARM_KINDS as ReadonlyArray<string>).includes(v);

const isReplayableOrigin = (v: unknown): v is ReplayableOrigin => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; content?: unknown; url?: unknown; fetched?: unknown };
  if (o.kind === "claude-share") return typeof o.url === "string" && typeof o.fetched === "string";
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

// [LAW:one-source-of-truth] The single derivation of styling provenance from the
// canonical origin. A text or share arm reports its own kind; the editor arm
// reports the provenance it carried; legacy (null) origin and from-scratch
// editor authoring both report null — honest absence, rendered as the generic
// platform. Nothing re-guesses the platform from content.
export const sourceOf = (origin: Origin | null): SourceKind | null =>
  origin === null || origin.kind === "editor" ? (origin?.source ?? null) : origin.kind;

// [LAW:one-source-of-truth] The single derivation of "where on the web this paste
// came from" — the share link, or null for every origin without an upstream URL
// (text arms carry verbatim content, editor authoring and legacy records have no
// source URL). The paste page reads this projection of the canonical origin;
// nothing re-guesses a URL from content or stores it as a second field.
export const sourceUrlOf = (origin: Origin | null): string | null =>
  origin?.kind === "claude-share" ? origin.url : null;


// [LAW:one-source-of-truth] The dropdown's option list, the parser's dispatch
// table, AND the T2 detector's iteration order are derived from this one
// tuple. Order is detection-priority: most-specific markers first, raw last.
// claude-share leads — a matching URL pattern is the cheapest, strictest
// classifier we have (one regex on one trimmed line).
export const SOURCE_KINDS: ReadonlyArray<SourceKind> = [
  "claude-share",  // https://claude.ai/share/<id> — strictest, no false-positive
  "claude-jsonl",  // CC session JSONL — valid JSON on the first line
  "claude-code",   // ❯ ⏺ ⎿ — most specific markers, can't false-positive
  "markdown",      // ## User / ## Assistant — explicit heading
  "chatgpt",       // "You said:" / "ChatGPT said:" — copy-paste marker
  "claude-paste",  // "Human:" / "Assistant:" — bare name+colon
  "raw",           // always succeeds; fallback bubble
];

// [LAW:one-source-of-truth] The text-arm subset and the wire validator are both
// derived from SOURCE_KINDS, so neither can drift from the canonical tuple.
// TEXT_ARM_KINDS preserves SOURCE_KINDS order — parseAuto's race priority IS
// this order, not a second hand-maintained list.
export const TEXT_ARM_KINDS: ReadonlyArray<TextArmKind> = SOURCE_KINDS.filter(
  (k): k is TextArmKind => k !== "claude-share",
);

export const isSourceKind = (v: unknown): v is SourceKind =>
  typeof v === "string" && (SOURCE_KINDS as ReadonlyArray<string>).includes(v);

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
  "claude-paste": "claude-web",
  "claude-jsonl": "claude-code",
  "claude-code": "claude-code",
  "chatgpt": "chatgpt",
  "markdown": "generic",
  "raw": "generic",
};

export const platformOf = (source: SourceKind | null): Platform =>
  source === null ? "generic" : PLATFORM_BY_SOURCE[source];

// Short display name for the conversation meta line. generic carries no badge —
// absence of provenance is shown as absence, never a fabricated label.
export const PLATFORM_LABEL: { readonly [P in Platform]: string | null } = {
  "claude-web": "Claude",
  "claude-code": "Claude Code",
  "chatgpt": "ChatGPT",
  "generic": null,
};

export const SOURCE_LABEL: { readonly [K in SourceKind]: string } = {
  "claude-share": "claude.ai/share URL (we fetch + parse it)",
  "claude-jsonl": "Claude Code session JSONL (raw transcript file)",
  "claude-code": "Claude Code transcript",
  "chatgpt": "ChatGPT / Claude.ai (You said: / … said:)",
  "claude-paste": "Claude (Human: / Assistant:)",
  "markdown": "Markdown headings (## User / ## Assistant)",
  "raw": "Raw (single bubble, no parsing)",
};
