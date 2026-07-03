// Author display-overlay checks (slopspot-overlay-34a.2). Run: `tsx scripts/overlay-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the pure
// applyOverlay transform and the deriveViewableDialogue enforcer OFF-NETWORK: that an
// empty overlay is a no-op, that `hide` redacts by content-replacement WITHOUT shifting
// any t<N> anchor, and — the security-critical assertion — that a redacted turn's /t<N>
// permalink card shows "[redacted]" and NEVER the original content (no leak).

import { applyOverlay, deriveViewableDialogue, outOfRangeTarget, describeTargetFault } from "../src/overlay";
import { deriveDialogue } from "../src/dialogue";
import { renderDialogueHtml } from "../src/renderDialogue";
import { renderTurnCard } from "../src/turnCard";
import { isOverlay, isOverlayDirective } from "../src/types";
import { decodeSlug } from "../src/http";
import type { Overlay, Turn } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// A user secret in the assistant turn (t1) and a sensitive follow-up (t2), so we can
// redact both an assistant spine node and a spoken one.
const SECRET = "SECRET-TOKEN-abc123";
const SENSITIVE = "SENSITIVE-home-address";
const turns: ReadonlyArray<Turn> = [
  { kind: "message", role: "user", content: "What is the config value?" },
  { kind: "message", role: "assistant", content: `The value is ${SECRET} — keep it safe.` },
  { kind: "message", role: "user", content: `Thanks. My ${SENSITIVE} is on file.` },
];

const dialogue = deriveDialogue(turns);
assert("fixture derives 3 top-level spine nodes (t0,t1,t2)", dialogue.length === 3);

// ── Empty overlay is an exact no-op ──────────────────────────────────────────
const hide = (index: number): Overlay => [{ kind: "hide", target: { kind: "turn", index } }];
assert("applyOverlay(d, []) === d (reference identity)", applyOverlay(dialogue, []) === dialogue);
assert("empty overlay renders byte-identical", renderDialogueHtml(applyOverlay(dialogue, [])) === renderDialogueHtml(dialogue));

// ── hide an assistant turn (t1): content replaced, others untouched ──────────
const hidT1 = applyOverlay(dialogue, hide(1));
assert("hide preserves spine length (no removal)", hidT1.length === dialogue.length);
assert("hide t1 leaves t0 unchanged", eq(hidT1[0], dialogue[0]));
assert("hide t1 leaves t2 unchanged", eq(hidT1[2], dialogue[2]));
assert("hidden t1 keeps its kind (assistant)", hidT1[1]?.kind === "assistant");
const t1Html = renderDialogueHtml(hidT1);
assert("hidden t1 renders the redaction marker", t1Html.includes("[redacted]"));
assert("hidden t1 no longer renders the secret", !t1Html.includes(SECRET));

// ── Anchor stability: every t<N> id survives redaction ───────────────────────
assert("t0/t1/t2 anchors all intact after redaction", ['id="t0"', 'id="t1"', 'id="t2"'].every((a) => t1Html.includes(a)));

// ── THE LEAK TEST: the redacted turn's own /t<N> permalink cannot leak it ────
const cardT1 = renderTurnCard(hidT1, "t1");
assert("t1 card still resolves (index preserved, not null)", cardT1 !== null);
assert("t1 card shows the redaction marker", cardT1 !== null && cardT1.includes("[redacted]"));
assert("t1 card does NOT leak the secret", cardT1 !== null && !cardT1.includes(SECRET));
// A non-hidden turn's card is byte-identical to the un-overlaid render.
assert("t0 card byte-identical to un-overlaid", renderTurnCard(hidT1, "t0") === renderTurnCard(dialogue, "t0"));

// ── hide a spoken turn (t2) ──────────────────────────────────────────────────
const hidT2 = applyOverlay(dialogue, hide(2));
assert("hidden t2 keeps its kind (spoken)", hidT2[2]?.kind === "spoken");
const cardT2 = renderTurnCard(hidT2, "t2");
assert("t2 card does NOT leak the sensitive content", cardT2 !== null && !cardT2.includes(SENSITIVE) && cardT2.includes("[redacted]"));

// ── deriveViewableDialogue enforcer: reads conversation.overlay ──────────────
assert("no overlay field ⇒ equals plain deriveDialogue", eq(deriveViewableDialogue({ turns }), dialogue));
assert("overlay field ⇒ equals applyOverlay", eq(deriveViewableDialogue({ turns, overlay: hide(1) }), hidT1));

