// oEmbed envelope checks (slopspot-embed-cxw.3). Run: `tsx scripts/oembed-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the PURE
// oEmbed builder (src/oembed.ts) OFF-NETWORK: the rich response carries every REQUIRED
// field of the oembed.com spec (type + version:'1.0'; rich REQUIRES html, width, height),
// frames the shipped /embed/<slug> render target on the absolute origin, projects the
// SAME title/author_name derivePasteMeta shows [LAW:one-source-of-truth], respects the
// consumer's maxwidth/maxheight bounds, and escapes an untrusted title into the iframe
// attribute [LAW:no-silent-failure]. Behavioural, independent of any Worker or KV.

import { buildOEmbed, parseClamp, EMBED_DEFAULT_WIDTH, EMBED_DEFAULT_HEIGHT } from "../src/oembed";
import type { Conversation, Turn } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// A minimal live Conversation — pinned, never-deleted. `turns` is required; title/origin/
// platformOverride default to the un-provenanced legacy shape (a "generic" platform, whose
// PLATFORM_LABEL is null), overridable per fixture.
const conv = (fields: Partial<Conversation> & { turns: ReadonlyArray<Turn> }): Conversation => ({
  slug: "abcdefghjk",
  createdAt: 0,
  lifetime: { kind: "pinned" },
  deletedAt: null,
  title: null,
  origin: null,
  ...fields,
});

const turns: ReadonlyArray<Turn> = [
  { kind: "message", role: "user", content: "Hello" },
  { kind: "message", role: "assistant", content: "Hi there" },
];

const SLUG = "abcdefghjk";
const ORIGIN = "https://paste.slopspot.ai";
const noBound = parseClamp(new URLSearchParams());

// ── THE GOLDEN SHAPE: every oEmbed rich required field is present and correctly typed ──
{
  const provenanced = conv({ turns, title: "My chat", platformOverride: "claude-web" });
  const body = buildOEmbed(provenanced, SLUG, ORIGIN, noBound);

  assert("type is the literal 'rich'", body.type === "rich");
  assert("version is the string '1.0' (spec: MUST)", body.version === "1.0");
  assert("html is a non-empty string (rich: REQUIRED)", typeof body.html === "string" && body.html.length > 0);
  assert("width is a number (rich: REQUIRED)", typeof body.width === "number");
  assert("height is a number (rich: REQUIRED)", typeof body.height === "number");
  assert("provider_name identifies slopspot", body.provider_name === "slopspot paste");
  assert("provider_url is the absolute origin", body.provider_url === ORIGIN);
  assert("title is the paste title projection", body.title === "My chat");
  assert("author_name is the platform label when provenance exists", body.author_name === "Claude");

  // The html frames the SHIPPED render target at the absolute origin, not a raw render.
  assert(
    "html iframes /embed/<slug> on the absolute origin",
    body.html.includes(`src="${ORIGIN}/embed/${SLUG}"`),
  );
  assert("html carries the advertised width/height", body.html.includes(`width="${body.width}"`) && body.html.includes(`height="${body.height}"`));
  assert("html frame is borderless + lazy", body.html.includes('style="border:0"') && body.html.includes('loading="lazy"'));

  // The whole body must survive a round-trip through JSON.stringify (the response is JSON).
  const roundTrip = JSON.parse(JSON.stringify(body));
  assert("serializes to JSON and back with type intact", roundTrip.type === "rich" && roundTrip.version === "1.0");
}

// ── DEFAULT SIZE: with no consumer bound, the advertised size is the design default ────
{
  const body = buildOEmbed(conv({ turns }), SLUG, ORIGIN, noBound);
  assert("default width is the design width", body.width === EMBED_DEFAULT_WIDTH);
  assert("default height is the design height", body.height === EMBED_DEFAULT_HEIGHT);
}

// ── GENERIC PASTE: absence of provenance is absence of author_name, never a null field ──
{
  const body = buildOEmbed(conv({ turns }), SLUG, ORIGIN, noBound);
  assert("generic paste omits author_name entirely", !("author_name" in body));
  assert("generic paste still carries a title (the default)", typeof body.title === "string" && body.title.length > 0);
}

// ── CLAMP: a smaller maxwidth/maxheight bounds the advertised size DOWN; a larger one is ignored ──
{
  const clamped = buildOEmbed(conv({ turns }), SLUG, ORIGIN, parseClamp(new URLSearchParams("maxwidth=300&maxheight=200")));
  assert("maxwidth below default clamps width down", clamped.width === 300);
  assert("maxheight below default clamps height down", clamped.height === 200);
  assert("clamped html carries the clamped dimensions", clamped.html.includes('width="300"') && clamped.html.includes('height="200"'));

  const larger = buildOEmbed(conv({ turns }), SLUG, ORIGIN, parseClamp(new URLSearchParams("maxwidth=9999")));
  assert("maxwidth above default does NOT enlarge past the design width", larger.width === EMBED_DEFAULT_WIDTH);

  const junk = buildOEmbed(conv({ turns }), SLUG, ORIGIN, parseClamp(new URLSearchParams("maxwidth=abc&maxheight=-5")));
  assert("non-integer/non-positive bounds are leniently ignored (default used)", junk.width === EMBED_DEFAULT_WIDTH && junk.height === EMBED_DEFAULT_HEIGHT);
}

// ── ESCAPING: an untrusted title cannot break out of the iframe title attribute ─────────
{
  const hostile = conv({ turns, title: `x"><script>alert(1)</script>` });
  const body = buildOEmbed(hostile, SLUG, ORIGIN, noBound);
  assert("raw double-quote does not appear in the title attribute", !body.html.includes('title="x">'));
  assert("angle brackets in the title are entity-escaped", body.html.includes("&lt;script&gt;"));
  assert("the escaped quote is an entity", body.html.includes("&quot;"));
  // The unescaped title still projects into the JSON title field (JSON escaping handles it there).
  assert("the JSON title field is the raw title (unescaped)", body.title === `x"><script>alert(1)</script>`);
}
