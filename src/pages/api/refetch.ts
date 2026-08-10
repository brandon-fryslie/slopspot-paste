import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getConversation } from "../../storage";
import { ingestPaste } from "../../parser";
import { planRefetch, applyRefetchPlan } from "../../freshness";
import { isUrlPaste } from "../../types";
import { json, seeOther, decodeSlug, isJsonRequest } from "../../http";

export const prerender = false;

// [LAW:decomposition] The freshness arm is a DISTINCT part from replay-from-
// stored-bytes (/api/reproject): it reaches the network, requires the env,
// gates on url origins only, and mutates the record. These orthogonal concerns
// make it a separate endpoint, not a mode flag on reproject.
//
// [LAW:effects-at-boundaries] This handler owns the effects — the network fetch
// (inside ingestPaste), the clock, and the KV writes (inside applyRefetchPlan).
// The compare/archive decision itself is the pure planRefetch (freshness.ts).
//
// [LAW:no-silent-failure] A dead link, a scrape error, or a too-large payload
// leaves the stored record COMPLETELY UNTOUCHED — ingestPaste returns
// {ok:false,reason} and we propagate before touching KV. And a refetch whose
// fresh bytes DIFFER no longer discards the prior snapshot: it is archived as a
// version record before the overwrite (slopspot-freshness-eck.2).

export const POST: APIRoute = async ({ request }) => {
  const wantsRedirect = !isJsonRequest(request);
  const slug = await decodeSlug(request);
  if (slug === null) return json(400, { error: "Missing or invalid 'slug'." });

  const existing = await getConversation(env.PASTES, slug);
  if (existing === null) return json(404, { error: "No such paste." });

  // [LAW:types-are-the-program] Only url origins have a link to re-fetch; the
  // isUrlPaste refinement is what lets planRefetch take the narrowed type. All
  // other origins (text arms, editor, absent) are rejected loudly; the /sloppy
  // affordance is hidden for them, but a directly-crafted request still fails
  // here instead of no-op'ing. [LAW:no-silent-failure]
  if (!isUrlPaste(existing)) {
    return json(409, { error: "This paste does not have a fetched-URL origin to re-fetch." });
  }

  // [LAW:effects-at-boundaries] Network access happens exactly here.
  const fresh = await ingestPaste({ kind: "url", url: existing.origin.url }, env);
  if (!fresh.ok) {
    return json(422, { error: `Re-fetch failed: ${fresh.reason}` });
  }
  // [LAW:types-are-the-program] ingestPaste's url arm always yields a url origin,
  // but its ParseResult signature is wider; this closes the enumeration gap
  // loudly rather than casting past it.
  if (fresh.origin.kind !== "url") {
    return json(500, { error: "Ingest returned a non-url origin for a url input." });
  }

  const plan = planRefetch(existing, { turns: fresh.turns, origin: fresh.origin }, Date.now());
  await applyRefetchPlan(env.PASTES, plan);

  // The JSON response reports which outcome ran — "unchanged" (zero writes) or
  // "changed" (prior snapshot archived, record updated) — so a caller never has
  // to re-read the record to learn what its refetch did.
  return wantsRedirect ? seeOther("/sloppy") : json(200, { slug, outcome: plan.kind });
};