// ── isOverlay / isOverlayDirective: the shared read+write validator (slopspot-overlay-34a.3) ──
// One validator gates BOTH the KV read boundary (storage.normalizeOverlay) and the
// /api/overlay write boundary, so a stored overlay and a POSTed one are judged identically.
assert("isOverlay([]) accepts the empty (clear-redactions) overlay", isOverlay([]));
assert("isOverlay accepts a well-formed hide directive", isOverlay(hide(1)));
assert("isOverlay accepts multiple directives", isOverlay([...hide(0), ...hide(2)]));
assert("isOverlay rejects a non-array", !isOverlay({ kind: "hide", target: { kind: "turn", index: 0 } }));
assert("isOverlayDirective rejects an unknown kind", !isOverlayDirective({ kind: "nuke", target: { kind: "turn", index: 0 } }));
assert("isOverlayDirective rejects a missing target", !isOverlayDirective({ kind: "hide" }));
assert("isOverlayDirective rejects an unknown target kind", !isOverlayDirective({ kind: "hide", target: { kind: "paragraph", index: 0 } }));
assert("isOverlayDirective rejects a negative target index", !isOverlayDirective({ kind: "hide", target: { kind: "turn", index: -1 } }));
// span arm (slopspot-overlay-34a.5): a well-formed span is accepted; every malformed shape
// (missing coordinate, inverted/empty range, negative offset) is rejected at the boundary.
assert("isOverlayDirective accepts a well-formed span target", isOverlayDirective({ kind: "hide", target: { kind: "span", index: 0, piece: 0, start: 2, end: 5 } }));
assert("isOverlayDirective rejects a span missing start/end/piece", !isOverlayDirective({ kind: "hide", target: { kind: "span", index: 0 } }));
assert("isOverlayDirective rejects an inverted/empty span (start >= end)", !isOverlayDirective({ kind: "hide", target: { kind: "span", index: 0, piece: 0, start: 5, end: 5 } }));
assert("isOverlayDirective rejects a negative span offset", !isOverlayDirective({ kind: "hide", target: { kind: "span", index: 0, piece: 0, start: -1, end: 3 } }));
assert("isOverlayDirective rejects a fractional span offset", !isOverlayDirective({ kind: "hide", target: { kind: "span", index: 0, piece: 0, start: 1.5, end: 3 } }));
assert("isOverlayDirective rejects a fractional target index", !isOverlayDirective({ kind: "hide", target: { kind: "turn", index: 1.5 } }));
assert("isOverlay rejects an array containing one junk directive", !isOverlay([...hide(0), { kind: "hide" }]));

// ── outOfRangeTarget: reject a redaction that would protect nothing ───────────
assert("outOfRangeTarget passes an in-range hide (t1)", outOfRangeTarget(turns, hide(1)) === null);
assert("outOfRangeTarget passes the last in-range hide (t2)", outOfRangeTarget(turns, hide(2)) === null);
assert("outOfRangeTarget passes the empty overlay", outOfRangeTarget(turns, []) === null);
const faultT3 = outOfRangeTarget(turns, hide(3));
assert("outOfRangeTarget flags a past-the-end turn (t3 of a 3-node spine)",
  faultT3?.kind === "turn-out-of-range" && faultT3.index === 3 && faultT3.spineLength === 3);
const faultFirst = outOfRangeTarget(turns, [...hide(1), ...hide(9)]);
assert("outOfRangeTarget reports the FIRST offending target",
  faultFirst?.kind === "turn-out-of-range" && faultFirst.index === 9);

// ── SUB-TURN SPAN REDACTION (slopspot-overlay-34a.5) ─────────────────────────
// A fixture with a MULTI-PROSE-BLOCK assistant node: a thinking turn and an assistant
// message between two user turns merge into ONE assistant spine node (t1) whose prose
// pieces are, in order, piece 0 = the thinking content, piece 1 = the text content. This
// lets a span redact ONE piece of a turn while its sibling piece renders verbatim — the
// whole point of sub-turn granularity.
const THINK_SECRET = "THINK-SECRET-xyz789";
const spanTurns: ReadonlyArray<Turn> = [
  { kind: "message", role: "user", content: "Explain the setup." },
  { kind: "thinking", content: `Internally the key is ${THINK_SECRET} for now.` },
  { kind: "message", role: "assistant", content: `Use token ${SECRET} in the header.` },
  { kind: "message", role: "user", content: `Also my ${SENSITIVE} stays private.` },
];
const spanDialogue = deriveDialogue(spanTurns);
assert("span fixture derives 3 spine nodes (t0 spoken, t1 assistant, t2 spoken)", spanDialogue.length === 3);
const t1 = spanDialogue[1];
assert("span fixture t1 is an assistant node with 2 prose blocks (thinking, text)",
  t1?.kind === "assistant" && t1.blocks.length === 2);

