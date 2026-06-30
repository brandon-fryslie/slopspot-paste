import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { deriveTitle } from "../../parser";
import { ingestRequest } from "../../ingest-request";
import { putConversation } from "../../storage";
import { generateSlug } from "../../slug";
import { json, seeOther } from "../../http";
import type { Conversation } from "../../types";
import { lifetimeFromChoice } from "../../types";

export const prerender = false;

// [LAW:single-enforcer] All validation lives at the ingest boundary
// (ingestRequest, ingest-request.ts) — decode, size cap, parse, turn bounds. This
// handler owns only the publish tail: stamp a Conversation and store it. The
// shared pipeline guarantees /api/paste and /api/draft accept identical input.
export const POST: APIRoute = async ({ request }) => {
  // [LAW:dataflow-not-control-flow] The success response modality is data derived
  // from the request's content-type. A form-encoded POST is the no-JS <form> (a
  // browser navigation), so success redirects to the rendered paste; a JSON POST
  // is the editor/API and gets { slug }. (Error bodies stay JSON for both.)
  const wantsRedirect = !(request.headers.get("content-type") ?? "").includes("application/json");

  const result = await ingestRequest(request, env);
  if (!result.ok) return json(result.status, { error: result.error });
  const parsed = result.parsed;

  const now = Date.now();
  const conversation: Conversation = {
    slug: generateSlug(),
    createdAt: now,
    lifetime: lifetimeFromChoice("expires", now),
    deletedAt: null,
    turns: parsed.turns,
    title: deriveTitle(parsed.turns),
    // [LAW:one-source-of-truth] The captured source of truth is stamped here once,
    // directly from the parse result. Styling provenance (`source`) is derived on
    // read via sourceOf — never stored as a second field that could drift.
    origin: parsed.origin,
    // Only the editor arm can supply an explicit override; text/form/legacy paths
    // always derive platform from source ([LAW:one-source-of-truth]).
    platformOverride: result.platformOverride,
  };

  await putConversation(env.PASTES, conversation);
  return wantsRedirect
    ? seeOther("/" + conversation.slug)
    : json(200, { slug: conversation.slug });
};
