import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { listConversations, deleteConversation } from "../../storage";
import { isPurgeable } from "../../types";
import { json, seeOther } from "../../http";

export const prerender = false;

// [LAW:single-enforcer] This endpoint is the ONE path that hard-deletes KV
// records. It only removes records whose deletedAt (or expiresAt for auto-
// expired pastes) has exceeded the grace window. Nothing else hard-deletes.
// [LAW:no-silent-failure] Every purged slug is returned in the response body
// so the caller knows exactly what was removed.

export const POST: APIRoute = async ({ request }) => {
  const wantsRedirect = !(request.headers.get("content-type") ?? "").includes("application/json");
  const now = Date.now();
  const conversations = await listConversations(env.PASTES);

  const toDelete = conversations.filter((c) => isPurgeable(c, now));

  await Promise.all(toDelete.map((c) => deleteConversation(env.PASTES, c.slug)));

  const purged = toDelete.map((c) => c.slug);

  return wantsRedirect
    ? seeOther("/sloppy")
    : json(200, { purged, count: purged.length });
};
