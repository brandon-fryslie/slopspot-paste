import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getConversation, putConversation } from "../../storage";
import { json, seeOther } from "../../http";
import { LIFETIME_CHOICES, lifetimeFromChoice } from "../../types";
import type { LifetimeChoice } from "../../types";

export const prerender = false;

// [LAW:effects-at-boundaries] Mutating a paste's lifetime is a server effect, so
// it lives behind a POST endpoint, not inline in the /sloppy render. The page
// computes nothing about expiry; it posts a (slug, choice) here and this route
// re-states the record through the single storage enforcer.
//
// [LAW:single-enforcer] There is no new expiry path here: the route reads the
// record, replaces its lifetime via lifetimeFromChoice, and re-puts. putConversation
// alone decides KV's TTL from that lifetime (expires → reset TTL, pinned → none).

const isLifetimeChoice = (v: unknown): v is LifetimeChoice =>
  typeof v === "string" && (LIFETIME_CHOICES as ReadonlyArray<string>).includes(v);

// [LAW:dataflow-not-control-flow] One decode path keyed on content-type, mirroring
// /api/paste: a JSON fetch from the admin script, or a no-JS <form> POST. Both
// converge to one (slug, choice) value the handler acts on.
type RefreshRequest = { readonly slug: string; readonly choice: LifetimeChoice };

const decodeRequest = async (request: Request): Promise<RefreshRequest | null> => {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as
      | { slug?: unknown; choice?: unknown }
      | null;
    if (body && typeof body.slug === "string" && isLifetimeChoice(body.choice)) {
      return { slug: body.slug, choice: body.choice };
    }
    return null;
  }
  const form = await request.formData().catch(() => null);
  const slug = form?.get("slug");
  const choice = form?.get("choice");
  if (typeof slug === "string" && isLifetimeChoice(choice)) {
    return { slug, choice };
  }
  return null;
};

export const POST: APIRoute = async ({ request }) => {
  // [LAW:dataflow-not-control-flow] Response modality is derived from the request
  // shape, same key decodeRequest uses: a no-JS <form> POST navigates back to the
  // admin view; a JSON fetch gets { slug }. One mutation, two representations.
  const wantsRedirect = !(request.headers.get("content-type") ?? "").includes("application/json");
  const decoded = await decodeRequest(request);
  if (decoded === null) {
    return json(400, { error: "Missing or invalid 'slug'/'choice'." });
  }

  const existing = await getConversation(env.PASTES, decoded.slug);
  if (existing === null) {
    return json(404, { error: "No such paste." });
  }

  // [LAW:one-source-of-truth] The pinned/expires state lives on the record. We
  // re-state only the lifetime and keep every other field, so the admin listing
  // (which derives straight from these records) reflects the change on reload.
  const updated = { ...existing, lifetime: lifetimeFromChoice(decoded.choice, Date.now()) };
  await putConversation(env.PASTES, updated);

  return wantsRedirect ? seeOther("/sloppy") : json(200, { slug: updated.slug });
};
