import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getConversation, putConversation } from "../../storage";
import { ingestPaste, deriveTitle } from "../../parser";
import { json, seeOther, decodeSlug, isJsonRequest } from "../../http";

export const prerender = false;

// [LAW:decomposition] The freshness arm is a DISTINCT part from replay-from-
// stored-bytes (/api/reproject): it reaches the network, requires the env,
// gates on claude-share only, and MUTATES origin.fetched. These four
// orthogonal concerns make it a separate endpoint, not a mode flag on reproject.
//
// [LAW:effects-at-boundaries] All network activity (Firecrawl) lives inside
// ingestPaste. This handler is the boundary that triggers it; everything above
// that call is pure reads.
//
// [LAW:no-silent-failure] A dead link, a scrape error, or a too-large payload
// leaves the stored record COMPLETELY UNTOUCHED — no partial update.
// ingestPaste already returns {ok:false,reason} on any failure; we propagate
// the reason and return before touching KV.

export const POST: APIRoute = async ({ request }) => {
  const wantsRedirect = !isJsonRequest(request);
  const slug = await decodeSlug(request);
  if (slug === null) return json(400, { error: "Missing or invalid 'slug'." });

  const existing = await getConversation(env.PASTES, slug);
  if (existing === null) return json(404, { error: "No such paste." });

  // [LAW:no-silent-failure] Only url origins have a link to re-fetch. All other
  // origins (text arms, editor, absent) are rejected loudly; the /sloppy
  // affordance is hidden for them, but a directly-crafted request still fails
  // here instead of no-op'ing.
  const origin = existing.origin;
  if (origin === null || origin.kind !== "url") {
    return json(409, { error: "This paste does not have a fetched-URL origin to re-fetch." });
  }

  // [LAW:effects-at-boundaries] Network access happens exactly here.
  // ingestPaste fetches origin.url via Firecrawl, validates the size cap,
  // parses the fresh markdown, and returns {ok:true,turns,origin} or {ok:false,reason}.
  const fresh = await ingestPaste({ kind: "url", url: origin.url }, env);
  if (!fresh.ok) {
    return json(422, { error: `Re-fetch failed: ${fresh.reason}` });
  }

  // [LAW:one-source-of-truth] Replace only the derived values — the fetched
  // bytes inside the origin, the turns re-parsed from them, and the derived
  // title. The origin field is now bare Origin|null, so fresh.origin replaces
  // existing.origin directly. slug/createdAt/lifetime are preserved by spread.
  const updated = {
    ...existing,
    turns: fresh.turns,
    title: deriveTitle(fresh.turns),
    origin: fresh.origin,
  };
  await putConversation(env.PASTES, updated);

  return wantsRedirect ? seeOther("/sloppy") : json(200, { slug: updated.slug });
};
