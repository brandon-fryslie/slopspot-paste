// [LAW:types-are-the-program] A paste is an ordered list of typed events plus
// identity + lifetime. Each event kind carries exactly the fields it needs and
// no more — illegal states (a tool-call without a tool name, an insight with a
// role) are not representable.
//
// Source format (Claude Code / ChatGPT / Claude.ai / markdown headers) is a
// value the parser consumes and discards. It is *not* a type axis: there is
// no `CCConversation` vs `ChatGPTConversation`. Every parser converges to this
// same union, and downstream rendering operates on `kind` alone.

export type Role = "user" | "assistant" | "system";

export type ToolOutputKind = "terminal" | "file-read" | "diff" | "generic";

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
  | { readonly kind: "turn-summary"; readonly text: string };

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
// dispatch to local pure parsers; only the URL arm (added in T3) can reach
// the network. The cost model is visible in the types — no scattered
// `if (looksLikeUrl(...)) fetch(...)` gates.
//
// [LAW:no-mode-explosion] Each arm earns its keep by mapping to a distinct
// header-detector in src/parser.ts (or, for claude-share, an entirely
// distinct ingestion path). No "config bag" — per-source options land as
// new *fields on the relevant arm* rather than as flag combinations.
export type PasteInput =
  | { readonly kind: "claude-code"; readonly content: string }
  | { readonly kind: "chatgpt"; readonly content: string }
  | { readonly kind: "claude-paste"; readonly content: string }
  | { readonly kind: "markdown"; readonly content: string }
  | { readonly kind: "raw"; readonly content: string };

export type SourceKind = PasteInput["kind"];

// [LAW:one-source-of-truth] The dropdown's option list, the parser's dispatch
// table, AND the T2 detector's iteration order are derived from this one
// tuple. Order is detection-priority: most-specific markers first, raw last.
// Reordered from T1's initial guess so dropdown display order matches the
// priority used to auto-select the best-fit kind from a detection result.
export const SOURCE_KINDS: ReadonlyArray<SourceKind> = [
  "claude-code",   // ❯ ⏺ ⎿ — most specific markers, can't false-positive
  "markdown",      // ## User / ## Assistant — explicit heading
  "chatgpt",       // "You said:" / "ChatGPT said:" — copy-paste marker
  "claude-paste",  // "Human:" / "Assistant:" — bare name+colon
  "raw",           // always succeeds; fallback bubble
];

export const SOURCE_LABEL: { readonly [K in SourceKind]: string } = {
  "claude-code": "Claude Code transcript",
  "chatgpt": "ChatGPT / Claude.ai (You said: / … said:)",
  "claude-paste": "Claude (Human: / Assistant:)",
  "markdown": "Markdown headings (## User / ## Assistant)",
  "raw": "Raw (single bubble, no parsing)",
};
