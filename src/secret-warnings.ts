// [LAW:effects-at-boundaries] The warn-only projection: given the turns the author is about
// to publish, which turns look like they carry a leaked secret or PII, and of what kind. Pure
// over the turn list — no IO, no store, no DOM — so it is unit-testable in isolation and the
// editor consumes it as one derived value [LAW:dataflow-not-control-flow].
//
// [LAW:composability] It composes the coordinate-agnostic scanner (secret-scan.ts, pure over a
// string) with the ONE thing this slice adds: knowledge of a Turn's shape. It is DELIBERATELY
// coarser than the offer-to-redact slice (.4): that slice scans spanPiecesByTurn(turns) so a
// finding's [start,end) is an overlay span target; THIS slice scans each turn's WHOLE raw text
// — every text-bearing field, including tool-call args and output — so it catches a secret
// hiding in a block the overlay cannot address, and reports only the coarse "this turn, these
// kinds". It bakes in NO coordinate space for .4 to undo [LAW:no-mode-explosion]: one scanner,
// two input strings, variability in VALUES not modes.

import type { SubagentTranscript, Turn } from "./types";
import { scanSecrets, type SecretKind } from "./secret-scan";

// [LAW:types-are-the-program] A warning names one offending turn and the DISTINCT kinds found
// in it — never the matched text (SecretFinding carries none, so masking is by construction:
// the warning cannot echo the secret it flags). turnIndex indexes into the SAME turn list the
// scan was handed, so the consumer maps it back to the block the reader is looking at.
export interface TurnSecretWarning {
  readonly turnIndex: number;
  readonly kinds: ReadonlyArray<SecretKind>;
}

// [LAW:no-silent-failure] The full scannable text of a turn: an EXHAUSTIVE switch, so a new
// Turn kind is compiler-forced to declare what text it exposes rather than silently scanning
// "" and letting a secret through. Structured turns join every text-bearing field (a tool call
// puts secrets in args or output far more often than in its name), and a subagent recurses so a
// leak nested one level down is not invisible — the editor holds only authorable turns, but a
// pure function honest for every Turn kind is the reusable, drift-proof one [LAW:carrying-cost].
const transcriptScanText = (transcript: SubagentTranscript): string =>
  transcript.kind === "captured"
    ? transcript.turns.map(turnScanText).join("\n")
    : transcript.prompt + "\n" + transcript.result;

const turnScanText = (turn: Turn): string => {
  switch (turn.kind) {
    case "message":
    case "insight":
    case "thinking":
      return turn.content;
    case "turn-summary":
      return turn.text;
    case "tool-call":
      return [turn.tool, turn.args, turn.output?.text ?? ""].join("\n");
    case "usage":
      return "";
    case "subagent":
      return transcriptScanText(turn.transcript);
  }
};

// [LAW:dataflow-not-control-flow] One pass over the turns: scan each, and a turn with no
// finding contributes the empty array that flatMap folds away — "no warning" is a value, not a
// skipped branch. Kinds are deduped in source order (scanSecrets sorts by start, so first-seen
// order is deterministic), giving the UI a stable, secret-free label list per turn.
export const scanTurnsForSecrets = (turns: ReadonlyArray<Turn>): ReadonlyArray<TurnSecretWarning> =>
  turns.flatMap((turn, turnIndex) => {
    const findings = scanSecrets(turnScanText(turn));
    if (findings.length === 0) return [];
    return [{ turnIndex, kinds: [...new Set(findings.map((f) => f.kind))] }];
  });
