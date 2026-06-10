import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getConversation, putConversation } from "../../storage";
import { canonicalize, deriveTitle } from "../../parser";
import { json, seeOther } from "../../http";

export const prerender = false;

// [LAW:one-source-of-truth] Re-projection re-derives a paste's turns from its
// canonical Origin and re-stores them under the SAME slug. Origin is the
// authority; turns are the derived cache; this endpoint is the explicit
// re-derivation path — replaying the captured source through TODAY's parser, so
// an old paste picks up parser fixes without minting a new link.
//
// [LAW:single-enforcer] It reuses canonicalize — the same primitive POST
// /api/paste uses at create time — so the two paths cannot produce different
// turns from the same origin. And it re-stores through putConversation, the one
// writer, so lifetime/TTL semantics are owned in exactly one place.
//
// [LAW:effects-at-boundaries] No network: reprojectOrigin (inside canonicalize)
// replays a claude-share origin from its STORED bytes, never re-fetching. The
// optional share-only re-fetch ("freshness") arm is a separate, deferred concern.

// [LAW:dataflow-not-control-flow] One decode path keyed on content-type, mirroring
// /api/refresh: a JSON fetch from the admin script, or a no-JS <form> POST. Both
// converge to one slug the handler acts on.
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
  // [LAW:dataflow-not-control-flow] Response modality is derived from the request
  // shape, same key decodeSlug uses: a no-JS <form> POST navigates back to the
  // admin view; a JSON fetch gets { slug }. One mutation, two representations.
  const wantsRedirect = !(request.headers.get("content-type") ?? "").includes("application/json");
  const slug = await decodeSlug(request);
  if (slug === null) return json(400, { error: "Missing or invalid 'slug'." });

  const existing = await getConversation(env.PASTES, slug);
  if (existing === null) return json(404, { error: "No such paste." });

  // [LAW:no-silent-failure] A legacy record with no captured origin has nothing
  // to replay. The /sloppy affordance is hidden for it, but a directly-crafted
  // request still fails loudly here rather than no-op'ing — the backfill child
  // (slopspot-provenance-o2q.1) is what gives these records an origin to replay.
  if (existing.origin === null) {
    return json(409, { error: "This paste has no captured origin to re-project from." });
  }

  // [LAW:single-enforcer] Same canonicalization as the create path: a replayable
  // origin regenerates its turns; an editor origin keeps them (re-projection is a
  // no-op by construction — its turns ARE the source); a corrupt origin fails
  // loudly. [LAW:no-silent-failure] On failure the stored record is left
  // untouched — re-projection is non-destructive.
  const reprojected = canonicalize(existing.turns, existing.origin);
  if (!reprojected.ok) return json(422, { error: reprojected.reason });

  // [LAW:one-source-of-truth] Replace only the derived values — the turns and the
  // title computed from them. slug, createdAt, lifetime, and the canonical origin
  // are preserved (the spread keeps origin; canonicalize returned the same one),
  // so existing links keep working and putConversation owns the TTL as always.
  const updated = {
    ...existing,
    turns: reprojected.turns,
    title: deriveTitle(reprojected.turns),
  };
  await putConversation(env.PASTES, updated);

  return wantsRedirect ? seeOther("/sloppy") : json(200, { slug: updated.slug });
};
