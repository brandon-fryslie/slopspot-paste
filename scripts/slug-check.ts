// Compare-with entry-point checks (slopspot-diff-pcd.4). Run: `tsx scripts/slug-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the PURE
// reference parser (src/slug.ts) OFF-NETWORK: parsePasteRef turns a reader-entered
// reference — a bare slug, a `/slug` path, or a full paste URL — into the SAME validated
// slug the /diff route's loader gates on [LAW:one-source-of-truth], or names the reason it
// is not one, so the client can reject a typo inline instead of round-tripping to a 404
// [LAW:no-silent-failure]. Behavioural, independent of any DOM or navigation
// [LAW:behavior-not-structure].

import { generateSlug, isValidSlug, parsePasteRef } from "../src/slug";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// A real, valid slug from the one generator — so the parser is exercised against exactly
// the shape the app mints, not a hand-typed constant that could drift from the alphabet.
const slug = generateSlug();
assert("fixture slug is valid", isValidSlug(slug));

const okSlug = (raw: string, expected: string): void => {
  const ref = parsePasteRef(raw);
  assert(`accepts ${JSON.stringify(raw)} → ${expected}`, ref.ok && ref.slug === expected);
};

const rejects = (raw: string, reason: "empty" | "malformed"): void => {
  const ref = parsePasteRef(raw);
  assert(`rejects ${JSON.stringify(raw)} as ${reason}`, !ref.ok && ref.reason === reason);
};

// A bare slug is its own last segment.
okSlug(slug, slug);
// Surrounding whitespace is trimmed before parsing.
okSlug(`  ${slug}  `, slug);
// A leading-slash path reduces to the trailing slug.
okSlug(`/${slug}`, slug);
// A full paste URL reduces to the trailing slug (the host/scheme segments are discarded).
okSlug(`https://paste.slopspot.ai/${slug}`, slug);
// A trailing slash does not defeat "last non-empty segment".
okSlug(`https://paste.slopspot.ai/${slug}/`, slug);
// Query and hash are dropped before the segment split (a shared #edit link still resolves).
okSlug(`https://paste.slopspot.ai/${slug}?ref=x`, slug);
okSlug(`https://paste.slopspot.ai/${slug}#edit`, slug);

// Empty / whitespace-only input is its own reason, distinct from a malformed reference.
rejects("", "empty");
rejects("   ", "empty");
// A too-short candidate is malformed (isValidSlug requires the full length).
rejects("abc", "malformed");
rejects(slug.slice(0, 9), "malformed");
// Excluded alphabet characters (0/O/1/I/l) are malformed even at the right length.
rejects("0000000000", "malformed");
// A URL whose last segment is not a slug is malformed, not a silent accept of the host.
rejects("https://paste.slopspot.ai/", "malformed");
rejects("https://example.com/not-a-slug", "malformed");
