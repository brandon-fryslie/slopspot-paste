// [LAW:effects-at-boundaries] The refetch freshness core (slopspot-freshness-eck.2):
// planRefetch is the PURE decision — compare the fresh fetch against the stored
// snapshot and describe what to write — and applyRefetchPlan is its one executor.
// The /api/refetch route owns the network (ingestPaste) and the clock; nothing here
// fetches, so the whole compare/archive contract is driven by a check script against
// a stub KV and the committed refetch-drift fixtures.
//
// [LAW:no-silent-failure] This module is why refetch stops being destructive: the
// prior snapshot — which since PR #101 may carry user edits — is archived as a
// PasteVersion before the overwrite, never discarded.

import type { Conversation, PasteVersion, Turn, UrlOrigin, UrlPaste } from "./types";
import { deriveTitle } from "./parser";
import { putConversation, putPasteVersion, type PasteKv } from "./storage";

// [LAW:types-are-the-program] The two honest outcomes of a refetch, as values the
// executor and the HTTP response both dispatch on. `unchanged` carries nothing —
// there is nothing to write and nothing to say beyond the fact. `changed` carries
// the full description of the transition: the archive to commit and the record that
// replaces the current one.
export type RefetchPlan =
  | { readonly kind: "unchanged" }
  | { readonly kind: "changed"; readonly version: PasteVersion; readonly updated: Conversation };

// The freshly fetched projection, as ingestPaste produced it: the new turns and the
// url origin carrying the new bytes.
export interface FreshFetch {
  readonly turns: ReadonlyArray<Turn>;
  readonly origin: UrlOrigin;
}

// [LAW:one-source-of-truth] Bytes-equality of the fetched markdown is THE
// "unchanged" test. The fixture evidence (test/fixtures/README.md, refetch-drift
// pair) proved back-to-back fetches byte-identical, so equality honestly means
// "nothing to update right now" — no fuzzy comparison to drift. Inequality means
// only "the live page differs from the stored snapshot": render drift is
// indistinguishable from upstream content change, so no caller may word it
// stronger, and a user-edited stored copy (PR #101) makes inequality expected.
//
// `now` is a parameter — the clock is the boundary's effect, keeping this pure.
export const planRefetch = (existing: UrlPaste, fresh: FreshFetch, now: number): RefetchPlan => {
  if (fresh.origin.fetched === existing.origin.fetched) return { kind: "unchanged" };
  return {
    kind: "changed",
    // The archive: the prior origin VERBATIM (bytes, url, provider, its own fetch
    // stamp), timestamped with the instant it was superseded.
    version: { origin: existing.origin, supersededAt: now },
    // The replacement mirrors what the destructive refetch always wrote — fresh
    // turns, re-derived title, fresh origin — now stamped with its fetch instant.
    // slug/createdAt/lifetime/deletedAt ride the spread. The overlay rides it too,
    // deliberately: its directives target turn indices that may have shifted, but
    // dropping them could un-redact a secret while keeping them at worst mis-hides
    // — the recoverable failure is the only honest default [LAW:no-silent-failure]
    // (the version-trail slice owns the overlay/version display gate).
    updated: {
      ...existing,
      turns: fresh.turns,
      title: deriveTitle(fresh.turns),
      origin: { ...fresh.origin, fetchedAt: now },
    },
  };
};

// [LAW:no-ambient-temporal-coupling] The one executor, owning the write order:
// archive FIRST, awaited, then overwrite. The version record is the only surviving
// copy of the bytes the update destroys, so the overwrite may not run unless the
// archive committed. A failure between the two leaves the paste intact plus an
// archive of its still-current bytes — a value-identical duplicate a later changed
// refetch supersedes, never a loss. `unchanged` writes nothing: the record already
// tells that truth.
export const applyRefetchPlan = async (
  kv: Pick<PasteKv, "put">,
  plan: RefetchPlan,
): Promise<void> => {
  switch (plan.kind) {
    case "unchanged":
      return;
    case "changed":
      await putPasteVersion(kv, plan.updated.slug, plan.version, plan.updated.lifetime);
      await putConversation(kv, plan.updated);
  }
};
