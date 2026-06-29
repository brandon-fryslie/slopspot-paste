import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { parseAuto, ingestPaste, deriveTitle, canonicalize } from "../../parser";
import { decodeRequest } from "../../paste-request";
import { putConversation } from "../../storage";
import { generateSlug } from "../../slug";
import { json, seeOther } from "../../http";
import type { Conversation, ParseResult } from "../../types";
import { inputText, lifetimeFromChoice, MAX_PASTE_BYTES, MAX_PASTE_LABEL } from "../../types";

export const prerender = false;

// [LAW:single-enforcer] All validation lives at this trust boundary. The wire
// classification is decodeRequest (paste-request.ts, pure + testable); this
// handler owns the effects — size cap, parse/fetch, store. Downstream code
// (storage, render) trusts the typed PasteInput / Conversation.

// [LAW:single-enforcer] One size cap for every kind, stated once in types.ts
// (MAX_PASTE_BYTES) so the API limit and the page's advertised limit share a
// source. 8 MiB gives honest headroom for JSON-encoding overhead on long CC
// session JSONL (observed at 1.74 MB) while staying under KV's 25 MB ceiling.
const MAX_TURNS = 10000;

const sizeOf = (s: string): number => new Blob([s]).size;

export const POST: APIRoute = async ({ request }) => {
  // [LAW:dataflow-not-control-flow] The success response modality is data
  // derived from the request's content-type — the same predicate decodeRequest
  // keys on. A form-encoded POST is the no-JS <form> (a browser navigation), so
  // success redirects to the rendered paste; a JSON POST is the editor/API and
  // gets { slug }. One store path, two representations. (Error bodies stay JSON
  // for both — a no-JS error shows the readable `error` string, not a redirect.)
  const wantsRedirect = !(request.headers.get("content-type") ?? "").includes("application/json");
  const decoded = await decodeRequest(request);
  if (!decoded.ok) return json(400, { error: decoded.reason });

  // [LAW:single-enforcer] One size cap, one place. Each arm names the bytes it
  // puts at risk: the user-supplied string for input/legacy (url or content,
  // via inputText), and the serialized turns for the editor arm — those bytes
  // ARE the stored payload, since edited turns are not re-parsed. A 200 MB URL
  // or a 200 MB block list is rejected here, not in firecrawl or KV.
  const rawSize =
    "input" in decoded
      ? sizeOf(inputText(decoded.input))
      : "turns" in decoded
        ? sizeOf(JSON.stringify(decoded.turns))
        : sizeOf(decoded.legacy);
  if (rawSize === 0) return json(400, { error: "Empty paste." });
  if (rawSize > MAX_PASTE_BYTES) {
    return json(413, { error: `Paste exceeds the ${MAX_PASTE_LABEL} limit (${MAX_PASTE_BYTES} bytes).` });
  }

  // [LAW:single-enforcer] Every arm converges to one ParseResult before the
  // shared store tail. ingestPaste handles sync text parsing and async URL
  // ingestion; the editor arm runs through canonicalize, which regenerates turns
  // from a replayable origin (so the cache can't drift) and keeps the submitted
  // turns only for an `editor` origin (which has no upstream input to replay).
  // The kind discrimination stays inside the parser.
  const parsed: ParseResult =
    "input" in decoded
      ? await ingestPaste(decoded.input, env)
      : "turns" in decoded
        ? canonicalize(decoded.turns, decoded.origin)
        : parseAuto(decoded.legacy);
  if (!parsed.ok) return json(400, { error: parsed.reason });
  // [LAW:dataflow-not-control-flow] Every arm flows through the same turn-count
  // bounds. For text/URL these are no-ops (a parse always yields ≥1 turn), but
  // the editor arm can submit an empty block list — caught here as the same
  // "empty paste" condition, not a special case bolted onto one arm.
  if (parsed.turns.length === 0) return json(400, { error: "Empty paste." });
  if (parsed.turns.length > MAX_TURNS) {
    return json(413, { error: `Too many turns (max ${MAX_TURNS}).` });
  }

  const now = Date.now();
  const conversation: Conversation = {
    slug: generateSlug(),
    createdAt: now,
    lifetime: lifetimeFromChoice("expires", now),
    deletedAt: null,
    turns: parsed.turns,
    title: deriveTitle(parsed.turns),
    // [LAW:one-source-of-truth] The captured source of truth is stamped here once,
    // directly from the parse result. Styling provenance (`source`) is derived on
    // read via sourceOf — never stored as a second field that could drift.
    origin: parsed.origin,
    // Only the editor arm can supply an explicit override; text/form/legacy paths
    // always derive platform from source ([LAW:one-source-of-truth]).
    platformOverride: "turns" in decoded ? decoded.platformOverride : undefined,
  };

  await putConversation(env.PASTES, conversation);
  return wantsRedirect
    ? seeOther("/" + conversation.slug)
    : json(200, { slug: conversation.slug });
};
