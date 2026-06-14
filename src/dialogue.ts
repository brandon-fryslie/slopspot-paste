// [LAW:one-source-of-truth] The derived nested conversation model. The stored
// `Conversation.turns` (a flat, peer-level Turn[]) is itself a derived cache of
// the original (see ARCHITECTURE.md); this module derives a further projection —
// a `Dialogue` — that recovers the hierarchy the flat stream flattened. Nothing
// here is persisted: a Dialogue is recomputed on read from the turns, which are
// recomputed from the origin. [LAW:one-way-deps] dialogue depends on types
// (Turn/Role/ToolOutput/Usage); types never depends on dialogue.
//
// The flat Turn[] already does two things this projection relies on: it preserves
// SOURCE ORDER (so interleaving is intact), and it already pairs each tool result
// into its tool-call's `output` (so there are no standalone result events to
// reattach). What it loses is GROUPING — which text/thinking/tool-call belong to
// one agent turn between two human messages. deriveDialogue restores exactly that.
//
// Deriving from Turn[] (not directly from JSONL) is deliberate: every parser —
// jsonl, claude-code, chatgpt, markdown, and the editor's authored turns — converges
// to Turn[], so this one projection serves all sources uniformly. The richer
// JSONL-only linkage (parentUuid / isSidechain for subagents) is a later concern:
// cbm.4 adds a `subagent` AssistantBlock arm carrying a nested `Dialogue`, which is
// why Dialogue is named and recursive-ready below — but that arm is out of scope
// here and not yet representable, so no source can produce one.

import type { Role, Turn, ToolOutput, Usage } from "./types";

// [LAW:types-are-the-program] A block of agent activity inside one assistant turn.
// Each arm carries exactly the fields its kind needs — a tool-call's result lives
// in its own `output` (ToolOutput | null), so an orphaned result node is not
// representable, and the result can never drift away from the call that owns it.
// The three core kinds the disclosure spec names (text, thinking, tool-call) plus
// the assistant-side annotations the parsers also emit (insight, turn-summary,
// usage) — every Turn kind that is NOT a user/system message maps to exactly one
// arm here, so the projection is lossless. [LAW:no-silent-failure]
export type AssistantBlock =
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "thinking"; readonly content: string }
  | {
      readonly kind: "tool-call";
      readonly tool: string;
      readonly args: string;
      readonly output: ToolOutput | null;
    }
  | { readonly kind: "insight"; readonly content: string }
  | { readonly kind: "turn-summary"; readonly text: string }
  | { readonly kind: "usage"; readonly usage: Usage };

// [LAW:types-are-the-program] A spine node is the always-visible outer layer: a
// human/system message, or an assistant turn. The asymmetry IS the disclosure
// model — assistant speech is INTERLEAVED with thinking and tool calls, so it is
// a sequence of blocks; user/system speech stands alone, so it carries only its
// content. Because only the `assistant` arm has `blocks`, a tool-call (or any
// detail block) at a user/system spine is unrepresentable by construction — the
// exact illegal state the ticket forbids.
//
// [LAW:one-type-per-behavior] user and system messages have identical shape and
// behavior here (plain, always-visible content, no nested blocks); they are one
// `spoken` node discriminated by `role`, not two arms. assistant is the only role
// that interleaves, so it is the only role with its own arm.
export type SpineNode =
  | { readonly kind: "spoken"; readonly role: Exclude<Role, "assistant">; readonly content: string }
  | { readonly kind: "assistant"; readonly blocks: ReadonlyArray<AssistantBlock> };

// [LAW:types-are-the-program] The derived nested conversation: an ordered list of
// spine nodes. Named (not an inline `SpineNode[]`) because it is the recursion
// point — cbm.4's subagent block carries a nested `Dialogue`, rendered by the same
// component recursively. Distinct from the stored `Conversation` record (a paste):
// a Dialogue is the disposable, re-derivable DISPLAY projection of that record's
// turns.
export type Dialogue = ReadonlyArray<SpineNode>;

