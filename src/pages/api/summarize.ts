import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { resolveSummary } from "../../summaryService";
import { json } from "../../http";

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

// [LAW:dataflow-not-control-flow] One decode path, mirroring /api/refetch.
const decodeSlug = async (request: Request): Promise<string | null> => {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as { slug?: unknown } | null;
    return body && typeof body.slug === "string" ? body.slug : null;
  }
  const form = await request.formData().catch(() => null);
  const slug = form?.get("slug");
  return typeof slug === "string" ? slug : null;
};

export const POST: APIRoute = async ({ request }) => {
  const slug = await decodeSlug(request);
  if (slug === null) return json(400, { error: "Missing or invalid 'slug'." });

  const outcome = await resolveSummary(env.PASTES, slug, Date.now(), env);
  return outcome.ok
    ? json(200, { summary: outcome.summary, cached: outcome.cached })
    : json(outcome.status, { error: outcome.error });
};
