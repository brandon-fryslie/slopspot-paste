// [LAW:one-source-of-truth] The ONE projection of a derived `Dialogue` into plain
// labelled text. Two readers need "the conversation as text" — the DeepSeek summary
// prompt (summary.ts) and the continuation bundle (continuation.ts) — and both read it
// through here, so "how a turn reads as text" is decided in exactly one place and can
// never drift between them.
//
// [LAW:one-way-deps] transcript depends on dialogue (SpineNode/AssistantBlock and the
// blockVisibility/blockText authorities); summary and continuation depend on transcript.
// Neither reader depends on the other — a neutral shared core, not one reader reaching
// into the other's module.
//
// [LAW:effects-at-boundaries] Pure: a given Dialogue yields a fixed string, no I/O. The
// bound a long transcript needs (a tail cap for the token-limited summary prompt, none
// for the clipboard bundle) is layered by each reader as a VALUE — it is deliberately
// NOT baked in here, so the projection stays the single truth and the policy stays with
// the reader that owns it.

import type { Dialogue, SpineNode, AssistantBlock } from "./dialogue";
import { blockVisibility, blockText } from "./dialogue";

// [LAW:one-source-of-truth] An assistant turn contributes only its spine-VISIBLE prose —
// the blocks BLOCK_VISIBILITY marks as the reader-facing conversation — so the text is
// built from what a human reads, never from collapsed thinking/tool noise. BOTH judgments
// come from single authorities: `blockVisibility` decides which blocks are spine, and
// `blockText` (the exhaustive extractor dialogue.ts owns) yields each block's prose. There
// is no second list of "which kinds carry text" here — a new spine-visible kind is
// compiler-forced to be handled in blockText, so it can never silently map to "".
const spineVisibleProse = (blocks: ReadonlyArray<AssistantBlock>): string =>
  blocks
    .filter((b) => blockVisibility(b) === "spine")
    .map(blockText)
    .filter((s) => s.length > 0)
    .join("\n\n");

// [LAW:dataflow-not-control-flow] One spine node -> its labelled text line, or "" when it
// carries no readable prose (an assistant turn of only collapsed thinking/tool calls). The
// caller filters the empty ones — absence is a value, not a branch that skips a node.
const nodeTranscript = (node: SpineNode): string => {
  if (node.kind === "spoken") {
    const speaker = node.role === "user" ? "User" : "System";
    return `[${speaker}]: ${node.content}`;
  }
  const prose = spineVisibleProse(node.blocks);
  return prose.length > 0 ? `[Assistant]: ${prose}` : "";
};

// [LAW:effects-at-boundaries] Pure: flatten the derived Dialogue into plain labelled text,
// in source order, untruncated. Deterministic in its input — the same dialogue yields the
// same string. Feed the VIEWABLE (overlay-applied) dialogue's nodes and the projection is
// redaction-safe by construction: a hidden/redacted turn already carries "[redacted]" in
// place, so its original content can never reach the output [LAW:no-silent-failure].
export const renderDialogueTranscript = (dialogue: Dialogue): string =>
  dialogue
    .map(nodeTranscript)
    .filter((s) => s.length > 0)
    .join("\n\n");
