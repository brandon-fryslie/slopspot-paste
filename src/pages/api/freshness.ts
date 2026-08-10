import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { resolveFreshness } from "../../freshnessService";
import { ingestPaste } from "../../parser";
import { json, decodeSlug } from "../../http";

export const prerender = false;

// [LAW:decomposition] The COMPARE-ONLY freshness check (slopspot-freshness-eck.4):
// the non-mutating public sibling of the admin /api/refetch. This handler owns only
// the HTTP edges — decode the slug, shape the outcome — plus the real effects it
// passes inward as values: the network fetch (ingestPaste's url arm) and the clock.
// The whole policy — public gate, url-arm gate, verdict cache as cooldown, compare
// via planRefetch with the write half discarded — lives in freshnessService, which
// the check script drives with a stubbed fetch and an in-memory KV.
//
// [LAW:no-silent-failure] Nothing here can touch the paste record: resolveFreshness
// never calls applyRefetchPlan, so a public check cannot become a silent refetch.

export const POST: APIRoute = async ({ request }) => {
  const slug = await decodeSlug(request);
  if (slug === null) return json(400, { error: "Missing or invalid 'slug'." });

  const outcome = await resolveFreshness(env.PASTES, slug, Date.now(), (url) =>
    ingestPaste({ kind: "url", url }, env),
  );
  // The 200 reports the verdict value, when it was decided, and whether it came
  // from the cooldown cache — the client words it (freshnessView.VERDICT_WORDING).
  return outcome.ok
    ? json(200, { verdict: outcome.verdict, checkedAt: outcome.checkedAt, cached: outcome.cached })
    : json(outcome.status, { error: outcome.error });
};
