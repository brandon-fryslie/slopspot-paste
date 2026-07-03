// Author display-overlay checks (slopspot-overlay-34a.2). Run: `tsx scripts/overlay-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the pure
// applyOverlay transform and the deriveViewableDialogue enforcer OFF-NETWORK: that an
// empty overlay is a no-op, that `hide` redacts by content-replacement WITHOUT shifting
// any t<N> anchor, and — the security-critical assertion — that a redacted turn's /t<N>
// permalink card shows "[redacted]" and NEVER the original content (no leak).

import { applyOverlay, deriveViewableDialogue } from "../src/overlay";
import { deriveDialogue } from "../src/dialogue";
import { renderDialogueHtml } from "../src/renderDialogue";
import { renderTurnCard } from "../src/turnCard";
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

console.log("overlay-check complete");
