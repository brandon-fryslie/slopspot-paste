// [LAW:effects-at-boundaries] The PURE core of the version trail (slopspot-freshness-
// eck.3): given an already-load-gated Conversation plus the KV-read stamps/record (the
// IO lives at the two route boundaries), derive what the paste page's trail shows and
// what the version page renders. No IO here, so the whole contract — including the
// privacy gate, the security-critical property — is driven by a check script over the
// committed refetch-drift fixture pair.
//
// [LAW:composability] The feature is values flowing through seams that already exist:
// reprojectOrigin (the one origin→turns replay), overlayWithholdsContent (the one
// statement of which directives withhold content), outOfRangeTarget (the one
// target-validity enforcer), deriveOkColumn + alignDialogues (the diff substrate).
// This module adds no parallel machinery — it pairs those projections into two
// page-level outcomes.

import { alignDialogues, deriveOkColumn, type DiffRow, type OkColumn } from "./diff";
import { deriveDialogue, plainView, type DisplayNode } from "./dialogue";
import { outOfRangeTarget, overlayWithholdsContent, type TargetFault } from "./overlay";
import { deriveTitle, reprojectOrigin } from "./parser";
import {
  DEFAULT_TITLE,
  PLATFORM_LABEL,
  platformOf,
  sourceOf,
  type Conversation,
  type PasteVersion,
  type Platform,
} from "./types";

// [LAW:one-source-of-truth] The version page's path, minted once: the trail's links and
// the route that serves them cannot drift apart. The stamp is the supersededAt instant —
// the same value that keys the KV record, so a link IS a lookup key, never a second index.
export const versionPath = (slug: string, supersededAt: number): string =>
  `/${slug}/versions/${supersededAt}`;

// [LAW:types-are-the-program] What the paste page's trail block shows — or null: a paste
// with no archived versions shows NO affordance (the ticket's contract), and null is that
// absence as a value the template skips. Both arms carry the stamps (dates are metadata,
// not content — they reveal only that refetches happened) and the read-time staleness
// fault; the ARM decides whether entries link to version content:
//   `diffable`  — nothing withheld; each stamp links to the server-rendered diff.
//   `withheld`  — the overlay withholds content (hide/feature), so the trail lists dates
//                 only. The withheld arm carrying no links is the template-level face of
//                 the gate; versionPageOutcome below enforces it for a hand-typed URL.
//
// [LAW:one-source-of-truth] `staleFault` is DERIVED here at read time — outOfRangeTarget
// over the stored directives + current turns — never stored (PR #109 review finding, per
// the ticket): after a changed refetch the authored overlay rides the update unchanged,
// so a directive may target an index the new turns no longer have; an out-of-range hide
// is a silent no-op at render, and this surfaces that fact instead of persisting a flag
// that could drift from the turns it describes.
export type VersionTrail =
  | {
      readonly kind: "diffable";
      readonly stamps: ReadonlyArray<number>;
      readonly staleFault: TargetFault | null;
    }
  | {
      readonly kind: "withheld";
      readonly stamps: ReadonlyArray<number>;
      readonly staleFault: TargetFault | null;
    };

export const deriveVersionTrail = (
  c: Conversation,
  stamps: ReadonlyArray<number>,
): VersionTrail | null => {
  if (stamps.length === 0) return null;
  const overlay = c.overlay ?? [];
  return {
    kind: overlayWithholdsContent(overlay) ? "withheld" : "diffable",
    stamps,
    staleFault: outOfRangeTarget(c.turns, overlay),
  };
};

// The snapshot column's head: the same display facts an OkColumn carries for the current
// side, DERIVED from the archived origin (title from the replayed turns, platform from
// the origin's provider) plus the two instants that place it in time. fetchedAt is
// null for records archived before the refetch path stamped it — honest absence, worded
// by the template, never approximated into a fake instant [LAW:no-silent-failure].
export type SnapshotHead = {
  readonly title: string;
  readonly platform: Platform;
  readonly platformLabel: string | null;
  readonly turnCount: number;
  readonly fetchedAt: number | null;
  readonly supersededAt: number;
};

