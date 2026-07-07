import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { loadViewablePaste } from "../../loadPaste";
import { parsePasteRef } from "../../slug";
import { buildOEmbed, parseClamp } from "../../oembed";
import { json } from "../../http";

export const prerender = false;

// [LAW:decomposition] This handler owns ONLY the HTTP edges of the oEmbed protocol:
// read the consumer's ?url/&format/&maxwidth/&maxheight, resolve the paste, and shape
// the outcome into a Response. The envelope itself is pure (src/oembed.ts) and the
// viewability rule is enforced elsewhere — so this file makes no display decisions.
//
// [LAW:single-enforcer] Two invariants are reused, never re-decided here:
//   • parsePasteRef/isValidSlug (src/slug.ts) — the SAME slug identity the /diff entry
//     point uses; a foreign or malformed url is an honest 404, never a guessed slug.
//   • loadViewablePaste (src/loadPaste.ts) — the ONE gate the reader pages go through, so
//     an embed can't reveal a hidden/expired paste. Its 404/410/503 IS the endpoint status.
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);

  // [LAW:no-silent-failure] We advertise ONLY application/json+oembed in discovery, so a
  // consumer asking for xml gets a loud 501 — never faked XML that lies about the format
  // we actually serve. A missing format defaults to our json (oEmbed's default).
  // [LAW:single-enforcer] The 501 goes through the SAME json() builder as every other
  // response this handler emits (400/404 and loadViewablePaste's 410/503, plus 200), so
  // the error contract is one JSON shape [LAW:one-type-per-behavior] — not a bare Response
  // with no Content-Type that a strict consumer would find inconsistent with the rest.
  // Case-insensitive, matching how the codebase already compares media/format tokens
  // (isJsonRequest, http.ts, per RFC 7231): a consumer sending format=JSON gets JSON,
  // while xml/XML still 501s. The error echoes the raw value the consumer sent.
  const format = url.searchParams.get("format");
  if (format !== null && format.toLowerCase() !== "json") {
    return json(501, {
      error: `Unsupported oEmbed format '${format}'. This provider serves application/json+oembed only.`,
    });
  }

  const target = url.searchParams.get("url");
  if (target === null) return json(400, { error: "Missing 'url' parameter." });

  // [LAW:no-silent-failure] A url that is not one of OUR paste references is a 404, not a
  // best-effort guess — parsePasteRef reduces a bare slug, a /slug path, or a full paste
  // URL to the SAME validated slug, or names why it is not one.
  const ref = parsePasteRef(target);
  if (!ref.ok) return json(404, { error: "Not an embeddable slopspot paste URL." });

  const load = await loadViewablePaste(env.PASTES, ref.slug, Date.now());
  if (!load.ok) return json(load.status, { error: load.message });

  // Origin is absolute, from the actual request — consumers embed cross-origin and need
  // absolute iframe/provider URLs. No origin helper exists yet; this is the derivation.
  const body = buildOEmbed(load.conversation, ref.slug, url.origin, parseClamp(url.searchParams));

  // [LAW:single-enforcer] The success oEmbed document is emitted through the SAME shared
  // json() builder every API route uses — no bare Response. It carries the spec content
  // type for a JSON oEmbed response, application/json+oembed (oEmbed §2.3.3), which the
  // json() builder sets from its media-subtype argument; error responses above stay the
  // default application/json (they are API errors, not oEmbed documents). This is also
  // the type cxw.4's discovery <link> will advertise, so the two stay consistent.
  // Spread into a fresh literal so the typed OEmbedRich satisfies json()'s object contract.
  return json(200, { ...body }, "application/json+oembed");
};
