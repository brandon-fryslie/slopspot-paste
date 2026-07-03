// Author display-overlay checks (slopspot-overlay-34a.2). Run: `tsx scripts/overlay-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the pure
// applyOverlay transform and the deriveViewableDialogue enforcer OFF-NETWORK: that an
// empty overlay is a no-op, that `hide` redacts by content-replacement WITHOUT shifting
// any t<N> anchor, and — the security-critical assertion — that a redacted turn's /t<N>
// permalink card shows "[redacted]" and NEVER the original content (no leak).

import { applyOverlay, deriveViewableDialogue, outOfRangeTarget } from "../src/overlay";
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
assert("isOverlayDirective rejects a non-turn target kind", !isOverlayDirective({ kind: "hide", target: { kind: "span", index: 0 } }));
assert("isOverlayDirective rejects a negative target index", !isOverlayDirective({ kind: "hide", target: { kind: "turn", index: -1 } }));
assert("isOverlayDirective rejects a fractional target index", !isOverlayDirective({ kind: "hide", target: { kind: "turn", index: 1.5 } }));
assert("isOverlay rejects an array containing one junk directive", !isOverlay([...hide(0), { kind: "hide" }]));

// ── outOfRangeTarget: reject a redaction that would protect nothing ───────────
assert("outOfRangeTarget passes an in-range hide (t1)", outOfRangeTarget(turns, hide(1)) === null);
assert("outOfRangeTarget passes the last in-range hide (t2)", outOfRangeTarget(turns, hide(2)) === null);
assert("outOfRangeTarget passes the empty overlay", outOfRangeTarget(turns, []) === null);
assert("outOfRangeTarget flags a past-the-end index (t3 of a 3-node spine)", outOfRangeTarget(turns, hide(3)) === 3);
assert("outOfRangeTarget reports the FIRST offending index", outOfRangeTarget(turns, [...hide(1), ...hide(9)]) === 9);

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
