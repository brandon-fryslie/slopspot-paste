// [LAW:one-source-of-truth] The slug IS the identity. No separate id field.
// Unguessable by virtue of length + alphabet size, in line with anonymous + write-once.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"; // 57 chars (no 0/O/1/I/l)
const LENGTH = 10; // 57^10 ≈ 3.6e17 — collision-free in practice for this scale

export const generateSlug = (): string => {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
};

export const isValidSlug = (s: string): boolean =>
  s.length === LENGTH && /^[A-HJ-NP-Za-km-z2-9]+$/.test(s);

// [LAW:effects-at-boundaries] Pure: turn a reader-entered reference to a paste — a bare
// slug, a `/slug` path, or a full paste URL — into a validated slug, or the reason it is
// not one. No IO, no DOM, no navigation; the caller performs the effect (navigate) at the
// boundary. [LAW:one-source-of-truth] validity is decided by the SAME isValidSlug the
// /diff route's loader ultimately gates on, so catching a typo here rejects exactly what
// the route would 404 [LAW:no-silent-failure] — never a second, drifting notion of "valid".
export type PasteRef =
  | { readonly ok: true; readonly slug: string }
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
