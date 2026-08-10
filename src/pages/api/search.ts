import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { resolveSearch } from "../../searchService";
import { json, isJsonRequest } from "../../http";

export const prerender = false;

// [LAW:decomposition] This handler owns ONLY the HTTP edges: decode {slug, query}
// from the request and shape resolveSearch's outcome into a JSON Response. The
// whole policy — gate the paste, hash its chunks, cache-else-embed the index,
// score, rank — lives in searchService, which the check script drives with a
// stubbed embedder and an in-memory KV.
//
// [LAW:single-enforcer] resolveSearch routes through loadViewablePaste, so a
// hidden/expired paste that 404/410s on /<slug> cannot be searched here.
// isJsonRequest is the shared media-type predicate (http.ts). decodeSlug is NOT
// reused: it decodes a slug-only body (and reads the one-shot body doing so),
// while this endpoint needs slug AND query from one read. JSON-only is deliberate —
// search is a fetch-driven affordance (slice .5's query box renders results
// client-side), so there is no no-JS form arm to serve.

export const POST: APIRoute = async ({ request }) => {
  // [LAW:no-silent-failure] A malformed body decodes to null and surfaces as a
  // 400 naming the missing field — never a silently-empty search.
  const body = isJsonRequest(request)
    ? ((await request.json().catch(() => null)) as { slug?: unknown; query?: unknown } | null)
    : null;
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (slug.length === 0) return json(400, { error: "Missing or invalid 'slug'." });
  if (query.length === 0) return json(400, { error: "Missing or invalid 'query'." });

  const outcome = await resolveSearch(env.PASTES, slug, query, Date.now(), env.AI);
  return outcome.ok
    ? json(200, { hits: outcome.hits, indexCached: outcome.indexCached })
    : json(outcome.status, { error: outcome.error });
};
