import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getConversation, putConversation } from "../../storage";
import { isValidSlug } from "../../slug";
import { json, seeOther } from "../../http";

export const prerender = false;

// [LAW:single-enforcer] All soft-deletes route through this one endpoint.
// Setting deletedAt is the only mutation; no bytes are removed — the record
// survives in KV until the purge step clears it after the grace window.
// ([LAW:no-silent-failure]: if the record is already deleted, this is a no-op
// that returns 200 — idempotent, not an error, because the outcome is the same.)

export const POST: APIRoute = async ({ request }) => {
  const wantsRedirect = !(request.headers.get("content-type") ?? "").includes("application/json");

  let slug: string | null = null;
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    const body = await request.json().catch(() => null) as { slug?: unknown } | null;
    if (typeof body?.slug === "string") slug = body.slug;
  } else {
    const form = await request.formData().catch(() => null);
    const raw = form?.get("slug");
    if (typeof raw === "string") slug = raw;
  }

  if (!slug || !isValidSlug(slug)) {
    return json(400, { error: "Missing or invalid slug." });
  }

  const conversation = await getConversation(env.PASTES, slug);
  if (!conversation) {
    return json(404, { error: "Paste not found." });
  }

  if (conversation.deletedAt !== null) {
    // Already tombstoned — idempotent.
    return wantsRedirect ? seeOther("/sloppy") : json(200, { slug });
  }

  const tombstoned = { ...conversation, deletedAt: Date.now() };
  await putConversation(env.PASTES, tombstoned);

  return wantsRedirect ? seeOther("/sloppy") : json(200, { slug });
};
