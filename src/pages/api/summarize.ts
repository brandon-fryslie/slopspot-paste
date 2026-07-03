import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { resolveSummary } from "../../summaryService";
import { json, decodeSlug } from "../../http";

export const prerender = false;

// [LAW:decomposition] This handler owns ONLY the HTTP edges: decode the slug from
// the request, and shape resolveSummary's outcome into a JSON Response. The whole
// policy — gate the paste, hash its turns, serve-cache-else-generate — lives in
// summaryService (resolveSummary), which a test can drive with a stubbed LLM and an
// in-memory KV. Keeping the orchestration out of the Astro/Worker handler is what
// makes it verifiable off the network.
//
// [LAW:single-enforcer] resolveSummary routes through loadViewablePaste, so a
// hidden/expired paste that 404/410s on /<slug> cannot be summarized here.
// decodeSlug is the shared HTTP decoder (http.ts) — one case-insensitive decode for
// every slug endpoint, no per-handler copy.

export const POST: APIRoute = async ({ request }) => {
  const slug = await decodeSlug(request);
  if (slug === null) return json(400, { error: "Missing or invalid 'slug'." });

  // [LAW:dataflow-not-control-flow] Regenerate is the same resolve with the cache
  // bypassed — a `force` directive on the resolution, not a second endpoint. It rides
  // the query (?force=1) rather than the body so decodeSlug stays the single body
  // decoder and the one-shot request body is never read twice. Absent → false → the
  // cache-serving path, so a plain Summarize and a Regenerate differ by one value.
  const force = new URL(request.url).searchParams.get("force") === "1";

  const outcome = await resolveSummary(env.PASTES, slug, Date.now(), env, force);
  return outcome.ok
    ? json(200, { summary: outcome.summary, cached: outcome.cached })
    : json(outcome.status, { error: outcome.error });
};
