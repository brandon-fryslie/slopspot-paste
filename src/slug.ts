// [LAW:one-source-of-truth] The slug IS the identity. No separate id field.
// Unguessable by virtue of length + alphabet size, in line with anonymous + write-once.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; // 57 chars (no 0/O/1/I/l)
const LENGTH = 10; // 57^10 ≈ 3.6e17 — collision-free in practice for this scale

// [LAW:types-are-the-program] A Slug is a string PROVEN to match the paste-id shape.
// The brand makes "validated" a property the type carries, not a precondition a comment
// asks callers to honor: the only way to obtain a Slug is through the three mints below
// (generate, the isValidSlug type-guard, parsePasteRef), so a function that requires a
// Slug — e.g. one that interpolates it into a URL or HTML — cannot be handed a raw,
// unvalidated string. Because Slug is a subtype of string it still flows into every
// string-typed slot (storage keys, Conversation.slug, loadViewablePaste) with no ripple;
// only the slots that DEMAND proof-of-validity tighten.
export type Slug = string & { readonly __brand: "Slug" };

export const generateSlug = (): Slug => {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  // A freshly generated id is a Slug by construction — this is one of the three mint
  // points, so the brand is asserted here where the alphabet guarantee is established.
  return out as Slug;
};

// [LAW:types-are-the-program] A type-GUARD, not a bare boolean: a true result narrows the
// input to Slug, so `if (isValidSlug(s))` both checks AND brands in one step. This is the
// second mint point — the only place a caller-supplied string earns the Slug type.
export const isValidSlug = (s: string): s is Slug =>
  s.length === LENGTH && /^[A-HJ-NP-Za-km-z2-9]+$/.test(s);

// [LAW:effects-at-boundaries] Pure: turn a reader-entered reference to a paste — a bare
// slug, a `/slug` path, or a full paste URL — into a validated slug, or the reason it is
// not one. No IO, no DOM, no navigation; the caller performs the effect (navigate) at the
// boundary. [LAW:one-source-of-truth] validity is decided by the SAME isValidSlug the
// /diff route's loader ultimately gates on, so catching a typo here rejects exactly what
// the route would 404 [LAW:no-silent-failure] — never a second, drifting notion of "valid".
export type PasteRef =
  | { readonly ok: true; readonly slug: Slug }
  | { readonly ok: false; readonly reason: "empty" | "malformed" };

export const parsePasteRef = (raw: string): PasteRef => {
  // Drop any query/hash, then take the last non-empty path segment. A bare slug is its own
  // last segment; `/slug` and `https://host/slug/` both reduce to the trailing slug — one
  // extraction over all three shapes [LAW:dataflow-not-control-flow], no "is this a URL?" branch.
  const withoutQuery = raw.trim().split(/[?#]/, 1)[0]!;
  if (withoutQuery === "") return { ok: false, reason: "empty" };
  const segments = withoutQuery.split("/").filter((s) => s !== "");
  const candidate = segments[segments.length - 1] ?? "";
  return isValidSlug(candidate)
    ? { ok: true, slug: candidate }
    : { ok: false, reason: "malformed" };
};

// [LAW:types-are-the-program] A TurnIndex is a number PROVEN to be a non-negative safe
// integer that named a canonical t<N> segment — the turn-identity analog of Slug. The only
// way to obtain one is parseTurnSegment below, so a function that frames a turn URL or looks
// a turn up by index cannot be handed a negative, NaN, Infinity, or precision-lost value: the
// brand makes "validated" a property the type carries, not a precondition a comment asks
// callers to honor. Because it is a subtype of number it still flows into every number-typed
// slot (the === in findTurn, string interpolation into a URL) with no ripple; only the slots
// that DEMAND a validated index tighten.
export type TurnIndex = number & { readonly __brand: "TurnIndex" };

// [LAW:one-source-of-truth] The canonical turn-segment grammar: the SINGLE parser of a
// "t<N>" URL segment to its turn index, the inverse of dialogue.ts's turnAnchorId produce
// side. The form is canonical — "t0", "t1", … with no leading zeros — so "t007" is not a
// silent alias for "t7". Both the single-turn card render target (turnCard.renderTurnCard)
// and the oEmbed turn-URL parser below read turn identity through THIS one grammar, so they
// cannot drift on what counts as a turn [LAW:single-enforcer]. A non-canonical segment is an
// honest absence (null) the callers surface as 404, never a coerced index. Lives here, not
// in turnCard, so slug.ts stays free of the renderer — parseEmbedRef needs this, and slug.ts
// is imported into the client Compare control, which must not pull rendering code. This is
// the one MINT of a TurnIndex — the point the non-negative-safe-integer guarantee is set.
const TURN_SEGMENT = /^t(0|[1-9]\d*)$/;
export const parseTurnSegment = (segment: string): TurnIndex | null => {
  const match = TURN_SEGMENT.exec(segment);
  if (!match) return null;
  const index = Number(match[1]);
  // [LAW:no-silent-failure] The regex has no digit-count bound, so a magnitude past the
  // safe-integer range would lose precision through Number() and then miss the === lookup in
  // findTurn — a genuine turn silently resolving as absent. The segment is external URL
  // input, so this bound belongs here at the parse boundary [LAW:no-defensive-null-guards]:
  // reject an out-of-range index as an honest non-turn (null), never a precision-lost number.
  return Number.isSafeInteger(index) ? (index as TurnIndex) : null;
};

// [LAW:types-are-the-program] An embeddable reference is EITHER a whole paste OR a single
// turn of one — the epic's two embed render targets, made the two arms of one type so a
// consumer URL resolves to exactly one, never an ambiguous both/neither. parsePasteRef
// stays the whole-paste-only parser the Compare/diff entry points use (they operate on
// whole pastes, so a turn URL is correctly NOT a paste ref there); this is the oEmbed
// endpoint's parser, which additionally recognizes the /<slug>/t<N> turn permalink.
export type EmbedRef =
  | { readonly ok: true; readonly kind: "paste"; readonly slug: Slug }
  | { readonly ok: true; readonly kind: "turn"; readonly slug: Slug; readonly index: TurnIndex }
  | { readonly ok: false; readonly reason: "empty" | "malformed" };

export const parseEmbedRef = (raw: string): EmbedRef => {
  // Same query/hash strip + segment split as parsePasteRef, then decide by POSITION: the
  // ref is a turn ONLY when the last segment is a canonical t<N> AND the segment before it
  // is a valid slug. The positional test is load-bearing — a valid slug can itself match the
  // t<N> shape (e.g. a 10-char id starting "t" with digit chars), so keying on the last
  // segment's shape alone would misread a whole-paste URL as a turn [LAW:types-are-the-program].
  // When the last segment is not a turn-with-a-slug-before-it, the last segment is the paste
  // slug candidate — identical to parsePasteRef, so /<slug>/t<N> and a bare /<slug> flow
  // through one extraction [LAW:dataflow-not-control-flow], never a "is this a turn URL?" branch.
  const withoutQuery = raw.trim().split(/[?#]/, 1)[0]!;
  if (withoutQuery === "") return { ok: false, reason: "empty" };
  const segments = withoutQuery.split("/").filter((s) => s !== "");
  const last = segments[segments.length - 1] ?? "";
  const slugBefore = segments[segments.length - 2] ?? "";
  const index = parseTurnSegment(last);
  if (index !== null && isValidSlug(slugBefore)) {
    return { ok: true, kind: "turn", slug: slugBefore, index };
  }
  return isValidSlug(last)
    ? { ok: true, kind: "paste", slug: last }
    : { ok: false, reason: "malformed" };
};
