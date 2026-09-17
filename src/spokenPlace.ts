// [LAW:decomposition] A Place moved between the page's utterance list and the list the
// narrator says. One sentence, no "and" hiding a second job: this module puts nothing in
// front of a turn (speech.ts withDigests), keeps nothing (keptPlace.ts) and plays nothing
// (performer.ts) — it only carries a coordinate across the one seam where two lists describe
// one page.
//
// WHY THE SEAM EXISTS AT ALL. A Place is an utterance's INDEX and a character in its text, so
// it means nothing without the list it was counted in. Listen performs the SPOKEN list, where
// a ready digest sits in front of its turn; everything kept outside the page — a resume in
// this device's storage, a word in a shared link — is counted in the PAGE's list, and it has
// to be. The page's list is derived from the stored original, so it is the same list for every
// reader, in every browser, on every visit [LAW:one-source-of-truth]. The spoken list is not:
// it holds whichever digests this device had derived at the moment it was composed, in text
// this browser's summarizer wrote, so a place counted in it would name a different word on the
// next visit and a different word again for whoever the link was sent to.
//
// [LAW:one-way-deps] Both lists are parameters and neither module knows this one exists.

import type { Place } from "./performer";
import type { SpokenPage } from "./speech";

// The place on the page, from the place being said. A place inside a DIGEST comes back as the
// head of the turn it announced: the digest stands for that turn without saying its words, so
// there is no character of it to keep, and the turn it was about is what a reader who shares
// or leaves during it means [LAW:no-silent-failure] — never a character count carried over
// into prose it does not index.
export const pagePlace = (page: SpokenPage, place: Place): Place => {
  const utterance = page.onPage[place.utterance];
  // [LAW:no-defensive-null-guards] A place outside the list it was counted in is a caller's
  // bug, said as one — the same stance keptPlace.ts takes at the same kind of edge.
  if (utterance === undefined) throw new RangeError(`spoken place: no utterance ${place.utterance} of ${page.onPage.length}`);
  return page.spoken[utterance] === place.utterance ? { utterance, char: place.char } : { utterance, char: 0 };
};

// Where a place off the page is said. Always the turn's own words — `spoken` never names a
// digest — so a link opens on the word it named rather than on the sentence about it.
export const spokenPlace = (page: SpokenPage, place: Place): Place => {
  const utterance = page.spoken[place.utterance];
  if (utterance === undefined) throw new RangeError(`page place: no utterance ${place.utterance} of ${page.spoken.length}`);
  return { utterance, char: place.char };
};
