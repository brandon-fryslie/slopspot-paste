// [LAW:effects-at-boundaries] The PURE wire-format decoder for POST /api/paste,
// decomposed from the effectful handler (which owns env, Firecrawl, and KV). This
// module touches no IO beyond reading the request body it was handed — it
// classifies unknown wire bytes into one tagged DecodedRequest and returns. That
// purity is what makes the trust boundary testable offline: the handler imports
// `cloudflare:workers`, so it can never load under node, but this classifier can.
// [LAW:decomposition] Decode (what shape did the caller send?) and act (parse,
// size-cap, store) are two parts at one seam — the DecodedRequest value.
import type { Origin, PasteInput, Platform, Turn } from "./types";
import { isOrigin, isPlatform, isProvider, isSourceKind, isTextArmKind, isTurns, textArmInput } from "./types";
import { isUrl } from "./parser";

// [LAW:types-are-the-program] The trust boundary classifies wire JSON into
// one of the union arms. Each arm's required field is checked against its
// kind — a url payload without `url` (or a text arm without `content`) fails
// here instead of crashing downstream. The url arm's discriminator is the
// generic "url"; a text arm's kind must be a real TextArmKind (claude-share is
// a Provider/SourceKind, never a PasteInput kind, so it is rejected here).
const isPasteInput = (v: unknown): v is PasteInput => {
  if (!v || typeof v !== "object") return false;
  const o = v as { kind?: unknown; content?: unknown; url?: unknown };
  if (o.kind === "url") return typeof o.url === "string";
  return isTextArmKind(o.kind) && typeof o.content === "string";
};

// [LAW:single-enforcer] / epic intent ("if anyone posts a link, assume it is a
// conversation and process it"). The ONE rule that lifts a bare pasted link to
// the fetch arm, applied at EVERY content-bearing ingress — not just the JS
// editor's detectSources. A no-JS <form> user, a legacy/external API caller, or a
// structured text-arm payload that is actually a single http(s) URL all route to
// the url arm here, so the link is fetched + parsed into turns through ingestPaste
// rather than rendered as a one-message raw bubble of the link text. Only a
// single-line URL qualifies — isUrl rejects multi-line input — so a real
// transcript that merely begins with a link is untouched. Returns null when the
// content is not a bare link, leaving the caller's declared arm intact.
const urlArm = (content: string): PasteInput | null => (isUrl(content) ? { kind: "url", url: content } : null);

// [LAW:dataflow-not-control-flow] One decode path returns one tagged value.
// Downstream branches on the tag, never on "did the request have a source
// field?" scattered across the handler.
export type DecodedRequest =
  | { ok: true; input: PasteInput }
  | { ok: true; turns: ReadonlyArray<Turn>; origin: Origin; platformOverride?: Platform }
  | { ok: true; legacy: string }
  | { ok: false; reason: string };

export const decodeRequest = async (request: Request): Promise<DecodedRequest> => {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as
      | { source?: unknown; content?: unknown; turns?: unknown; origin?: unknown; platformOverride?: unknown }
      | null;
    // [LAW:single-enforcer] The editor arm: a pre-parsed Turn[] plus the Origin
    // the editor chose to stamp, validated here at the one boundary. isTurns and
    // isOrigin reject every illegal shape so downstream trusts the typed values.
    // The editor sends a replayable url origin for a pristine fetched import (its
    // turns are canonicalized downstream) or an `editor` origin otherwise (its
    // turns ARE the source). A missing or junk origin reads as editor-with-
    // no-provenance — the same leniency a bare {turns} POST always had — never a
    // guess about where the turns came from.
    if (body && isTurns(body.turns)) {
      const origin: Origin = isOrigin(body.origin)
        ? body.origin
        : { kind: "editor", source: null };
      const platformOverride = isPlatform(body.platformOverride) ? body.platformOverride : undefined;
      return { ok: true, turns: body.turns, origin, platformOverride };
    }
    // A structured PasteInput whose text arm carries a bare link is itself a link
    // to fetch — urlArm reclassifies it; otherwise the declared arm stands.
    if (body && isPasteInput(body.source)) {
      const src = body.source;
      const link = src.kind === "url" ? null : urlArm(src.content);
      return { ok: true, input: link ?? src };
    }
    if (body && typeof body.content === "string") {
      const link = urlArm(body.content);
      return link ? { ok: true, input: link } : { ok: true, legacy: body.content };
    }
    return { ok: false, reason: "Missing 'turns', 'source' or 'content' field." };
  }
  const form = await request.formData().catch(() => null);
  const kind = form?.get("source");
  // The form encoding only carries text arms in its dropdown; URL arms are
  // JSON-only in the editor. The `<form action="/api/paste">` fallback exists for
  // users with JS disabled or external clients — and a bare link pasted into it is
  // still fetched (urlArm below), honoring "any posted link is a conversation"
  // even with no JS.
  const content = form?.get("content");
  if (typeof content !== "string") {
    return { ok: false, reason: "Missing 'content' field." };
  }
  // Any bare link routes to the fetch arm BEFORE the text-kind logic, so a no-JS
  // user pasting a single URL gets a fetched conversation regardless of the
  // selected format (and even bypasses the provider guard below, which only needs
  // to fire for a provider name carrying non-URL text).
  const link = urlArm(content);
  if (link) return { ok: true, input: link };
  // No recognized source kind → legacy path (direct API callers without a
  // source field). Checking this first lets the provider guard below narrow
  // kind to a text arm, so textArmInput is built without a cast.
  if (!isSourceKind(kind)) {
    return { ok: true, legacy: content };
  }
  // [LAW:no-silent-failure] A Provider source (claude-share, …) is a fetch arm:
  // it is fulfilled by a URL, not by a format name carrying non-URL text. A bare
  // link was already routed to the url arm above, so reaching here with a Provider
  // kind means the caller named a provider but supplied text the form path cannot
  // fetch — fail loudly instead of silently re-routing to parseAuto, which would
  // render the text as a raw bubble. [LAW:single-enforcer]/[LAW:no-mode-explosion]
  // Gating on isProvider (the predicate, not a literal) keeps this provider-
  // agnostic: a new entry in PROVIDERS needs no edit here, and the narrowing leaves
  // kind a TextArmKind so textArmInput typechecks without a cast.
  if (isProvider(kind)) {
    return {
      ok: false,
      reason: "That's a provider name, not a conversation — paste the share URL itself and we'll fetch it.",
    };
  }
  return { ok: true, input: textArmInput(kind, content) };
};
