// Carrying a Place across the seam between the page's utterance list and the one the narrator
// says (slopspot-turn-digest-8xc.p1n). Run: `tsx scripts/spoken-place-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about where a place LANDS — which utterance,
// which character — so a different way of holding the mapping passes unchanged.

import { pagePlace, spokenPlace } from "../src/spokenPlace";
import { withDigests, type SpokenDigests, type Utterance } from "../src/speech";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// A page of three turns: turn 0 says one thing, turn 1 two, turn 2 one. Only the shape
// matters here — where the runs begin is what the digests are placed against.
const page: ReadonlyArray<Utterance> = [
  { index: 0, anchor: "t0", origin: "page", voice: "user", text: "What does the bundler do?" },
  { index: 1, anchor: "t1", origin: "page", voice: "assistant", text: "It re-reads every file." },
  { index: 1, anchor: "t1", origin: "page", voice: "assistant", text: "That is the slow part." },
  { index: 2, anchor: "t2", origin: "page", voice: "user", text: "Thanks." },
];

const digests: SpokenDigests = new Map([[1, "The bundler re-reads every file."]]);
const spoken = withDigests(page, digests);
const plain = withDigests(page, new Map());

console.log("\nthe same page, said with a digest in it");
{
  assert("the digest is in what is said, and the page is one utterance shorter", spoken.utterances.length === page.length + 1);
  assert("the page's own words are untouched by the composition", plain.utterances.length === page.length);
}

console.log("\na place off the page, carried to where it is said");
{
  // Turn 1's first utterance is page index 1; with the digest in front of it, it is said at 2.
  assert("a word of a turn with a digest is said past it", spokenPlace(spoken, { utterance: 1, char: 7 }).utterance === 2);
  assert("and at the same character, because it is the same text", spokenPlace(spoken, { utterance: 1, char: 7 }).char === 7);
  assert("a word before any digest does not move", spokenPlace(spoken, { utterance: 0, char: 3 }).utterance === 0);
  assert("every later turn moves by the digests before it, not by one", spokenPlace(spoken, { utterance: 3, char: 0 }).utterance === 4);
  assert("with no digest said, a place is where it always was", spokenPlace(plain, { utterance: 3, char: 2 }).utterance === 3);
}

console.log("\na place being said, carried back to the page");
{
  assert("a word of a turn comes back to that turn's own utterance", pagePlace(spoken, { utterance: 2, char: 7 }).utterance === 1);
  assert("and keeps its character, so a link opens on the word it named", pagePlace(spoken, { utterance: 2, char: 7 }).char === 7);
  // The digest is said at index 1 and is the one utterance with no page words of its own.
  assert("a place INSIDE a digest comes back as the head of the turn it announced", pagePlace(spoken, { utterance: 1, char: 12 }).utterance === 1);
  assert(
    "and at its first character, never a count carried into prose it does not index",
    pagePlace(spoken, { utterance: 1, char: 12 }).char === 0,
  );
}

console.log("\nthe round trip, which is what a shared link actually is");
{
  assert(
    "every page place is said somewhere and comes back to itself",
    page.every((_, utterance) => {
      const there = spokenPlace(spoken, { utterance, char: 4 });
      const back = pagePlace(spoken, there);
      return back.utterance === utterance && back.char === 4;
    }),
  );
}

console.log("\na place from a list it was never counted in");
{
  // [LAW:no-defensive-null-guards] Not a null to absorb: the caller handed over a coordinate
  // from some other page, and every place this page can produce is inside it.
  const refused = (run: () => void): boolean => {
    try {
      run();
      return false;
    } catch (error) {
      return error instanceof RangeError;
    }
  };
  assert("a place past what is said is refused", refused(() => pagePlace(spoken, { utterance: 99, char: 0 })));
  assert("a place past the page is refused too", refused(() => spokenPlace(spoken, { utterance: 99, char: 0 })));
}

if (process.exitCode) {
  console.error("\nSpoken place checks FAILED.");
} else {
  console.log("\nAll spoken place checks passed.");
}
