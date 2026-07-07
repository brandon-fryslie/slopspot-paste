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
// to Turn[], so this one projection serves all sources uniformly. The subagent
// linkage the jsonl parser reattaches rides on the Turn stream too: a `subagent`
// Turn carries the nested run as a Turn[], and deriveDialogue recurses on it to
// produce a nested `Dialogue` — which is why Dialogue is named and recursive-ready
// below, and why the same renderer can draw any depth.

import type { Role, Turn, ToolOutput, Usage, SubagentTranscript } from "./types";

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
  | { readonly kind: "usage"; readonly usage: Usage }
  | {
      // [LAW:types-are-the-program] The recursion point. A subagent block carries
      // its run as a nested `Dialogue` (captured) — the SAME type the outer
      // conversation is, so the SAME renderer draws it one level in. The body is
      // the display projection of the source's two capture outcomes (see
      // SubagentTranscript): a full nested dialogue, or the degraded prompt+result
      // when the transcript was never captured. agentType/description/stepCount
      // identify the run on the condensed summary line.
      readonly kind: "subagent";
      readonly agentType: string | null;
      readonly description: string | null;
      readonly stepCount: number;
      readonly body: SubagentBody;
    };

// [LAW:types-are-the-program] The display twin of SubagentTranscript: `captured`
// holds a nested `Dialogue` (already derived, ready to recurse through the
// renderer); `summary-only` holds the degraded prompt+result. The mapping from
// the stored SubagentTranscript happens once, in deriveDialogue.
export type SubagentBody =
  | { readonly kind: "captured"; readonly transcript: Dialogue }
  | { readonly kind: "summary-only"; readonly prompt: string; readonly result: string };

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

// [LAW:types-are-the-program] The renderer's input contract: a spine node paired with the
// two display facts an authored overlay decides about it — WHERE it sits (its original spine
// index, carried as a VALUE) and WHETHER it is folded. Carrying the index is what lets the
// overlay OMIT nodes (feature / highlight-reel) without renumbering the survivors: t<N> is
// read off `index`, never recomputed from array position, so a filtered projection keeps
// every permalink stable [LAW:one-source-of-truth]. `collapsed` is the fold state hide never
// needed (hide replaces content in place); the renderer draws a collapsed node behind a
// native disclosure. A HIDDEN node is not a state here — it is simply ABSENT from the
// projection (applyOverlay filters it out), so the renderer never grows a "draw nothing"
// branch [LAW:dataflow-not-control-flow].
export type DisplayNode = {
  readonly index: number;
  readonly node: SpineNode;
  readonly collapsed: boolean;
};
export type ViewableDialogue = ReadonlyArray<DisplayNode>;

// [LAW:one-source-of-truth] Lift a plain Dialogue to a ViewableDialogue with no overlay
// applied: every node shown, un-folded, at its positional index. The identity view the
// NON-overlaid render paths use — the editor preview (author's raw working turns) and a
// nested subagent transcript (never overlay-targeted) — so those keep rendering through the
// one renderer without inventing a second entry point. applyOverlay produces the same shape
// for the overlaid paths.
export const plainView = (dialogue: Dialogue): ViewableDialogue =>
  dialogue.map((node, index) => ({ index, node, collapsed: false }));

// [LAW:one-source-of-truth] The single MINTER of a spine node's stable anchor id.
// A top-level spine node at position N is addressed as "t<N>" everywhere: the in-page
// permalink (renderDialogueHtml emits id="t<N>"), the single-turn card URL, the
// minimap, and the topic outline all name a turn by this one string. Minting it here
// means the outline's hrefs cannot drift from the ids the renderer emits — both call
// this one function. (The inverse parse of the same token lives in slug.ts's
// parseTurnSegment; this is its counterpart, the produce side.)
export const turnAnchorId = (index: number): string => `t${index}`;

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
  subagent: "detail",
  "turn-summary": "meta",
  usage: "meta",
};

