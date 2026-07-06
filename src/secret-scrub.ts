// [LAW:effects-at-boundaries] The PURE redaction transform: given a string (or an Origin's
// raw text), return it with every scanSecrets match spliced OUT and replaced by an inert,
// kind-labeled marker. No IO, no store, no DOM — pure over strings, so it is unit-testable in
// isolation and composes over any coordinate space [LAW:composability]. It is the SCRUB half
// of the scan .3 warns with: the author clicks "remove", and this deletes the flagged bytes
// from what will be STORED.
//
// Why scrub, not overlay: deriveViewableDialogue (overlay.ts) is a pure DISPLAY projection —
// a hide directive leaves the secret in the stored original (turns AND the preserved
// submitOrigin.input), admin-reprojectable. For a leaked credential that is not redaction at
// all. Removing the bytes from the stored original is the only true redaction, so this
// transform is deliberately LOSSY: it is the one place the governing "store the original
// verbatim" principle is broken on purpose (ARCHITECTURE.md), because a live credential is the
// single payload where preserving the original bytes is a liability, not a feature.

import { scanSecrets, describeSecretKind, type SecretKind } from "./secret-scan";
import type { Origin, ReplayableOrigin } from "./types";

// [LAW:no-silent-failure] The marker that REPLACES a matched range. It names the KIND(s) it
// removed (from the one label source, describeSecretKind) so the reader sees WHAT was taken
// out — never the secret itself, whose bytes are dropped, not carried. It is INERT by design:
// no "@", no key-shaped run, so scanSecrets finds nothing in it. That makes scrub idempotent
// and lets the "scan a scrubbed string finds nothing" test invariant hold by construction.
const marker = (kinds: ReadonlyArray<SecretKind>): string =>
  `[redacted ${kinds.map(describeSecretKind).join(", ")}]`;

// A resolved redaction range and the kind(s) whose findings formed it. Two findings that
// overlap (or merely touch) express one intent — remove their union — so they fold into a
// single range carrying both labels, exactly as the overlay's mergeRanges folds a span.
type Redaction = { start: number; end: number; kinds: SecretKind[] };

// Fold the (start-sorted) findings into MAXIMAL DISJOINT ranges so the splice below is total:
// after merging no two ranges share coordinates, and a range that abuts the previous collapses
// into it rather than emitting two adjacent markers.
const mergeFindings = (findings: ReadonlyArray<{ kind: SecretKind; start: number; end: number }>): Redaction[] => {
  const merged: Redaction[] = [];
  for (const f of findings) {
    const last = merged[merged.length - 1];
    if (last !== undefined && f.start <= last.end) {
      last.end = Math.max(last.end, f.end);
      if (!last.kinds.includes(f.kind)) last.kinds.push(f.kind);
    } else {
      merged.push({ start: f.start, end: f.end, kinds: [f.kind] });
    }
  }
  return merged;
};

// [LAW:dataflow-not-control-flow] One expression: scan, merge, and splice each range with its
// marker applied RIGHTMOST-first (reduceRight over the ascending ranges) so every splice uses
// coordinates into the ORIGINAL string — with the ranges disjoint, the marker's differing
// length never shifts a not-yet-applied range. A clean string has no findings, so mergeFindings
// is empty and reduceRight returns the source untouched — "nothing to redact" is a value, not
// a branch.
export const scrubText = (text: string): string =>
  mergeFindings(scanSecrets(text)).reduceRight(
    (s, r) => s.slice(0, r.start) + marker(r.kinds) + s.slice(r.end),
    text,
  );

// [LAW:dataflow-not-control-flow] The raw-text arm of an Origin scrub. A text origin carries
// its verbatim `content`; a url origin carries the fetched `bytes` that reproject re-parses —
// the string a secret is reprojected FROM. The `url` link itself is left intact: it is a
// source pointer, near-zero credential risk, and scrubbing it would corrupt the "view original"
// link and the provider selection reproject reads. Exhaustive over the two replayable arms.
const scrubReplayable = (o: ReplayableOrigin): ReplayableOrigin =>
  o.kind === "url" ? { ...o, fetched: scrubText(o.fetched) } : { ...o, content: scrubText(o.content) };

// [LAW:single-enforcer] The Origin scrub: strip the secret from whatever raw text the paste
// could be REPROJECTED from, so a display never resurrects it. The editor arm carries the
// preserved import under `input` (the provenance kept when an imported paste is edited); the
// replayable arms carry the raw text directly. Absent `input` (authored from scratch) leaves
// the editor arm untouched — there is no upstream text to scrub, and the turns are the sole
// stored copy.
export const scrubOrigin = (origin: Origin): Origin =>
  origin.kind === "editor"
    ? origin.input === undefined
      ? origin
      : { ...origin, input: scrubReplayable(origin.input) }
    : scrubReplayable(origin);
