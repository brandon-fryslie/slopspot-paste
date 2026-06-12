import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { listConversations, deleteConversation } from "../../storage";
import { isPurgeable } from "../../types";
import { json, seeOther } from "../../http";

export const prerender = false;

// [LAW:single-enforcer] This endpoint is the ONE path that hard-deletes KV
// records. It only removes records whose deletedAt (or expiresAt for auto-
// expired pastes) has exceeded the grace window. Nothing else hard-deletes.
// [LAW:no-silent-failure] Every purged slug is returned in the response body.
// Promise.allSettled ensures partial failures are surfaced rather than
// silently dropping the audit trail — a partial purge is worse than any single
// delete failure because it's irreversible and the caller may not know it happened.

export const POST: APIRoute = async ({ request }) => {
  const wantsRedirect = !(request.headers.get("content-type") ?? "").includes("application/json");
  const now = Date.now();
  const conversations = await listConversations(env.PASTES);

  const toDelete = conversations.filter((c) => isPurgeable(c, now));

  // [LAW:no-silent-failure] allSettled: a single KV rejection does not abort
  // the response. Fulfilled slugs are the audit record; failed slugs are
  // surfaced so the caller knows what wasn't removed.
  const results = await Promise.allSettled(
    toDelete.map((c) => deleteConversation(env.PASTES, c.slug).then(() => c.slug)),
  );

  const purged: string[] = [];
  const failed: Array<{ slug: string; reason: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      purged.push(r.value);
    } else {
      failed.push({ slug: toDelete[i]!.slug, reason: String(r.reason) });
    }
  }

  if (wantsRedirect) {
    // [LAW:no-silent-failure] Carry the failure count in the redirect URL so
    // the admin view can render a visible warning. A clean purge redirects to
    // /sloppy; a partial failure redirects to /sloppy?purge_errors=N — the
    // count is what the browser path shows, not opaque "something went wrong".
    const location = failed.length > 0 ? `/sloppy?purge_errors=${failed.length}` : "/sloppy";
    return seeOther(location);
  }
  return json(failed.length > 0 ? 207 : 200, { purged, count: purged.length, failed });
};
