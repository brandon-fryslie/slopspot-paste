// Continuation bundle checks (slopspot-resume-239.2). Run: `tsx scripts/continuation-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the pure
// buildContinuationPayload / renderContinuationControl OFF-NETWORK:
//   - the payload leads with the framing instruction, then the labelled transcript;
//   - the SECURITY-critical property: it is built from the VIEWABLE (overlay-applied)
//     dialogue, so a redacted turn shows "[redacted]" and NEVER its original content;
//   - the tail is KEPT untruncated (the reason continuation cannot reuse the summary
//     path, which drops the tail) — a long conversation's last turn survives;
//   - an empty conversation is a value: "" payload and "" control (no dead button).

import { applyOverlay } from "../src/overlay";
import { deriveDialogue, plainView } from "../src/dialogue";
import { renderDialogueTranscript } from "../src/transcript";
import { buildContinuationPayload, renderContinuationControl } from "../src/continuation";
import type { Overlay, Turn } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const hide = (index: number): Overlay => [{ kind: "hide", target: { kind: "turn", index } }];

// A user secret in the assistant turn (t1) and a sensitive follow-up (t2) — the same
// leak-test shape overlay-check uses, so redaction of both an assistant and a spoken node
// is exercised.
const SECRET = "SECRET-TOKEN-abc123";
const SENSITIVE = "SENSITIVE-home-address";
const turns: ReadonlyArray<Turn> = [
  { kind: "message", role: "user", content: "What is the config value?" },
  { kind: "message", role: "assistant", content: `The value is ${SECRET} — keep it safe.` },
  { kind: "message", role: "user", content: `Thanks. My ${SENSITIVE} is on file.` },
];
const dialogue = deriveDialogue(turns);

// ── Shape: framing instruction leads, labelled transcript follows ─────────────
const plain = buildContinuationPayload(plainView(dialogue));
assert("payload leads with the continue instruction", plain.startsWith("Continue the following conversation"));
assert("payload carries the user prose", plain.includes("[User]: What is the config value?"));
assert("payload carries the assistant prose", plain.includes("[Assistant]: The value is"));
// [LAW:one-source-of-truth] The transcript half is the shared projection verbatim — the
// instruction is the only thing continuation adds over the one dialogue->text authority.
assert("transcript half == the shared renderDialogueTranscript", plain.endsWith(renderDialogueTranscript(plainView(dialogue).map((d) => d.node))));

// ── THE LEAK TEST: built from the viewable (redacted) projection, never raw ──
const hidAssistant = buildContinuationPayload(applyOverlay(dialogue, hide(1)));
assert("redacted assistant turn shows the marker", hidAssistant.includes("[redacted]"));
assert("redacted assistant turn does NOT leak the secret", !hidAssistant.includes(SECRET));
const hidSpoken = buildContinuationPayload(applyOverlay(dialogue, hide(2)));
assert("redacted spoken turn shows the marker", hidSpoken.includes("[redacted]"));
assert("redacted spoken turn does NOT leak the sensitive content", !hidSpoken.includes(SENSITIVE));

// ── Tail is KEPT (the reason it cannot reuse the tail-truncating summary path) ─
// A transcript far longer than the summary cap (MAX_TRANSCRIPT_CHARS = 24_000): the final
// turn — where the reader actually resumes — must survive verbatim.
const TAIL = "FINAL-TURN-resume-here";
const longTurns: ReadonlyArray<Turn> = [
  ...Array.from({ length: 40 }, (_, i): Turn => ({ kind: "message", role: i % 2 === 0 ? "user" : "assistant", content: `filler turn ${i} `.repeat(60) })),
  { kind: "message", role: "assistant", content: TAIL },
];
const longPayload = buildContinuationPayload(plainView(deriveDialogue(longTurns)));
assert("long transcript exceeds the summary cap", longPayload.length > 24_000);
assert("the tail (resume point) is kept untruncated", longPayload.includes(TAIL));
assert("no truncation marker is emitted", !longPayload.includes("[transcript truncated]"));

// ── Empty conversation is a value: "" payload, "" control ─────────────────────
assert("empty view yields empty payload", buildContinuationPayload([]) === "");
assert("empty view yields no control", renderContinuationControl([]) === "");

// ── The control carries the payload in a hidden sibling the client reads ──────
const control = renderContinuationControl(plainView(dialogue));
assert("control renders a copy-continuation button", control.includes("data-copy-continuation"));
assert("control renders the hidden payload sibling", control.includes('class="copy-continuation-payload"'));