// [LAW:dataflow-not-control-flow] Visibility is a property of a block's KIND,
// fixed once here as data — never a branch the renderer re-decides per block.
//   spine  — always visible; the readable conversation (assistant prose, insights)
//   detail — collapsed by default, revealed on intent (thinking, tool calls)
//   meta   — always-visible annotation, not collapsible, not navigable (token
//            usage, turn summaries)
// The renderer (cbm.3) reads this map; adding a block kind without classifying it
// stops compiling, so a new kind can never silently default to a visibility.
export type Visibility = "spine" | "detail" | "meta";

export const BLOCK_VISIBILITY: { readonly [K in AssistantBlock["kind"]]: Visibility } = {
  text: "spine",
  insight: "spine",
  thinking: "detail",
  "tool-call": "detail",
  "turn-summary": "meta",
  usage: "meta",
};

export const blockVisibility = (block: AssistantBlock): Visibility =>
  BLOCK_VISIBILITY[block.kind];

// [LAW:types-are-the-program] Exhaustiveness witness: callable only with a value
// the type system has narrowed to `never`. In the deriveDialogue switch below it
// is reached only after every Turn kind has its own case, so `turn` is `never`
// there; add a Turn kind without handling it and this call stops compiling — the
// projection can never silently drop a kind, the same compile-time guarantee the
// BLOCK_VISIBILITY mapped type gives the output side.
// [LAW:no-silent-failure] If a value somehow slips past the type system at runtime,
// it throws loudly rather than returning a quietly-incomplete Dialogue.
const assertNever = (turn: never): never => {
  throw new Error(`deriveDialogue: unhandled turn kind: ${(turn as { kind?: unknown }).kind}`);
};

// [LAW:dataflow-not-control-flow] A fold over the flat stream, in source order.
// The spine splits ONLY on a user/system message — every other turn is agent
// activity and accumulates into the current assistant node, so interleaving is
// preserved exactly as the source ordered it. Consecutive logical assistant
// messages (multiple message.ids between two human turns, the tool-result events
// between them carrying no user message) merge into ONE assistant node — which is
// the reader's mental model: "I said X, the agent did all this, I said Y."
//
// This is a parser-shaped boundary transformation (like jsonl.ts / cc.ts): the
// control flow lives HERE, at the projection, so the OUTPUT type carries the whole
// grouping. Downstream rendering maps the model and never reconstructs grouping
// with positional heuristics. The model shape IS the disclosure spec.
export const deriveDialogue = (turns: ReadonlyArray<Turn>): Dialogue => {
  const spine: SpineNode[] = [];
  // The open assistant node's blocks, or null when the spine is between assistant
  // turns. A single owner of "where the next agent block lands" — no ambient flag.
  let open: AssistantBlock[] | null = null;

  const closeAssistant = (): void => {
    if (open !== null) {
      spine.push({ kind: "assistant", blocks: open });
      open = null;
    }
  };
  // Force-open the current assistant node, returning its block list. Any agent
  // turn (even one with no preceding assistant text) starts an assistant node, so
  // a lone tool-call or usage record still has a home — nothing is dropped.
  const openAssistant = (): AssistantBlock[] => (open ??= []);

  for (const turn of turns) {
    switch (turn.kind) {
      case "message":
        if (turn.role === "assistant") {
          openAssistant().push({ kind: "text", content: turn.content });
        } else {
          // user / system: a spoken spine node. Close any open assistant turn
          // first — a human message is a hard boundary between agent turns.
          closeAssistant();
          spine.push({ kind: "spoken", role: turn.role, content: turn.content });
        }
        break;
      case "thinking":
        openAssistant().push({ kind: "thinking", content: turn.content });
        break;
      case "tool-call":
        openAssistant().push({
          kind: "tool-call",
          tool: turn.tool,
          args: turn.args,
          output: turn.output,
        });
        break;
      case "insight":
        openAssistant().push({ kind: "insight", content: turn.content });
        break;
      case "turn-summary":
        openAssistant().push({ kind: "turn-summary", text: turn.text });
        break;
      case "usage":
        openAssistant().push({ kind: "usage", usage: turn.usage });
        break;
      default:
        return assertNever(turn);
    }
  }
  closeAssistant();
  return spine;
};
