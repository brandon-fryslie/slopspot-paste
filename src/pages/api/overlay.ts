import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getConversation, putConversation } from "../../storage";
import { outOfRangeTarget } from "../../overlay";
import { isOverlay } from "../../types";
import { json, decodeSlug } from "../../http";

export const prerender = false;

// [LAW:one-source-of-truth] Writing an authored display-overlay is the FOURTH member of
// the getConversation -> {...existing, field} -> putConversation admin-mutation family
// (refresh/reproject/refetch). The overlay is AUTHORED source data that CANNOT be
// re-derived from the turns, so it lives ON the record and is replaced wholesale here;
// the verbatim turns/origin are never touched. Applying it is a separate, already-shipped
// concern: deriveViewableDialogue reads conversation.overlay on every render path, so once
// this endpoint persists an overlay the redaction Just Works (and is leak-proof through
// the /t<N> permalink by construction — slopspot-overlay-34a.2).
//
// [LAW:single-enforcer] Auth is not handled here: /api/overlay is in middleware's
// ADMIN_ROUTES, the one gate every admin mutation flows through. This handler owns only
// the HTTP edges and the mutation shape, exactly like reproject/refresh/refetch.
//
// [LAW:effects-at-boundaries] No network, no re-derivation: the stored turns are the
// authority; this only attaches the authored overlay that shapes their DISPLAY.

export const POST: APIRoute = async ({ request }) => {
  // [LAW:single-enforcer] decodeSlug is the ONE slug decoder (trim, blank -> null), and it
  // consumes the body — so clone FIRST for the directives, then decode the slug from the
  // original. The directives are a structured array, so this endpoint is JSON-only: a form
  // body yields no valid directives and fails loudly below.
  const bodyRequest = request.clone();
  const slug = await decodeSlug(request);
  if (slug === null) return json(400, { error: "Missing or invalid 'slug'." });

  // [LAW:types-are-the-program] The directives body is unknown JSON until isOverlay
  // classifies it. A non-array, an unknown kind, a missing target, a fractional/negative
  // index — all rejected here, so nothing downstream re-defends. [LAW:no-silent-failure]
  // a malformed body 400s rather than storing a partial or empty overlay silently.
  const body = (await bodyRequest.json().catch(() => null)) as { directives?: unknown } | null;
  const directives = body?.directives;
  if (!isOverlay(directives)) return json(400, { error: "Missing or invalid 'directives'." });

  const existing = await getConversation(env.PASTES, slug);
  if (existing === null) return json(404, { error: "No such paste." });

  // [LAW:no-silent-failure] A structurally-valid directive can still target a turn the
  // paste does not have — a redaction that would protect nothing. Reject it loudly (422)
  // rather than persist a no-op redaction and report success. An empty overlay is the
  // valid "clear all redactions" write and passes straight through.
  const missing = outOfRangeTarget(existing.turns, directives);
  if (missing !== null) {
    return json(422, {
      error: `Directive targets turn ${missing}, but this paste has no such turn.`,
    });
  }

  // [LAW:one-source-of-truth] Replace only the authored overlay; slug, createdAt,
  // lifetime, origin, and turns are preserved by the spread. putConversation owns the TTL,
  // so an overlay write keeps the paste's existing lifetime.
  await putConversation(env.PASTES, { ...existing, overlay: directives });

  return json(200, { slug: existing.slug, directives: directives.length });
};
