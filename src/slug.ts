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
