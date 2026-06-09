// Pure block model for the interactive editor — DOM-free, mobx-free, no IO.
//
// [LAW:types-are-the-program] The stored type stays pristine `Turn` (src/types).
// Editing adds exactly one thing the renderer/store needs but the store does
// not: a stable identity so a keyed DOM render can track a card across reorder
// and inline edit. That single addition IS the editing type:
//
//   Block = { id; turn }
//
// `id` is editor-only and ephemeral; toTurns maps it away before anything is
// stored. No other field — role, kind, content all live inside the pristine
// `turn`, so the block model never duplicates (and can never diverge from) the
// stored shape. [LAW:one-source-of-truth]

import type { Role, Turn } from "../types";

// [LAW:types-are-the-program] The editor edits AUTHOR-ABLE turns. A `usage`
// turn is source-derived token accounting, not something a human types, splits,
// or kind-converts — so it is excluded from the type the editor operates on.
// This makes "a block never holds a usage turn" a compile-time fact (every
// switch below stays exhaustive without a nonsensical usage case) rather than a
// runtime convention; usage turns are filtered out at the single load seam
// (store.loadTurns) before they could ever reach a Block.
export type AuthorableTurn = Exclude<Turn, { kind: "usage" }>;
export const isAuthorable = (turn: Turn): turn is AuthorableTurn =>
  turn.kind !== "usage";

export interface Block {
  readonly id: string;
  readonly turn: AuthorableTurn;
}

// [LAW:one-source-of-truth] The runtime witness of the kind set — the editor's
// kind dropdown and per-kind counts iterate this tuple, so the list the UI
// offers cannot drift from the kinds the model supports. Order is the dropdown
// order (message first: the common case).
export const KINDS = ["message", "tool-call", "insight", "thinking", "turn-summary"] as const;
export type Kind = (typeof KINDS)[number];

// [LAW:types-are-the-program] KINDS must be *exactly* the AUTHOR-ABLE turn
// discriminator set. If an author-able kind is added to the union but not here
// (or vice-versa) one of these assignments stops compiling — the dropdown can
// never silently diverge from the kinds the model supports. The non-author-able
// `usage` kind is excluded by AuthorableTurn, so it is correctly NOT required
// here, and equally cannot be smuggled in.
type _KindsAreTurnKinds = Kind extends AuthorableTurn["kind"] ? true : never;
type _TurnKindsAreKinds = AuthorableTurn["kind"] extends Kind ? true : never;
const _kindsExact: [_KindsAreTurnKinds, _TurnKindsAreKinds] = [true, true];
void _kindsExact;

// [LAW:effects-at-boundaries] Identity generation is the one effect in this
// module (randomness). It lives in a named, single-purpose function rather than
// scattered through toBlocks, and it draws entropy from the platform — no
// module-level mutable counter, so there is nothing to reset, share, or
// collide across editor remounts. [LAW:no-shared-mutable-globals]
export const newId = (): string => crypto.randomUUID();

// [LAW:one-source-of-truth] Converting any kind TO `message` must supply a role
// (the type demands it). The default is stated once here; the editor's role
// dropdown lets the user override it. "assistant" because insight, turn-summary
// and tool-call are all assistant-side artifacts, so the natural message they
// degrade to is an assistant one.
const DEFAULT_ROLE: Role = "assistant";

// [LAW:dataflow-not-control-flow] The canonical text projection of any turn.
// Content-bearing kinds expose their single text field; a tool-call has no
// single field, so its text is the join of its parts (the "convert FROM
// tool-call" rule lives here, once). Exhaustive over the union — a new kind
// fails to compile until it declares its projection.
const textOf = (turn: AuthorableTurn): string => {
  switch (turn.kind) {
    case "message":
      return turn.content;
    case "insight":
      return turn.content;
    case "thinking":
      return turn.content;
    case "turn-summary":
      return turn.text;
    case "tool-call":
      return [turn.tool, turn.args, turn.output?.text ?? ""]
        .filter((part) => part.length > 0)
        .join("\n\n");
  }
};

