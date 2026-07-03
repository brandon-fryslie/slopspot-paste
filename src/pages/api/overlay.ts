import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getConversation, putConversation } from "../../storage";
import { outOfRangeTarget, describeTargetFault, spanPiecesByTurn, editSpine } from "../../overlay";
import { renderDialogueHtml } from "../../renderDialogue";
import { isOverlay } from "../../types";
import { json, decodeSlug } from "../../http";

export const prerender = false;

// [LAW:single-enforcer] Reading the authored overlay rides the SAME admin gate as writing
// it — /api/overlay is in middleware's ADMIN_ROUTES, so a 401 here is the one honest signal
// "you are not the owner". The paste page's authoring UI uses that: it GETs this before
// revealing any authoring chrome, so the reveal is gated by the existing enforcer, not a
// second per-paste scheme. The response is also the authoring editor's prefill — the stored
// overlay is the ONE source the editor loads its current directive set from, never
// re-derived from the redacted DOM (a hidden turn shows only "[redacted]" there, by design).
//
// [LAW:one-source-of-truth] The response also carries `pieces` — each turn's raw prose
// pieces (spanPiecesByTurn) — the leak-proof coordinate space the SPAN-authoring UI selects
// into. It is the exact string applyOverlay slices, sourced here (owner-gated) rather than
// remapped from the markdown-rendered / redacted DOM, so a captured offset cannot silently
// mis-map and miss a secret [LAW:no-silent-failure]. This route is admin-gated, so the raw
// prose reaches only the owner (of their own already-public paste), never a reader.
//
// [LAW:one-source-of-truth] It also carries `spineHtml` — the UNFILTERED authoring spine
// (editSpine → every turn, no overlay applied) rendered through the ONE renderer. A FEATURE
// overlay OMITS non-featured turns from the public render, so the #edit editor must swap this
// in to make every turn selectable (else a feature paste hides the turns the owner must
// whitelist). Owner-gated here for the same reason as `pieces`: rendering the unfiltered spine
// into the public page would leak the turns a feature overlay hides.
export const GET: APIRoute = async ({ url }) => {
  const raw = url.searchParams.get("slug");
  const slug = (raw ?? "").trim();
  if (slug.length === 0) return json(400, { error: "Missing or invalid 'slug'." });

  const existing = await getConversation(env.PASTES, slug);
  if (existing === null) return json(404, { error: "No such paste." });

  // [LAW:one-source-of-truth] getConversation normalizes the stored overlay on read
  // (storage.normalizeOverlay), so what we return here is exactly what render applies —
  // the editor and the public render read the same directives. `pieces` is derived from the
  // same stored turns the renderer projects, so its offsets are the renderer's offsets.
  return json(200, {
    slug: existing.slug,
    directives: existing.overlay ?? [],
    pieces: spanPiecesByTurn(existing.turns),
    spineHtml: renderDialogueHtml(editSpine(existing.turns)),
  });
};

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

  // [LAW:no-silent-failure] A structurally-valid directive can still target a turn, prose
  // piece, or character range this paste does not have — a redaction that would protect
  // nothing. Reject it loudly (422) with the fault's own reason rather than persist a no-op
  // redaction and report success. An empty overlay is the valid "clear all redactions"
  // write and passes straight through.
  const fault = outOfRangeTarget(existing.turns, directives);
  if (fault !== null) {
    return json(422, { error: describeTargetFault(fault) });
  }

  // [LAW:one-source-of-truth] Replace only the authored overlay; slug, createdAt,
  // lifetime, origin, and turns are preserved by the spread. putConversation owns the TTL,
  // so an overlay write keeps the paste's existing lifetime.
  await putConversation(env.PASTES, { ...existing, overlay: directives });

  return json(200, { slug: existing.slug, directives: directives.length });
};
