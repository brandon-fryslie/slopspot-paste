import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { resolveAsk } from "../../askService";
import { json, isJsonRequest } from "../../http";

export const prerender = false;

// [LAW:decomposition] This handler owns ONLY the HTTP edges: decode {slug,
// question} from the request and shape resolveAsk's outcome into a JSON
// Response — the exact cut /api/search makes. The whole policy — bound the
// question, gate the paste, retrieve through the shared scoring core, answer
// through the shared DeepSeek edge, keep only supportable citations — lives in
// askService, which the check script drives with stubbed effects.
//
// [LAW:single-enforcer] resolveAsk routes through loadViewablePaste, so a
// hidden/expired paste that 404/410s on /<slug> cannot be asked about here.
// JSON-only is deliberate — ask is a fetch-driven affordance (the reader page
// renders the answer client-side), so there is no no-JS form arm to serve.

export const POST: APIRoute = async ({ request }) => {
  // [LAW:no-silent-failure] A malformed body decodes to null and surfaces as a
  // 400 naming the missing field — never a silently-empty question.
  const body = isJsonRequest(request)
    ? ((await request.json().catch(() => null)) as { slug?: unknown; question?: unknown } | null)
    : null;
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (slug.length === 0) return json(400, { error: "Missing or invalid 'slug'." });
  if (question.length === 0) return json(400, { error: "Missing or invalid 'question'." });

  const outcome = await resolveAsk(env.PASTES, slug, question, Date.now(), env.AI, env);
  return outcome.ok
    ? json(200, {
        answer: outcome.answer,
        citations: outcome.citations,
        indexCached: outcome.indexCached,
      })
    : json(outcome.status, { error: outcome.error });
};