// A diff row plus the derived "did this row change" fact: a one-sided gap IS a change,
// and a paired row changed iff its two spine nodes differ structurally. The comparison
// reads `.node` only — `collapsed` is presentational (the current side may fold a turn)
// and `index` is positional; neither is a content difference.
export type VersionDiffRow = { readonly row: DiffRow; readonly changed: boolean };

const nodesEqual = (l: DisplayNode, r: DisplayNode): boolean =>
  JSON.stringify(l.node) === JSON.stringify(r.node);

// [LAW:types-are-the-program] The version page's outcome, one arm per truth, and the
// privacy gate is structural: the `withheld` arm carries NO view and NO rows, so a
// redacted paste leaking un-redacted snapshot content through this page is
// unrepresentable, not merely unrendered.
//   `withheld`    — the current overlay withholds content (hide/feature). The FIRST arm
//                   so the outcome ignores the record entirely: a redacted paste answers
//                   identically whether or not the stamp exists — no existence oracle.
//                   (The route boundary still performs its one KV read unconditionally
//                   [LAW:dataflow-not-control-flow]; the gate is decided here alone
//                   [LAW:single-enforcer], and the spare read on a redacted paste's
//                   hand-typed version URL is the price of a single decider.)
//   `not-found`   — no version archived at that instant (or the stamp never parsed).
//   `unparseable` — the archived bytes no longer replay through the provider parser:
//                   real corruption or a parser regression, surfaced loudly at the
//                   boundary, never a silent empty column [LAW:no-silent-failure].
//   `diff`        — the aligned comparison: snapshot (older) left, current right.
export type VersionPageOutcome =
  | { readonly kind: "withheld" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unparseable"; readonly supersededAt: number }
  | {
      readonly kind: "diff";
      readonly snapshot: SnapshotHead;
      readonly current: OkColumn;
      readonly rows: ReadonlyArray<VersionDiffRow>;
    };

// [LAW:one-source-of-truth] The snapshot side re-derives from the archived origin
// through reprojectOrigin — the one origin→turns replay — exactly as the governing
// principle demands: the stored bytes are the authority, the turns a disposable
// projection re-derived at render. It renders PLAIN (no overlay): the current overlay's
// directives target current indices and cannot be honestly projected onto old turns —
// and every content-withholding overlay was already refused above, so a plain render
// exposes nothing the current page withholds. The current side routes through
// deriveOkColumn → deriveViewableDialogue, the one redaction enforcer, so a
// collapse-only overlay still folds on the right [LAW:single-enforcer].
export const versionPageOutcome = (
  c: Conversation,
  version: PasteVersion | null,
): VersionPageOutcome => {
  if (overlayWithholdsContent(c.overlay ?? [])) return { kind: "withheld" };
  if (version === null) return { kind: "not-found" };
  const turns = reprojectOrigin(version.origin);
  if (turns === null || turns.length === 0) {
    return { kind: "unparseable", supersededAt: version.supersededAt };
  }
  const platform = platformOf(sourceOf(version.origin));
  const current = deriveOkColumn(c.slug, c);
  const snapshotView = plainView(deriveDialogue(turns));
  return {
    kind: "diff",
    snapshot: {
      title: deriveTitle(turns) ?? DEFAULT_TITLE,
      platform,
      platformLabel: PLATFORM_LABEL[platform],
      turnCount: turns.length,
      fetchedAt: version.origin.fetchedAt ?? null,
      supersededAt: version.supersededAt,
    },
    current,
    rows: alignDialogues(snapshotView, current.view).map((row) => ({
      row,
      changed: row.kind !== "paired" || !nodesEqual(row.left, row.right),
    })),
  };
};