const span = (index: number, piece: number, start: number, end: number): Overlay => [
  { kind: "hide", target: { kind: "span", index, piece, start, end } },
];
// Offsets are computed from the raw source strings — exactly the coordinate system the
// authoring UI (.7) will capture by selecting into the revealed raw prose.
const thinkSrc = `Internally the key is ${THINK_SECRET} for now.`;
const textSrc = `Use token ${SECRET} in the header.`;
const tStart = thinkSrc.indexOf(THINK_SECRET);
const sStart = textSrc.indexOf(SECRET);
const sensSrc = `Also my ${SENSITIVE} stays private.`;
const senStart = sensSrc.indexOf(SENSITIVE);

// ── span redacts ONE piece; the sibling piece of the SAME node is untouched ──
const redThink = applyOverlay(spanDialogue, span(1, 0, tStart, tStart + THINK_SECRET.length));
assert("span preserves spine length", redThink.length === spanDialogue.length);
const rn1 = redThink[1];
assert("span preserves t1's block count (piece count stable)", rn1?.kind === "assistant" && rn1.blocks.length === 2);
const redThinkHtml = renderDialogueHtml(redThink);
assert("span redacts the targeted thinking-piece secret", !redThinkHtml.includes(THINK_SECRET) && redThinkHtml.includes("[redacted]"));
assert("span leaves the SAME node's OTHER piece (text) verbatim", redThinkHtml.includes(SECRET));
assert("span keeps every t<N> anchor intact", ['id="t0"', 'id="t1"', 'id="t2"'].every((a) => redThinkHtml.includes(a)));

// THE LEAK TEST for spans: the redacted turn's own /t<N> permalink cannot leak the span.
const spanCard = renderTurnCard(redThink, "t1");
assert("span /t1 card redacts the thinking secret, never leaks it",
  spanCard !== null && !spanCard.includes(THINK_SECRET) && spanCard.includes("[redacted]"));

// ── a span on piece 1 (the text block) redacts it, leaving thinking verbatim ──
const redText = renderDialogueHtml(applyOverlay(spanDialogue, span(1, 1, sStart, sStart + SECRET.length)));
assert("span on piece 1 redacts the text secret, leaves the thinking piece", !redText.includes(SECRET) && redText.includes(THINK_SECRET));

// ── a span on a SPOKEN node (single piece 0) ─────────────────────────────────
const redSpoken = renderTurnCard(applyOverlay(spanDialogue, span(2, 0, senStart, senStart + SENSITIVE.length)), "t2");
assert("span on a spoken node redacts its content substring", redSpoken !== null && !redSpoken.includes(SENSITIVE) && redSpoken.includes("[redacted]"));

// ── multiple non-overlapping spans on one piece (right-to-left splice) ────────
// Redact two disjoint words in the text piece; both vanish, the rest stays. Applied
// rightmost-first so the marker's length never shifts a not-yet-applied range.
const useStart = textSrc.indexOf("token");
const headStart = textSrc.indexOf("header");
const twoSpans: Overlay = [
  { kind: "hide", target: { kind: "span", index: 1, piece: 1, start: useStart, end: useStart + "token".length } },
  { kind: "hide", target: { kind: "span", index: 1, piece: 1, start: headStart, end: headStart + "header".length } },
];
const redTwo = renderDialogueHtml(applyOverlay(spanDialogue, twoSpans));
assert("two spans on one piece both redact (right-to-left offsets stay valid)",
  !redTwo.includes("token") && !redTwo.includes("header") && redTwo.includes(SECRET) && redTwo.includes("in the"));

