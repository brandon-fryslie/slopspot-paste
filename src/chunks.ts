// [LAW:decomposition] The embeddable chunk projection: a pure map from a
// ViewableDialogue to the ordered list of texts the semantic index embeds, each
// anchored to the spine index it came from. The sibling of spineOutline.ts — a
// small derived, disposable projection over the SAME viewable dialogue every
// reader surface consumes — and, like the outline, it inherits the overlay's
// guarantees by construction [LAW:one-source-of-truth]: a feature-omitted node is
// absent from the view and so from the chunks; a hidden node's content was
// already replaced with the redaction marker upstream (applyOverlay), so hidden
// prose can never reach a vector. This module re-enforces neither — the overlay
// boundary is the single enforcer of what a reader may see [LAW:single-enforcer].
//
// [LAW:one-way-deps] chunks depends on dialogue (the model and its
// nodeVisibleProse authority); the embedding boundary (embeddings.ts) and the
// index cache consume chunks. Nothing here is persisted as authority: the index
// derived from these chunks is a cache, re-derivable from the stored original.

import type { ViewableDialogue } from "./dialogue";
import { nodeVisibleProse } from "./dialogue";

// [LAW:single-enforcer] THE chunk size bound — the one place it is enforced.
// embeddings.ts deliberately omits truncate_inputs on the wire because THIS bound
// guarantees no over-long input reaches it; an overrun there is a loud upstream
// bug, never a silent clip. 2000 chars sits comfortably inside bge-m3's
// 8192-token window even at the worst-case ~1 token/char (CJK; typical English is
// ~4 chars/token), keeps retrieval granular enough that a hit names one passage,
// and keeps any realistic paste's chunk count far under the 501-text batch the
// embedding boundary verified live.
export const CHUNK_MAX_CHARS = 2000;

// [LAW:types-are-the-program] The retrieval unit. `index` is the chunk's spine
// index CARRIED from the DisplayNode it was cut from — never an array position —
// so a hit resolves to the same t<N> anchor (turnAnchorId) the renderer emits and
// the minimap navigates, and a citation stays valid under feature-filtered views
// whose survivors keep their original indices. Several chunks may carry one index
// (a long node split into windows); a node with no readable prose yields none.
export interface DialogueChunk {
  readonly index: number;
  readonly text: string;
}

// Hard-slice one paragraph that exceeds the bound on its own. Slices at code-unit
// offsets, backing off one unit when the cut would land inside a surrogate pair —
// a chunk boundary must never manufacture lone surrogates the embedding model
// (and JSON) would see as corruption. Yields [] for "" — absence is the value the
// packing loop below folds over, not a case it skips [LAW:dataflow-not-control-flow].
const hardSlices = (paragraph: string): ReadonlyArray<string> => {
  const out: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    let end = Math.min(start + CHUNK_MAX_CHARS, paragraph.length);
    const last = paragraph.charCodeAt(end - 1);
    if (end < paragraph.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(paragraph.slice(start, end));
    start = end;
  }
  return out;
};

// [LAW:dataflow-not-control-flow] Cut one node's prose into windows of at most
// CHUNK_MAX_CHARS: greedy paragraph packing (paragraphs are the semantic units
// worth keeping whole), with an over-long paragraph pre-cut by hardSlices so the
// fold only ever packs pieces that fit. One pass for every input — empty prose
// falls through as zero paragraphs-worth of pieces and yields [], the "this node
// contributes nothing" VALUE the projection flatMaps over; there is no skip
// branch and no empty-check special case.
const windows = (prose: string): ReadonlyArray<string> => {
  const pieces = prose.trim().split(/\n{2,}/).flatMap(hardSlices);
  const out: string[] = [];
  let open = "";
  for (const piece of pieces) {
    const joined = open.length === 0 ? piece : `${open}\n\n${piece}`;
    if (joined.length <= CHUNK_MAX_CHARS) {
      open = joined;
    } else {
      out.push(open);
      open = piece;
    }
  }
  if (open.length > 0) out.push(open);
  return out;
};

// [LAW:effects-at-boundaries] Pure and deterministic: the same view yields the
// same chunks, which is what lets the vector index key on a content hash of its
// input and stay an honest cache. Consumes the VIEWABLE dialogue — the
// overlay-applied projection — so what gets embedded is exactly what a reader
// can see, the same contract the outline and the summary prompt already keep.
// Nested subagent transcripts contribute NO chunks: a subagent block is `detail`
// visibility (nodeVisibleProse excludes it), and its nested nodes carry no
// top-level spine index — a hit inside one could never resolve to a t<N> anchor,
// so indexing it would mint citations that point nowhere.
export const deriveChunks = (view: ViewableDialogue): ReadonlyArray<DialogueChunk> =>
  view.flatMap(({ index, node }) =>
    windows(nodeVisibleProse(node)).map((text) => ({ index, text })),
  );