// [LAW:dataflow-not-control-flow] The inverse: build a turn of `kind` carrying
// `text`. Content-bearing kinds drop text straight into their field; a
// tool-call has no content field, so the "convert TO tool-call" rule lives here
// (text seeds `args`, tool name starts empty, no output). Exhaustive over the
// union for the same reason as textOf.
const withText = (kind: Kind, text: string): AuthorableTurn => {
  switch (kind) {
    case "message":
      return { kind, role: DEFAULT_ROLE, content: text };
    case "insight":
      return { kind, content: text };
    case "thinking":
      return { kind, content: text };
    case "turn-summary":
      return { kind, text };
    case "tool-call":
      return { kind, tool: "", args: text, output: null };
  }
};

// An empty turn of the given kind — the seed for an "add block" action. Falls
// out of withText with empty text; no separate per-kind constructor to drift.
export const emptyTurn = (kind: Kind): AuthorableTurn => withText(kind, "");

// Change a turn's kind, preserving its text content per the rules above.
// [LAW:dataflow-not-control-flow] The 4x4 conversion matrix is not 16 branches;
// it is one round-trip through the text projection. Same-kind is the identity:
// returning the turn untouched is the only path that preserves fields the text
// projection cannot carry (a message's role), so a no-op kind "change" is
// genuinely lossless — the one honest branch.
export const convertKind = (turn: AuthorableTurn, newKind: Kind): AuthorableTurn =>
  newKind === turn.kind ? turn : withText(newKind, textOf(turn));

// [LAW:dataflow-not-control-flow] The caret's text field — the single editable
// text a cursor lives in, read and written through the SAME field. Distinct from
// textOf/withText, which FLATTEN a whole turn across kinds for kind-conversion
// (deliberately lossy: a tool-call collapses tool+args+output, a message drops
// its role). This lens PRESERVES every non-text field and touches only the text,
// so split/merge operate on exactly what the user sees under the caret.
// Exhaustive over the union for the same compile-time reason as textOf.
const primaryText = (turn: AuthorableTurn): string => {
  switch (turn.kind) {
    case "message":
      return turn.content;
    case "insight":
      return turn.content;
    case "thinking":
      return turn.content;
    case "turn-summary":
      return turn.text;
    case "tool-call":
      return turn.args;
  }
};

const withPrimaryText = (turn: AuthorableTurn, text: string): AuthorableTurn => {
  switch (turn.kind) {
    case "message":
      return { ...turn, content: text };
    case "insight":
      return { ...turn, content: text };
    case "thinking":
      return { ...turn, content: text };
    case "turn-summary":
      return { ...turn, text };
    case "tool-call":
      return { ...turn, args: text };
  }
};

// Split a turn's primary text at `offset` into [head, tail]; both keep the
// original kind and non-text fields (a message's role rides onto both halves).
// A pure cut: head.text + tail.text reconstructs the original, nothing inserted
// or dropped. offset is clamped, so a caret at either edge yields one empty half
// — a legal block, exactly what addBlock seeds — rather than an out-of-range slice.
export const splitTurn = (
  turn: AuthorableTurn,
  offset: number,
): readonly [AuthorableTurn, AuthorableTurn] => {
  const text = primaryText(turn);
  const at = Math.max(0, Math.min(offset, text.length));
  return [withPrimaryText(turn, text.slice(0, at)), withPrimaryText(turn, text.slice(at))];
};

// Merge `next` into `prev`: the result keeps prev's kind and non-text shape; its
// primary text is the two texts joined by a blank line. Distinct from split at
// the level of intent — joining two authored blocks inserts a paragraph break,
// where split is a byte-exact cut. next's non-text fields (a second role or tool
// name) are dropped: one merged block keeps exactly one shape.
export const mergeTurns = (prev: AuthorableTurn, next: AuthorableTurn): AuthorableTurn =>
  withPrimaryText(prev, [primaryText(prev), primaryText(next)].join("\n\n"));

// [LAW:single-enforcer] The only seam between the stored Turn[] and the editing
// Block[]. Parse/fetch produce Turn[]; toBlocks attaches identity for editing;
// toTurns strips it before store/preview. Round-trip is exact by construction:
// the turn rides through unchanged, so toTurns(toBlocks(t)) deep-equals t.
export const toBlocks = (turns: ReadonlyArray<AuthorableTurn>): Block[] =>
  turns.map((turn) => ({ id: newId(), turn }));

export const toTurns = (blocks: ReadonlyArray<Block>): AuthorableTurn[] =>
  blocks.map((block) => block.turn);