// ── OVERLAPPING and ADJACENT spans on one piece merge to their union ─────────
// The splice is correct only for disjoint ranges, so applySpansToString normalizes first.
// Proof: overlapping/adjacent spans render byte-identical to a SINGLE span over their union
// (never a garbled "[redacted]...ed]..." from splicing into an already-inserted marker).
const a1 = textSrc.indexOf("token");
const overlapSpans: Overlay = [
  { kind: "hide", target: { kind: "span", index: 1, piece: 1, start: a1, end: a1 + 15 } },
  { kind: "hide", target: { kind: "span", index: 1, piece: 1, start: a1 + 10, end: a1 + 20 } },
];
const unionSpan = (start: number, end: number): Overlay => [
  { kind: "hide", target: { kind: "span", index: 1, piece: 1, start, end } },
];
assert("overlapping spans redact exactly their union (no garbling)",
  renderDialogueHtml(applyOverlay(spanDialogue, overlapSpans)) === renderDialogueHtml(applyOverlay(spanDialogue, unionSpan(a1, a1 + 20))));
const adjacentSpans: Overlay = [
  { kind: "hide", target: { kind: "span", index: 1, piece: 1, start: a1, end: a1 + 5 } },
  { kind: "hide", target: { kind: "span", index: 1, piece: 1, start: a1 + 5, end: a1 + 10 } },
];
assert("adjacent spans collapse to one marker (== the union span)",
  renderDialogueHtml(applyOverlay(spanDialogue, adjacentSpans)) === renderDialogueHtml(applyOverlay(spanDialogue, unionSpan(a1, a1 + 10))));

// ── whole-turn hide is the SUPERSET: it overrides any span on the same node ──
const wholeT1 = applyOverlay(spanDialogue, hide(1));
assert("whole-turn hide + span on same node ⇒ whole (span moot)",
  eq(applyOverlay(spanDialogue, [...hide(1), ...span(1, 0, tStart, tStart + 4)]), wholeT1));
assert("span + whole-turn hide ⇒ whole (order-independent superset)",
  eq(applyOverlay(spanDialogue, [...span(1, 0, tStart, tStart + 4), ...hide(1)]), wholeT1));

// ── span validation faults at the write boundary (reject a no-op redaction) ──
const pieceFault = outOfRangeTarget(spanTurns, span(1, 2, 0, 1));
assert("t1 exposes exactly 2 prose pieces (piece 2 is out of range)",
  pieceFault?.kind === "piece-out-of-range" && pieceFault.pieceCount === 2);
const spokenPieceFault = outOfRangeTarget(spanTurns, span(0, 1, 0, 1));
assert("a spoken node exposes exactly 1 prose piece",
  spokenPieceFault?.kind === "piece-out-of-range" && spokenPieceFault.pieceCount === 1);
const boundsFault = outOfRangeTarget(spanTurns, span(1, 1, 0, 9999));
assert("a span past the piece length is span-out-of-bounds",
  boundsFault?.kind === "span-out-of-bounds" && boundsFault.pieceLength === textSrc.length);
const spanTurnFault = outOfRangeTarget(spanTurns, span(9, 0, 0, 1));
assert("a span on a non-existent turn is turn-out-of-range",
  spanTurnFault?.kind === "turn-out-of-range" && spanTurnFault.index === 9);
assert("an in-bounds span passes outOfRangeTarget", outOfRangeTarget(spanTurns, span(1, 0, tStart, tStart + THINK_SECRET.length)) === null);

// ── describeTargetFault: each fault surfaces a legible reason at the boundary ─
assert("describeTargetFault names the turn for a turn fault",
  describeTargetFault({ kind: "turn-out-of-range", index: 3, spineLength: 3 }).includes("turn 3"));
assert("describeTargetFault names the piece for a piece fault",
  describeTargetFault({ kind: "piece-out-of-range", index: 1, piece: 2, pieceCount: 2 }).includes("piece 2"));
assert("describeTargetFault names the char range for a span fault",
  describeTargetFault({ kind: "span-out-of-bounds", index: 1, piece: 1, start: 0, end: 99, pieceLength: 34 }).includes("99"));
// A zero-turn paste (Conversation.turns is ReadonlyArray, so empty is representable) has no
// t<N> range to name — the message must not render the nonsensical "t0–t-1".
const zeroTurnMsg = describeTargetFault({ kind: "turn-out-of-range", index: 0, spineLength: 0 });
assert("describeTargetFault says 'no turns' for a zero-turn paste (not t0–t-1)",
  zeroTurnMsg === "Directive targets turn 0, but this paste has no turns." && !zeroTurnMsg.includes("t-1"));

