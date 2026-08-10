// [LAW:decomposition] The pure DISPLAY face of the freshness surface (slopspot-
// freshness-eck.4), cut apart from the plan core (freshness.ts, whose runtime
// imports reach the parser and storage) so the paste page's CLIENT script can
// import the verdict wording without dragging server modules into the browser
// bundle. Runtime imports here stay dependency-free (types.ts only); the plan
// type arrives type-only, erased at compile time.

import { utcDate, type UrlOrigin } from "./types";
import type { RefetchPlan } from "./freshness";

// [LAW:one-source-of-truth] The verdict IS planRefetch's plan kind — the compare-
// only check reports the same decision the refetch executor would have acted on,
// never a second comparison that could disagree.
export type FreshnessVerdict = RefetchPlan["kind"];

// [LAW:one-source-of-truth] The ONE wording of each verdict, worded to claim
// exactly what bytes-equality proves and nothing stronger (the fixture evidence,
// freshness.ts): "differs" may not become "the conversation was updated" — render
// drift is indistinguishable from content change, and the stored snapshot may
// carry user edits (PR #101). Every surface reads this map; none retypes the claim.
// Keyed over the FULL plan-kind union, so a new RefetchPlan arm fails compilation
// HERE until worded — which also makes the map the complete runtime witness the
// wire validator below leans on.
export const VERDICT_WORDING: { readonly [K in FreshnessVerdict]: string } = {
  unchanged: "The live page matches the stored snapshot.",
  changed: "The live page differs from the stored snapshot.",
};

// [LAW:one-source-of-truth] The wire-boundary witness (the client validates
// /api/freshness responses with it) is the wording map's OWN key set — sound and
// COMPLETE by construction, since the mapped type above requires every plan kind —
// never a second tuple that could omit a new arm. Object.hasOwn, not `in`: a
// prototype key ("toString") must never pass as a verdict.
export const isFreshnessVerdict = (v: unknown): v is FreshnessVerdict =>
  typeof v === "string" && Object.hasOwn(VERDICT_WORDING, v);

// [LAW:no-silent-failure] The fetched-age line, or null: only a record the refetch
// path stamped (origin.fetchedAt) shows an age; a pre-stamping record shows NOTHING
// — honest absence, never an instant fabricated from a different event.
export const fetchedAgeLabel = (origin: UrlOrigin): string | null =>
  origin.fetchedAt === undefined ? null : `Snapshot fetched ${utcDate(origin.fetchedAt)}`;

// How long ago a verdict was checked, for the result line. Relative minutes/hours
// rather than utcDate because the verdict cache lives about an hour (storage.ts) —
// at day granularity every result would read as today. Total over any past instant
// (hours arm included), so the wording never couples to the cache TTL's exact
// value [LAW:no-ambient-temporal-coupling]; clock skew putting checkedAt in the
// future reads as "just now", never a negative count.
export const checkedAgo = (checkedAt: number, now: number): string => {
  const mins = Math.floor((now - checkedAt) / 60_000);
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  return `checked ${hours} hour${hours === 1 ? "" : "s"} ago`;
};
