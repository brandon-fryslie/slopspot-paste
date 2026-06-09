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
  | { readonly kind: "turn-summary"; readonly text: string };

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

export interface Conversation {
  readonly slug: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly turns: ReadonlyArray<Turn>;
  readonly title: string | null;
}

// [LAW:single-enforcer] The single enforcer of expiry is KV's expirationTtl.
// This constant is the one place the policy is stated.
export const TTL_DAYS = 30;
export const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

// [LAW:one-source-of-truth] The size cap is stated once, as a byte count. The
// API enforces MAX_PASTE_BYTES at the trust boundary; the index page shows
// MAX_PASTE_LABEL in its hint. The label is *derived* from the byte count so the
// advertised limit cannot drift from (or unit-mismatch) the enforced one — a
// hardcoded "256 KB" hint once outlived the real cap.
export const MAX_PASTE_BYTES = 8 * 1024 * 1024;
export const MAX_PASTE_LABEL = `${MAX_PASTE_BYTES / (1024 * 1024)} MiB`;

// [LAW:types-are-the-program] Discriminated result instead of throws/null
// so callers must structurally handle both outcomes.
export type ParseResult =
  | { ok: true; turns: ReadonlyArray<Turn> }
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

export const SOURCE_LABEL: { readonly [K in SourceKind]: string } = {
  "claude-share": "claude.ai/share URL (we fetch + parse it)",
  "claude-jsonl": "Claude Code session JSONL (raw transcript file)",
  "claude-code": "Claude Code transcript",
  "chatgpt": "ChatGPT / Claude.ai (You said: / … said:)",
  "claude-paste": "Claude (Human: / Assistant:)",
  "markdown": "Markdown headings (## User / ## Assistant)",
  "raw": "Raw (single bubble, no parsing)",
};