// ── a span overlay survives JSON storage + read validation, then redacts ─────
const spanWire: unknown = JSON.parse(JSON.stringify(span(1, 0, tStart, tStart + THINK_SECRET.length)));
assert("a span overlay survives JSON round-trip + isOverlay validation", isOverlay(spanWire));
const spanViewable = deriveViewableDialogue({ turns: spanTurns, overlay: isOverlay(spanWire) ? spanWire : undefined });
assert("a stored span redacts on the viewable dialogue like applyOverlay",
  eq(spanViewable, applyOverlay(spanDialogue, span(1, 0, tStart, tStart + THINK_SECRET.length))));

// ── Read-boundary round-trip: an overlay survives JSON storage, then redacts ──
// This is the store -> load -> render chain the endpoint drives, off-network: the overlay
// is serialized (as putConversation would), re-read and re-validated exactly as
// storage.normalizeOverlay does (isOverlay(raw) ? raw : undefined), then rendered.
const overlayWire: unknown = JSON.parse(JSON.stringify(hide(1)));
const normalized: Overlay | undefined = isOverlay(overlayWire) ? overlayWire : undefined;
assert("stored overlay survives JSON round-trip + read validation", eq(normalized, hide(1)));
const viewableFromStore = deriveViewableDialogue({ turns, overlay: normalized });
assert("loaded overlay redacts the same turn applyOverlay does", eq(viewableFromStore, hidT1));
const storedCardT1 = renderTurnCard(viewableFromStore, "t1");
assert("loaded redaction's /t1 card shows the marker, never the secret",
  storedCardT1 !== null && storedCardT1.includes("[redacted]") && !storedCardT1.includes(SECRET));

// A present-but-corrupt stored overlay is DROPPED to undefined (never leaked) — the
// read boundary un-redacts loudly (logged in storage), it does not silently trust junk.
const junkWire: unknown = JSON.parse(JSON.stringify([{ kind: "hide" }]));
const droppedOverlay: Overlay | undefined = isOverlay(junkWire) ? junkWire : undefined;
assert("corrupt stored overlay normalizes to undefined (dropped, not trusted)", droppedOverlay === undefined);
// Absent overlay is the common legacy/no-redaction case: undefined, zero migration.
const absentWire: unknown = JSON.parse(JSON.stringify({ turns })) as { overlay?: unknown };
assert("absent overlay field normalizes to undefined",
  (isOverlay((absentWire as { overlay?: unknown }).overlay) ? (absentWire as { overlay?: unknown }).overlay : undefined) === undefined);

// ── Write-boundary decode: what /api/overlay accepts, driven by real Requests ─
// The endpoint decodes the slug via the shared decodeSlug (on a clone) and validates the
// directives body via isOverlay. Assert both gates on real Request objects, off-network.
const overlayReq = (body: unknown): Request =>
  new Request("https://x/api/overlay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

void (async () => {
  const good = overlayReq({ slug: "abcdefghjk", directives: hide(1) });
  assert("valid POST body: slug decodes", (await decodeSlug(good.clone())) === "abcdefghjk");
  assert("valid POST body: directives pass isOverlay",
    isOverlay(((await good.json()) as { directives?: unknown }).directives));

  const noSlug = overlayReq({ directives: hide(1) });
  assert("missing slug decodes to null (endpoint 400s)", (await decodeSlug(noSlug)) === null);

  const junkDirectives = overlayReq({ slug: "abcdefghjk", directives: [{ kind: "nuke", target: { kind: "turn", index: 0 } }] });
  assert("junk directive fails isOverlay (endpoint 400s)",
    !isOverlay(((await junkDirectives.json()) as { directives?: unknown }).directives));

  const notArray = overlayReq({ slug: "abcdefghjk", directives: { kind: "hide", target: { kind: "turn", index: 0 } } });
  assert("non-array directives fails isOverlay (endpoint 400s)",
    !isOverlay(((await notArray.json()) as { directives?: unknown }).directives));

  const emptyOk = overlayReq({ slug: "abcdefghjk", directives: [] });
  assert("empty directives array passes isOverlay (clear-redactions write)",
    isOverlay(((await emptyOk.json()) as { directives?: unknown }).directives));

  console.log("overlay-check complete");
})();
