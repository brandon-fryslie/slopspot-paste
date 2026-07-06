// [LAW:effects-at-boundaries] The PURE core of the side-by-side diff. It takes an
// ALREADY-FETCHED PasteLoad (the two KV reads live at the /diff route boundary) and
// returns a resolved column — the rendered viewable conversation, or the honest reason
// it can't be shown. No IO here, so the redaction invariant below is unit-testable with
// a hand-built Conversation and no worker runtime.
//
// [LAW:composability] The whole feature is values flowing through seams that already
// exist: loadViewablePaste (the one visibility gate, called twice at the edge),
// deriveViewableDialogue (the one viewable-spine derivation), and renderDialogueHtml
// (the one renderer, reused twice). This module adds no plumbing — it only pairs two
// projections of those seams into a page-level outcome.

import { deriveViewableDialogue } from "./overlay";
import { renderDialogueHtml } from "./renderDialogue";
import {
  DEFAULT_TITLE,
  PLATFORM_LABEL,
  platformOf,
  sourceOf,
  type Platform,
  type PasteLoad,
  type PasteLoadStatus,
} from "./types";

// [LAW:types-are-the-program] One diff column is EITHER a shown conversation or an
// honest absence — never a half-shown column with an empty body. The `ok:false` arm
// carries the SAME discriminated status loadViewablePaste minted (404 gone/never-was,
// 410 tombstoned, 503 store-down), so the reason a side is missing is preserved
// verbatim into the column, never flattened to a generic "unavailable".
export type DiffColumn =
  | {
      readonly ok: true;
      readonly slug: string;
      readonly title: string;
      readonly platform: Platform;
      readonly platformLabel: string | null;
      readonly turnCount: number;
      readonly html: string;
    }
  | {
      readonly ok: false;
      readonly slug: string;
      readonly status: PasteLoadStatus;
      readonly message: string;
    };

// [LAW:single-enforcer] The redaction boundary. The shown column's HTML is derived
// from deriveViewableDialogue — the ONE viewable-spine derivation every reader surface
// routes through — never from raw conversation.turns. A turn redacted on /<slug> stays
// redacted in its diff column by construction; reading raw turns here would reopen the
// secret-leak hole the overlay + code-export epics closed. [LAW:one-source-of-truth]
// title and platform are the SAME projections /<slug> shows, not a second derivation.
export const deriveDiffColumn = (slug: string, load: PasteLoad): DiffColumn => {
  if (!load.ok) {
    return { ok: false, slug, status: load.status, message: load.message };
  }
  const c = load.conversation;
  const platform = c.platformOverride ?? platformOf(sourceOf(c.origin));
  return {
    ok: true,
    slug,
    title: c.title ?? DEFAULT_TITLE,
    platform,
    platformLabel: PLATFORM_LABEL[platform],
    turnCount: c.turns.length,
    // [LAW:types-are-the-program] topLevel:false — the SAME suppression the subagent
    // nested render uses: two columns rendered at top level would each mint id="t0",
    // id="t1", …, colliding across columns into duplicate document ids (unrepresentable
    // by the anchor's own contract). The diff page wires no minimap/permalink/clamp, so
    // the tN anchors serve nothing here; data-index/topic/role stay (only id must be
    // document-unique), keeping the spine navigable per column for later slices.
    html: renderDialogueHtml(deriveViewableDialogue(c), false),
  };
};

// [LAW:types-are-the-program] The page outcome: render the two columns, or fail. The
// diff is viewable iff AT LEAST ONE side loaded — a one-missing diff still shows the
// present side beside the absent side's honest status (the missing column is a VALUE
// the template draws, not a branch that 404s the whole page). Both-absent is the only
// failure, and it carries BOTH reasons [LAW:no-silent-failure] rather than swallowing
// one. Status falls back to the left side's — representative for the page-level code
// while the message names both truths.
export type DiffOutcome =
  | { readonly kind: "render"; readonly left: DiffColumn; readonly right: DiffColumn }
  | { readonly kind: "fail"; readonly status: PasteLoadStatus; readonly message: string };

// [LAW:no-silent-failure] The more-severe of two failure statuses, ordered by transience:
// 503 (store down — retryable) > 410 (tombstoned) > 404 (never existed). Returning the
// actual higher value (not Math.max, which widens to number) keeps the type PasteLoadStatus.
// The both-missing page uses this so a transient 503 on EITHER side yields a non-cacheable
// 503 response, rather than a cacheable 404/410 that a CDN could pin as permanently-gone
// after the store recovers.
const moreSevere = (a: PasteLoadStatus, b: PasteLoadStatus): PasteLoadStatus => (a >= b ? a : b);

export const diffOutcome = (left: DiffColumn, right: DiffColumn): DiffOutcome =>
  left.ok || right.ok
    ? { kind: "render", left, right }
    : {
        kind: "fail",
        status: moreSevere(left.status, right.status),
        message:
          `Neither paste could be shown. ` +
          `${left.slug}: ${left.message} · ${right.slug}: ${right.message}`,
      };
