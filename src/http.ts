// [LAW:single-enforcer] Every API route shapes its JSON response the same way,
// here, once. Both /api/paste and /api/fetch emit { ...} | { error } bodies; a
// second copy of this builder would be a second place the content-type or
// serialization could drift.
//
// [LAW:types-are-the-program] The media type is a closed union of the JSON types this
// builder emits, not bare string: json() always produces a JSON body (JSON.stringify), so
// a non-JSON content type would make the body and its declared type disagree. The union
// makes that unrepresentable — a future JSON subtype is one addition here, the single place
// the set is defined. (application/json+oembed's suffix is +oembed, not +json, so no
// `${string}+json` template captures it — the values are enumerated honestly.)
type JsonContentType = "application/json" | "application/json+oembed";

// [LAW:dataflow-not-control-flow] The JSON media subtype is a VALUE this one builder
// carries, not a second code path: it defaults to application/json (every existing
// caller is unchanged), and a caller whose body is a more specific +json document —
// the oEmbed endpoint's application/json+oembed (oEmbed §2.3.4) — passes that subtype
// so its response still flows through this single enforcer instead of a bare Response.
export const json = (
  status: number,
  body: Record<string, unknown>,
  contentType: JsonContentType = "application/json",
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
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
export const isJsonRequest = (request: Request): boolean => {
  // Parse the MEDIA TYPE, not a substring of the whole header: the media type is the
  // part before any `;` parameters. A bare `.includes("application/json")` would also
  // match a parameter value — e.g. `multipart/form-data; boundary=--application/json`
  // — and mis-route a form body into request.json(). Accept application/json or any
  // structured-suffix +json type (RFC 6839).
  const mediaType = ((request.headers.get("content-type") ?? "").split(";")[0] ?? "").trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
};

// [LAW:single-enforcer] The ONE decoder for "a slug from a JSON-or-form POST",
// shared by every endpoint that acts on a slug (refetch, summarize). A second copy
// per endpoint drifts. [LAW:no-silent-failure] a malformed body yields null (the
// caller surfaces a 400), never a silently-wrong slug.
export const decodeSlug = async (request: Request): Promise<string | null> => {
  // A blank (empty or whitespace-only) slug is not a usable slug — returning it would
  // misrepresent "no slug supplied" as a slug, bypassing the caller's `slug === null`
  // 400 guard and yielding a misleading 404 downstream. Trim, then null-out when
  // nothing remains, so the caller's "Missing or invalid slug" 400 fires with the
  // correct semantics. A real slug carries no whitespace, so trimming one is a no-op.
  const raw = isJsonRequest(request)
    ? ((await request.json().catch(() => null)) as { slug?: unknown } | null)?.slug
    : (await request.formData().catch(() => null))?.get("slug");
  const slug = typeof raw === "string" ? raw.trim() : "";
  return slug.length > 0 ? slug : null;
};
