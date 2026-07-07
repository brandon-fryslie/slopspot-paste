import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { loadViewablePaste } from "../../loadPaste";
import { parseEmbedRef } from "../../slug";
import { deriveViewableDialogue } from "../../overlay";
import { findTurn } from "../../turnCard";
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
  // best-effort guess — parseEmbedRef reduces a bare slug, a /slug path, or a full paste
  // URL to the SAME validated slug, and additionally recognizes a /<slug>/t<N> turn
  // permalink as a turn ref, or names why it is neither.
  const ref = parseEmbedRef(target);
  if (!ref.ok) return json(404, { error: "Not an embeddable slopspot paste URL." });

  const load = await loadViewablePaste(env.PASTES, ref.slug, Date.now());
  if (!load.ok) return json(load.status, { error: load.message });

  // [LAW:no-silent-failure][LAW:single-enforcer] A turn ref must name a turn that actually
  // renders — resolved through the SAME findTurn the /embed/<slug>/t<N> render target uses,
  // so a /<slug>/t999 that would 404 as a card is a 404 here too, never a 200 whose iframe
  // frames a dead turn. The whole-paste ref is already validated by loadViewablePaste above;
  // this is the turn's equivalent gate.
  if (ref.kind === "turn" && findTurn(deriveViewableDialogue(load.conversation), ref.index) === null) {
    return json(404, { error: "That turn does not exist in this paste." });
  }

  // Origin is absolute, from the actual request — consumers embed cross-origin and need
  // absolute iframe/provider URLs. No origin helper exists yet; this is the derivation.
  // [LAW:dataflow-not-control-flow] which render target is framed rides one value: the turn
  // index for a turn ref, null for the whole paste.
  const turnIndex = ref.kind === "turn" ? ref.index : null;
  const body = buildOEmbed(load.conversation, ref.slug, url.origin, parseClamp(url.searchParams), turnIndex);

  // [LAW:single-enforcer] The success oEmbed document is emitted through the SAME shared
  // json() builder every API route uses — no bare Response — carrying the +oembed media
  // subtype (application/json+oembed) that marks a JSON oEmbed document, and that cxw.4's
  // discovery <link> will advertise, so endpoint and discovery stay consistent.
  //
  // Deliberate, spec-grounded split: the error responses above stay the default
  // application/json. oEmbed signals errors by HTTP STATUS (404 not-found, 501 unimplemented
  // format — §2.3.4), defining no error *document*, so our {error} body is this API's own
  // convention, NOT an oEmbed document. Labeling it application/json+oembed would claim it
  // is one [FRAMING:representation]; application/json tells the truth, and a strict consumer
  // keys on the status code, not the error body's media type. So +oembed marks exactly the
  // thing that IS an oEmbed document: this 200.
  //
  // Spread into a fresh literal so the typed OEmbedRich satisfies json()'s object contract.
  return json(200, { ...body }, "application/json+oembed");
};
