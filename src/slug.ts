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
