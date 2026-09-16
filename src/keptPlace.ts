// [LAW:decomposition] A place kept outside the page: in the device's storage, where a
// listen is resumed from, and in a link's fragment, where a shared one opens. One sentence,
// no "and" hiding a second job: this module writes a Place as a string and reads one back
// only while it still names the text it named. It plays nothing, paints nothing and holds
// no panel state; the panel (listenPanel.ts) reads and writes through the edges the page
// wires here, and the page reads a link's fragment through `linked`.
//
// ONE VALUE, TWO HOMES [LAW:one-type-per-behavior]. The saved position and the linked
// position are one Mark — the Place a tap on a word produces and a seek accepts — written
// the one way, `formatKept`, and read the one way, `resolveKept`. Neither carries a unit
// index or a time: a time addresses no text until the audio before it exists, and moves
// with the voice, while a Place names a character of the page's own text.
//
// WHAT A KEPT PLACE CHECKS [LAW:no-silent-failure]. A Place is an utterance's index and a
// character in its text, so it goes on naming the same word exactly while the utterance at
// that index is the same utterance. The kept form carries that utterance's PRINT — a short
// hash of its anchor and its text, computed where the page is rendered — and is resolved
// only against a page whose utterance at that index has the same print. An edit that
// changes the words, a speech rule that re-derives them, or an overlay that removes a turn
// before it gives a different print, and the kept place names nothing: no resume offer,
// and a link that says its moment has gone, rather than a voice that starts in the wrong
// sentence. A change anywhere else on the page leaves it standing. A new voice is not a
// change here at all: it reads the same word, so a place kept in one voice resumes in the
// next. Cost, stated once: eight hex characters are 32 bits, so one edit in four billion
// would keep a print it should have lost.

import { contentHash } from "./contentHash";
import type { Place } from "./performer";
import type { PreferenceStore } from "./preferenceStore";
import type { Utterance } from "./speech";
import { wordSpans } from "./speechManifest";

// ── the print ───────────────────────────────────────────────────────────────────────

export const PRINT_LENGTH = 8;

// [LAW:one-source-of-truth] The one print of an utterance: the anchor that places it on the
// page and the text a Place's character indexes, through the one content hash.
export const printOf = async (utterance: Utterance): Promise<string> =>
  (await contentHash([utterance.anchor, utterance.text])).slice(0, PRINT_LENGTH);

export const printsOf = (utterances: ReadonlyArray<Utterance>): Promise<ReadonlyArray<string>> => Promise.all(utterances.map(printOf));

// The page a kept place resolves against: its utterances and, index for index, their prints.
export interface PrintedPage {
  readonly utterances: ReadonlyArray<Utterance>;
  readonly prints: ReadonlyArray<string>;
}

// ── the kept form ───────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] A Place as it is kept: the place, and the print of the
// utterance it names.
export interface KeptPlace {
  readonly place: Place;
  readonly print: string;
}

// `<utterance>.<char>.<print>`: digits, dots and hex, so it needs no escaping in a fragment.
export const formatKept = ({ place, print }: KeptPlace): string => `${place.utterance}.${place.char}.${print}`;

const KEPT = new RegExp(`^(\\d{1,9})\\.(\\d{1,9})\\.([0-9a-f]{${PRINT_LENGTH}})$`);

// [LAW:parse-dont-validate] A string becomes a kept place or nothing: anything this module
// did not write — another build's shape, a hand edit, a truncated link — is not a place.
export const parseKept = (raw: string): KeptPlace | null => {
  const match = KEPT.exec(raw);
  if (match === null) return null;
  const [, utterance, char, print] = match;
  if (utterance === undefined || char === undefined || print === undefined) return null;
  return { place: { utterance: Number(utterance), char: Number(char) }, print };
};

// The kept form of a place on this page. A place outside the page is a caller's bug.
export const keptOf = (page: PrintedPage, place: Place): KeptPlace => {
  const print = page.prints[place.utterance];
  if (print === undefined) throw new RangeError(`kept place: no utterance ${place.utterance} of ${page.prints.length}`);
  return { place, print };
};

// [LAW:single-enforcer] The one door back in: the place, while the utterance at its index
// still has its print and the character is still in its text; otherwise null.
export const resolveKept = (page: PrintedPage, kept: KeptPlace): Place | null => {
  const { utterance, char } = kept.place;
  const text = page.utterances[utterance]?.text;
  return page.prints[utterance] === kept.print && text !== undefined && char < text.length ? kept.place : null;
};

// [LAW:single-enforcer] What a place is kept as: the first character of its word — the word
// holding it, or the last one begun before it — so a place kept while the voice is under way
// changes once a word, whatever the voice knows of its own timing, and resumes on the word
// the reader heard. A place before its utterance's first word, or in an utterance with no
// words, is kept as it is.
export const wordStart = (utterances: ReadonlyArray<Utterance>, place: Place): Place => {
  const word = wordSpans(utterances[place.utterance]?.text ?? "", 0).findLast((span) => span.charStart <= place.char);
  return word === undefined ? place : { utterance: place.utterance, char: word.charStart };
};

// ── the device's storage ────────────────────────────────────────────────────────────

// One key per paste: the slug names the paste, the print names the text inside it.
export const RESUME_PREFIX = "listen.resume.";
const resumeKey = (slug: string): string => `${RESUME_PREFIX}${slug}`;

// [LAW:no-silent-failure] exception: a browser that refuses site storage throws on the store
// itself; it reads as nothing kept and writes as nothing kept — the resume is a
// convenience, and a refused store must not take Listen down with it (listenConsent.ts and
// voiceChoice.ts make the same trade). A kept place that no longer resolves is not an
// error: it is the honest "nothing to resume".
export const readResume = (store: PreferenceStore, slug: string, page: PrintedPage): Place | null => {
  try {
    const kept = parseKept(store.getItem(resumeKey(slug)) ?? "");
    return kept === null ? null : resolveKept(page, kept);
  } catch {
    return null;
  }
};

export const writeResume = (store: PreferenceStore, slug: string, page: PrintedPage, place: Place): void => {
  const kept = formatKept(keptOf(page, place));
  try {
    store.setItem(resumeKey(slug), kept);
  } catch {
    /* storage refused — the place is not kept; the listen under way is unaffected */
  }
};

// A listen that ran to its end has nothing to resume.
export const forgetResume = (store: PreferenceStore, slug: string): void => {
  try {
    store.removeItem(resumeKey(slug));
  } catch {
    /* storage refused — what it holds is not read back as a place either way */
  }
};

// ── the link ────────────────────────────────────────────────────────────────────────

export const LINK_PREFIX = "#listen=";

export const fragmentOf = (page: PrintedPage, place: Place): string => `${LINK_PREFIX}${formatKept(keptOf(page, place))}`;

// [LAW:types-are-the-program] What a page's fragment says about the listen: nothing (no
// listen link, or one this module cannot read), a place on this page, or a place the page
// no longer has — the link was made before its text changed.
export type Linked = { readonly kind: "none" } | { readonly kind: "place"; readonly place: Place } | { readonly kind: "gone" };

export const linked = (page: PrintedPage, fragment: string): Linked => {
  if (!fragment.startsWith(LINK_PREFIX)) return { kind: "none" };
  const kept = parseKept(fragment.slice(LINK_PREFIX.length));
  if (kept === null) return { kind: "none" };
  const place = resolveKept(page, kept);
  return place === null ? { kind: "gone" } : { kind: "place", place };
};
