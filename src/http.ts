// [LAW:single-enforcer] Every API route shapes its JSON response the same way,
// here, once. Both /api/paste and /api/fetch emit { ...} | { error } bodies; a
// second copy of this builder would be a second place the content-type or
// serialization could drift.
export const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// [LAW:single-enforcer] Redirect responses are shaped here too. 303 See Other
// makes the browser re-request the target with GET — the correct status after a
// POST so a refresh doesn't re-submit. The no-JS <form> path uses this so a
// JS-disabled user lands on the rendered paste, not a JSON body.
export const seeOther = (location: string): Response =>
  new Response(null, { status: 303, headers: { Location: location } });

// The canonical predicate for "is this request's body JSON". Media types are
// case-insensitive (RFC 7231 §3.1.1.1), so `Application/JSON` counts — a case-sensitive
// sniff would mis-route it. This is the intended [LAW:single-enforcer] home for that
// rule: /api/summarize and /api/refetch delegate to it (both their parse branch and
// their redirect branch), so those two cannot disagree with themselves. Adoption is
// still partial — the other JSON endpoints (paste, delete, purge, reproject, augment,
// refresh, paste-request) currently inline a case-SENSITIVE check; migrating them onto
// this predicate is tracked in slopspot-http-88l. Until then this comment states the
// goal and the current reach, not a universal claim.
export const isJsonRequest = (request: Request): boolean =>
  (request.headers.get("content-type") ?? "").toLowerCase().includes("application/json");

// [LAW:single-enforcer] The ONE decoder for "a slug from a JSON-or-form POST",
// shared by every endpoint that acts on a slug (refetch, summarize). A second copy
// per endpoint drifts. [LAW:no-silent-failure] a malformed body yields null (the
// caller surfaces a 400), never a silently-wrong slug.
export const decodeSlug = async (request: Request): Promise<string | null> => {
  if (isJsonRequest(request)) {
    const body = (await request.json().catch(() => null)) as { slug?: unknown } | null;
    return body && typeof body.slug === "string" ? body.slug : null;
  }
  const form = await request.formData().catch(() => null);
  const slug = form?.get("slug");
  return typeof slug === "string" ? slug : null;
};
