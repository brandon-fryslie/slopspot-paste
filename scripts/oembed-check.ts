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
import { generateSlug, parseEmbedRef, parseTurnSegment } from "../src/slug";
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

// A real Slug from the one generator — buildOEmbed REQUIRES a Slug (a string proven to
// match the paste-id shape), so a hand-typed constant would not typecheck. This exercises
// the builder against exactly the branded value the app mints [LAW:types-are-the-program].
const SLUG = generateSlug();
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

// ── AMPERSAND: a literal & becomes &amp; (escaped FIRST, so entities are never double-escaped) ──
{
  const ampersand = conv({ turns, title: "Rock & Roll" });
  const body = buildOEmbed(ampersand, SLUG, ORIGIN, noBound);
  // A raw & in an attribute starts an ambiguous entity reference; escapeAttr converts it.
  // Dropping the & replace would leave `Rock & Roll` here and this assertion would catch it.
  assert("literal & in the title is escaped to &amp; in the attribute", body.html.includes('title="Rock &amp; Roll"'));
  assert("no raw ampersand remains in the html attribute", !body.html.includes("Rock & Roll"));
}

// ── TURN FRAME (cxw.5): a turn index frames the /embed/<slug>/t<N> render target, not the whole paste ──
{
  // [LAW:types-are-the-program] Mint the index through parseTurnSegment — buildOEmbed REQUIRES
  // a branded TurnIndex (a non-negative safe integer), so a raw `1` would not typecheck. This
  // exercises the builder against exactly the branded value the app produces, exactly as SLUG
  // above is minted through generateSlug rather than a hand-typed constant.
  const t1 = parseTurnSegment("t1");
  if (t1 === null) throw new Error("fixture: 't1' must parse to a TurnIndex");
  const whole = buildOEmbed(conv({ turns, title: "My chat" }), SLUG, ORIGIN, noBound);
  const turnCard = buildOEmbed(conv({ turns, title: "My chat" }), SLUG, ORIGIN, noBound, t1);

  assert("turn frame iframes /embed/<slug>/t<N> on the absolute origin", turnCard.html.includes(`src="${ORIGIN}/embed/${SLUG}/t1"`));
  assert("turn frame does NOT iframe the whole-paste render target", !turnCard.html.includes(`src="${ORIGIN}/embed/${SLUG}"`));
  assert("whole-paste frame (no index) is unchanged — still /embed/<slug>", whole.html.includes(`src="${ORIGIN}/embed/${SLUG}"`));
  // The turn card is otherwise the SAME rich envelope — same type/title/dimensions, only the frame path differs.
  assert("turn frame is still a rich oEmbed with the paste title", turnCard.type === "rich" && turnCard.title === "My chat");
  assert("turn frame carries the design dimensions", turnCard.width === EMBED_DEFAULT_WIDTH && turnCard.height === EMBED_DEFAULT_HEIGHT);
}

// ── EMBED REF PARSING (cxw.5): a consumer URL resolves to exactly one of {paste, turn} ──
{
  const bare = parseEmbedRef(String(SLUG));
  assert("a bare slug is a whole-paste ref", bare.ok && bare.kind === "paste" && bare.slug === SLUG);

  const pastePath = parseEmbedRef(`${ORIGIN}/${SLUG}`);
  assert("a /<slug> URL is a whole-paste ref", pastePath.ok && pastePath.kind === "paste" && pastePath.slug === SLUG);

  const turnPath = parseEmbedRef(`${ORIGIN}/${SLUG}/t3`);
  assert("a /<slug>/t<N> URL is a turn ref carrying the slug and index", turnPath.ok && turnPath.kind === "turn" && turnPath.slug === SLUG && turnPath.index === 3);

  const turnZero = parseEmbedRef(`${ORIGIN}/${SLUG}/t0`);
  assert("t0 is a canonical turn ref (index 0)", turnZero.ok && turnZero.kind === "turn" && turnZero.index === 0);

  // A t<N> with NO valid slug before it is NOT a turn ref — the last segment falls through to
  // the slug candidate, which is not valid here, so the whole thing is malformed (never a
  // turn with a bogus slug, never a silent success) [LAW:no-silent-failure].
  const orphanTurn = parseEmbedRef("/t3");
  assert("a t<N> with no slug before it is malformed, not a turn", !orphanTurn.ok && orphanTurn.reason === "malformed");

  // Leading-zero / non-canonical turn segments are not turns; the segment is then a slug
  // candidate, and "t007" is not a valid slug, so the ref is malformed.
  const nonCanonical = parseEmbedRef(`${ORIGIN}/${SLUG}/t007`);
  assert("a non-canonical turn segment (t007) is not a turn ref", !(nonCanonical.ok && nonCanonical.kind === "turn"));

  const empty = parseEmbedRef("");
  assert("an empty reference is empty, not malformed", !empty.ok && empty.reason === "empty");

  const foreign = parseEmbedRef("https://example.com/not-a-paste");
  assert("a foreign URL is malformed", !foreign.ok && foreign.reason === "malformed");

  // An out-of-safe-range turn segment is not a turn (parseTurnSegment rejects it), so the
  // last segment falls through to the slug candidate — a 17-char non-slug — and the ref is
  // malformed, never a turn carrying a precision-lost index [LAW:no-silent-failure].
  const hugeTurn = parseEmbedRef(`${ORIGIN}/${SLUG}/t9007199254740993`);
  assert("an out-of-safe-range turn segment is not a turn ref", !(hugeTurn.ok && hugeTurn.kind === "turn"));
}

// ── PARSE TURN SEGMENT (cxw.5): the ONE t<N> grammar, non-negative safe integer or null ──
{
  assert("parseTurnSegment accepts a normal index", parseTurnSegment("t5") === 5);
  assert("parseTurnSegment accepts t0 (index 0)", parseTurnSegment("t0") === 0);
  assert("parseTurnSegment rejects a leading-zero segment (t007)", parseTurnSegment("t007") === null);
  assert("parseTurnSegment rejects a non-turn segment", parseTurnSegment("abc") === null);
  assert("parseTurnSegment rejects the empty string", parseTurnSegment("") === null);
  // The precision trap: Number("t9007199254740993"[1:]) === 9007199254740992, a silent
  // ===-miss in findTurn. isSafeInteger at the parse boundary rejects it as an honest non-turn.
  assert("parseTurnSegment rejects a magnitude past the safe-integer range", parseTurnSegment("t9007199254740993") === null);
  assert("parseTurnSegment accepts the largest safe index", parseTurnSegment(`t${Number.MAX_SAFE_INTEGER}`) === Number.MAX_SAFE_INTEGER);
}
