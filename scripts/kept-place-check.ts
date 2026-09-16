// A place kept outside the page — in the device's storage and in a link's fragment — and
// the rule for when it still names the text it named (slopspot-read-along-a35.4). Run:
// `tsx scripts/kept-place-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is the contract the resume and the link
// ride on: a Mark written either way reads back as the same Mark on the same page; a page
// whose utterance at that index has changed — its words, or the turn it belongs to —
// yields nothing, so there is no resume offer and a link says its moment is gone; a change
// elsewhere on the page, or a new voice, leaves it standing; and nothing this module did
// not write is read as a place. Storage is the Map the other preference checks use.

import {
  forgetResume,
  formatKept,
  fragmentOf,
  keptOf,
  linked,
  parseKept,
  PRINT_LENGTH,
  printsOf,
  readResume,
  resolveKept,
  RESUME_PREFIX,
  wordStart,
  writeResume,
  type PrintedPage,
} from "../src/keptPlace";
import type { Place } from "../src/performer";
import type { PreferenceStore } from "../src/preferenceStore";
import type { Utterance } from "../src/speech";
import { memoryPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const throws = (label: string, f: () => unknown): void => {
  let threw = false;
  try {
    f();
  } catch {
    threw = true;
  }
  assert(label, threw);
};

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const utterances: ReadonlyArray<Utterance> = [
  { index: 0, anchor: "t0", origin: "page", voice: "user", text: "Why does the parser stall on the second pass?" },
  { index: 1, anchor: "t1", origin: "page", voice: "assistant", text: "The loop never advances its cursor." },
  { index: 1, anchor: "t1", origin: "announcement", voice: "narrator", text: "typescript code block, 3 lines." },
  { index: 2, anchor: "t2", origin: "page", voice: "user", text: "That fixed it, thanks." },
];
const printed = async (list: ReadonlyArray<Utterance>): Promise<PrintedPage> => ({ utterances: list, prints: await printsOf(list) });
const page = await printed(utterances);
const place = (utterance: number, char: number): Place => ({ utterance, char });
const same = (a: Place | null, b: Place): boolean => a !== null && a.utterance === b.utterance && a.char === b.char;
const SLUG = "k7Qx2a";
const ADVANCES = place(1, "The loop never ".length);

// ── the prints ────────────────────────────────────────────────────────────────────────

console.log("printsOf: a short print per utterance, of its anchor and its text");
{
  assert("one print per utterance, each PRINT_LENGTH hex characters", page.prints.length === utterances.length && page.prints.every((print) => print.length === PRINT_LENGTH && /^[0-9a-f]+$/.test(print)));
  assert("the same utterance prints the same on every render", (await printsOf(utterances)).join() === page.prints.join());
  const [again] = await printsOf([{ ...utterances[1]!, origin: "page", voice: "user" }]);
  assert("the voice is not in the print: a new voice reads the same word", again === page.prints[1]);
  const [edited] = await printsOf([{ ...utterances[1]!, text: "The loop never moves its cursor." }]);
  const [moved] = await printsOf([{ ...utterances[1]!, anchor: "t4" }]);
  assert("a change to the words, or to the turn it belongs to, is a different print", edited !== page.prints[1] && moved !== page.prints[1]);
}

// ── the kept form ─────────────────────────────────────────────────────────────────────

console.log("formatKept and parseKept: one string, read back as the place it was");
{
  const kept = keptOf(page, ADVANCES);
  const written = formatKept(kept);
  assert("the kept form is utterance, character and print, dot-separated", written === `1.15.${page.prints[1]}`);
  const read = parseKept(written);
  assert("it parses back to the same place and print", read !== null && same(read.place, ADVANCES) && read.print === kept.print);
  const refused = ["", "1.15", `1.15.${page.prints[1]}x`, `-1.15.${page.prints[1]}`, `1.1.5.${page.prints[1]}`, `a.15.${page.prints[1]}`, `1.15.${page.prints[1]?.toUpperCase()}`, " 1.15.0123abcd"];
  assert("nothing this module did not write is a place", refused.every((raw) => parseKept(raw) === null));
  throws("keeping a place outside the page is a caller's bug", () => keptOf(page, place(9, 0)));
}

console.log("resolveKept: a kept place names its word exactly while the utterance at its index is unchanged");
{
  const kept = keptOf(page, ADVANCES);
  assert("on the page it was kept on, the same place", same(resolveKept(page, kept), ADVANCES));
  const elsewhere = await printed(utterances.map((u, i) => (i === 3 ? { ...u, text: "That fixed it. Thank you!" } : u)));
  assert("an edit to another utterance leaves it standing", same(resolveKept(elsewhere, kept), ADVANCES));
  const edited = await printed(utterances.map((u, i) => (i === 1 ? { ...u, text: "The loop never moves its cursor." } : u)));
  assert("an edit to its own utterance: nothing", resolveKept(edited, kept) === null);
  const shifted = await printed(utterances.slice(1));
  assert("a turn removed before it, so its index names another utterance: nothing", resolveKept(shifted, kept) === null);
  assert("a character past the utterance's text: nothing", resolveKept(page, { place: place(1, 400), print: kept.print }) === null);
  assert("an index past the page: nothing", resolveKept(page, { place: place(9, 0), print: kept.print }) === null);
}

console.log("wordStart: a place is kept at the first character of its word");
{
  assert("inside a word: that word's first character", same(wordStart(utterances, place(1, "The loop never adv".length)), ADVANCES));
  assert("on a word's first character: itself", same(wordStart(utterances, ADVANCES), ADVANCES));
  assert("in the space or stop after a word: that word, the last begun", same(wordStart(utterances, place(1, "The loop never".length)), place(1, "The loop ".length)) && same(wordStart(utterances, place(1, "The loop never advances its cursor.".length - 1)), place(1, "The loop never advances its ".length)));
  const quoted: ReadonlyArray<Utterance> = [{ index: 0, anchor: "t0", origin: "page", voice: "user", text: "“Why?”" }, { index: 1, anchor: "t1", origin: "page", voice: "user", text: "…" }];
  assert("before an utterance's first word, or in one with no words: kept as it is", same(wordStart(quoted, place(0, 0)), place(0, 0)) && same(wordStart(quoted, place(1, 0)), place(1, 0)));
}

// ── the storage ───────────────────────────────────────────────────────────────────────

console.log("readResume and writeResume: the place kept for this paste on this device");
{
  const store = memoryPreferences();
  assert("nothing kept: no place", readResume(store, SLUG, page) === null);
  writeResume(store, SLUG, page, ADVANCES);
  assert("one key, under this paste's slug", store.keys().join() === `${RESUME_PREFIX}${SLUG}`);
  assert("the place round-trips through storage", same(readResume(store, SLUG, page), ADVANCES));
  const later = place(3, "That fixed ".length);
  writeResume(store, SLUG, page, later);
  assert("a later write replaces it; still one key", same(readResume(store, SLUG, page), later) && store.keys().length === 1);
  assert("another paste has nothing kept", readResume(store, "other1", page) === null);
  const reprinted = await printed(utterances.map((u, i) => (i === 3 ? { ...u, text: "That fixed it for good." } : u)));
  assert("a print mismatch — the utterance re-derived since — reads as nothing kept, so there is no resume offer", readResume(store, SLUG, reprinted) === null);
  forgetResume(store, SLUG);
  assert("forgotten: nothing kept, and the key is gone", readResume(store, SLUG, page) === null && store.keys().length === 0);
  store.setItem(`${RESUME_PREFIX}${SLUG}`, "not a place");
  assert("a value this module did not write reads as nothing kept", readResume(store, SLUG, page) === null);
  const refusing: PreferenceStore = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert("a store that refuses reads as nothing kept, and a write or a forget on it is dropped without a throw", readResume(refusing, SLUG, page) === null && (writeResume(refusing, SLUG, page, ADVANCES), forgetResume(refusing, SLUG), true));
}

// ── the link ──────────────────────────────────────────────────────────────────────────

console.log("fragmentOf and linked: a link's fragment carries the same Mark");
{
  const fragment = fragmentOf(page, ADVANCES);
  assert("the fragment is the listen prefix and the kept form", fragment === `#listen=1.15.${page.prints[1]}`);
  const opened = linked(page, fragment);
  assert("the Mark round-trips through the fragment", opened.kind === "place" && same(opened.place, ADVANCES));
  const url = new URL(fragment, `https://slopspot.example/${SLUG}#edit`);
  const back = linked(page, url.hash);
  assert("written into a URL that had another fragment, it replaces it and reads back the same", url.pathname === `/${SLUG}` && back.kind === "place" && same(back.place, ADVANCES));
  const edited = await printed(utterances.map((u, i) => (i === 1 ? { ...u, text: "The loop never moves its cursor." } : u)));
  assert("a link into text that has changed since: gone, never a place", linked(edited, fragment).kind === "gone");
  assert("no fragment, another fragment, or a listen fragment this module cannot read: none", ["", "#edit", "#t1", "#listen=", "#listen=soon"].every((hash) => linked(page, hash).kind === "none"));
}

console.log(process.exitCode === 1 ? "kept-place-check: FAILED" : "kept-place-check: ok");