export const blockVisibility = (block: AssistantBlock): Visibility =>
  BLOCK_VISIBILITY[block.kind];

// [LAW:dataflow-not-control-flow] A spine node's navigation label is a VALUE derived
// from the node's own text — a lossy, structural snippet the topic outline and the
// minimap markers both display. It is never model-generated: semantic topic labeling,
// if ever wanted, is a later value on this same seam, not a rewrite of this.
// [LAW:one-source-of-truth] Deriving it here once means the static outline and the
// client minimap read ONE label, never two that can disagree.
const LABEL_MAX = 80;

// The readable text a block contributes to a label, "" when it carries none (usage).
// [LAW:dataflow-not-control-flow] one exhaustive map over kinds, no branch that skips.
// [LAW:one-source-of-truth] The single authority for "the readable text of a block."
// Exported so the summary prompt builder extracts prose from THIS exhaustive switch
// rather than re-listing which kinds carry text — a new kind is compiler-forced to be
// handled here, so it can never silently contribute "" to a label or a summary.
export const blockText = (block: AssistantBlock): string => {
  switch (block.kind) {
    case "text":
    case "insight":
    case "thinking":
      return block.content;
    case "turn-summary":
      return block.text;
    case "tool-call":
      return block.tool;
    case "subagent":
      return block.description ?? block.agentType ?? "";
    case "usage":
      return "";
  }
};

const snippet = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > LABEL_MAX
    ? collapsed.slice(0, LABEL_MAX - 1).trimEnd() + "…"
    : collapsed;
};

// [LAW:no-silent-failure] Total: every node yields a NON-EMPTY label. A spoken node
// labels from its content; an assistant turn from its first VISIBLE spine prose (the
// text/insight the reader actually sees — thinking and tool calls are collapsed, so
// labeling a row with them would name something off-screen). A turn with no visible
// prose (only a tool call, say) falls back to the first block that carries any text,
// and a wholly text-less node to its role word — never an empty outline row.
export const spineNodeLabel = (node: SpineNode): string => {
  if (node.kind === "spoken") {
    return snippet(node.content) || (node.role === "user" ? "User" : "System");
  }
  const fromVisible = firstBlockLabel(node.blocks, (b) => blockVisibility(b) === "spine");
  if (fromVisible) return fromVisible;
  const fromAny = firstBlockLabel(node.blocks, () => true);
  return fromAny || "Assistant";
};

const firstBlockLabel = (
  blocks: ReadonlyArray<AssistantBlock>,
  eligible: (block: AssistantBlock) => boolean,
): string => {
  for (const block of blocks) {
    if (!eligible(block)) continue;
    const label = snippet(blockText(block));
    if (label) return label;
  }
  return "";
};

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
// [LAW:dataflow-not-control-flow] Map the stored transcript's two arms to the
// display body's two arms — one switch, no branch that skips work. The captured
// arm recurses through deriveDialogue (the nested run becomes a nested Dialogue);
// the degraded arm carries its prompt+result verbatim. Forward reference to
// deriveDialogue is sound: both are module consts, invoked only at call time.
const deriveSubagentBody = (transcript: SubagentTranscript): SubagentBody =>
  transcript.kind === "captured"
    ? { kind: "captured", transcript: deriveDialogue(transcript.turns) }
    : { kind: "summary-only", prompt: transcript.prompt, result: transcript.result };

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
      case "subagent":
        // [LAW:one-type-per-behavior] The nested run is the same kind of thing as
        // the outer conversation, so it is derived by the SAME function — recursion,
        // not a parallel subagent projection. The captured arm re-runs deriveDialogue
        // on its Turn[]; the degraded arm passes its prompt+result straight through.
        openAssistant().push({
          kind: "subagent",
          agentType: turn.agentType,
          description: turn.description,
          stepCount: turn.stepCount,
          body: deriveSubagentBody(turn.transcript),
        });
        break;
      default:
        return assertNever(turn);
    }
  }
  closeAssistant();
  return spine;
};
