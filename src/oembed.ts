// [LAW:effects-at-boundaries] The PURE oEmbed envelope, off-network. This module owns
// the protocol shape — the rich response body and the consumer-supplied clamp params —
// with no IO: the Astro handler (pages/api/oembed.ts) performs the effects (read the KV
// paste through loadViewablePaste, emit the Response) and hands the resolved conversation
// here. So the golden-shape assertion (scripts/oembed-check.ts) can drive this builder
// directly with an in-memory Conversation, never a Worker.
//
// [LAW:one-source-of-truth] This mints NO new render and NO new display metadata. The
// rich `html` is an <iframe> at the ALREADY-shipped /embed/<slug> render target (the
// self-contained, frameable SSR page — oEmbed rich html is dropped into a foreign host
// document, so it CANNOT be raw conversation HTML that silently depends on our CSS; every
// rich provider frames a self-contained render on its own origin). title + author_name
// come from derivePasteMeta, the SAME projection the reader routes show — not re-derived.

import type { Conversation } from "./types";
import { derivePasteMeta } from "./types";

// The advertised frame size when the consumer imposes no bound. A conversation card is
// portrait — taller than wide — so the reader sees several turns before scrolling the frame.
export const EMBED_DEFAULT_WIDTH = 600;
export const EMBED_DEFAULT_HEIGHT = 480;

// [LAW:one-source-of-truth] The provider identity oEmbed consumers show as the source.
// provider_url is the request origin (filled at the boundary), not hardcoded, so a
// preview/prod/localhost host advertises itself, never a wrong absolute origin.
export const OEMBED_PROVIDER_NAME = "slopspot paste";

// [LAW:no-mode-explosion] maxwidth/maxheight are consumer-supplied bounds, each an
// optional positive integer or absent — modelled as a value (a number or null), never a
// mode. Absence and a malformed/non-positive value both mean "no bound": oEmbed treats
// these as advisory hints, so a junk maxwidth is leniently ignored (default used), not a
// 400 — the consumer still gets a usable card.
export interface OEmbedClamp {
  readonly maxwidth: number | null;
  readonly maxheight: number | null;
}

// The oEmbed `rich` response (oembed.com §2.3.4). type + version are the base required
// fields (version MUST be the string "1.0"); rich additionally REQUIRES html, width,
// height. author_name is optional and present ONLY when the paste carries provenance —
// a generic paste has no platform label, so absence of provenance is absence of the
// field, never a fabricated or null author. [LAW:types-are-the-program] the literal
// types on type/version make an out-of-spec envelope unrepresentable.
export interface OEmbedRich {
  readonly type: "rich";
  readonly version: "1.0";
  readonly provider_name: string;
  readonly provider_url: string;
  readonly title: string;
  readonly author_name?: string;
  readonly html: string;
  readonly width: number;
  readonly height: number;
}

// [LAW:dataflow-not-control-flow] A single query param → its bound value. A missing param,
// a non-numeric value, and a non-positive value all fold to null (no bound) — one lenient
// extraction, not a cascade of guards. parseInt("600px") is deliberately NOT used; the
// value must be a clean integer, so a stray-suffix value is treated as absent, not half-read.
const boundOf = (raw: string | null): number | null => {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const parseClamp = (params: URLSearchParams): OEmbedClamp => ({
  maxwidth: boundOf(params.get("maxwidth")),
  maxheight: boundOf(params.get("maxheight")),
});

// Clamp one advertised dimension DOWN to a consumer bound. A bound larger than the
// default (or absent) leaves the default — we never advertise a card BIGGER than our
// design size just because the consumer allows it.
const clampDim = (base: number, bound: number | null): number =>
  bound !== null && bound < base ? bound : base;

// Escape a value for an HTML double-quoted attribute. The paste title is user-controlled
// and lands in the iframe's `title="…"` attribute inside html that a foreign host drops
// into its own document — so an unescaped `"` or `<` would break out of the attribute or
// the tag. [LAW:no-silent-failure] the untrusted value is neutralized at the seam, not
// trusted because it "came from us". & first, so we never double-escape our own entities.
const escapeAttr = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// [LAW:effects-at-boundaries] Pure: (resolved paste, its slug, the absolute request
// origin, the consumer's bounds) → the rich oEmbed body. No IO; the caller resolved the
// paste through the single viewability gate and passes the origin from new URL(request.url).
export const buildOEmbed = (
  conversation: Conversation,
  slug: string,
  origin: string,
  clamp: OEmbedClamp,
): OEmbedRich => {
  const { title, platformLabel } = derivePasteMeta(conversation);
  const width = clampDim(EMBED_DEFAULT_WIDTH, clamp.maxwidth);
  const height = clampDim(EMBED_DEFAULT_HEIGHT, clamp.maxheight);

  // The rich html frames the shipped /embed/<slug> render target on OUR absolute origin —
  // self-contained, so it carries its own CSS into the host page. slug is already validated
  // (isValidSlug: our alphabet only) so it is safe in the URL; title is user-controlled and
  // escaped for the attribute context.
  const html =
    `<iframe src="${origin}/embed/${slug}" width="${width}" height="${height}" ` +
    `style="border:0" loading="lazy" title="${escapeAttr(title)}"></iframe>`;

  return {
    type: "rich",
    version: "1.0",
    provider_name: OEMBED_PROVIDER_NAME,
    provider_url: origin,
    title,
    // [LAW:dataflow-not-control-flow] author_name is a value the envelope carries only
    // when provenance exists — the generic paste's null label omits the field entirely.
    ...(platformLabel !== null ? { author_name: platformLabel } : {}),
    html,
    width,
    height,
  };
};
