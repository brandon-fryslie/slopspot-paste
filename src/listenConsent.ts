// [LAW:decomposition] Listen's standing consent: whether the weights may download on this
// visit without a tap. One sentence, no "and" — this module answers that question from the
// device's remembered preference and the connection. It fetches nothing, spawns nothing and
// knows no panel state; the panel (listenPanel.ts) asks it at mount, on a page restored from
// the back-forward cache, and when the reader changes the preference, and turns the answer
// into its own events.
//
// WHY A PREFERENCE, NOT A TAP. A first listen is a 239 MB download away, and a reader who
// listens often should not be asked every visit. "Remember this" on the mark's hover is a
// per-device yes: kept in the page's storage, reversible from the same hover, and read from
// storage every time it is needed rather than copied into memory [LAW:one-source-of-truth].
//
// [LAW:single-enforcer] The metered-connection rule lives in modelAssets.downloadNeedsTap
// and is read here, nowhere else: a remembered yes still asks on save-data or cellular. So
// the reader's consent is one value with two doors — the tap, and this standing yes — and
// the exception applies to the standing one only, in the one function that grants it.
//
// [LAW:effects-at-boundaries] Storage is a parameter of the two edges below, so
// scripts/listen-consent-check.ts drives them over an in-memory store; the page hands them
// window.localStorage.

import { downloadNeedsTap, type ConnectionReading } from "./modelAssets";

// The exact surface of Web Storage the preference needs.
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// One key, one value: the preference is either remembered or absent. A value other than
// the one written is not a preference this build wrote, and reads as absent.
export const PREFERENCE_KEY = "listen.download";
const REMEMBERED = "always";

export const readPreference = (store: PreferenceStore): boolean => store.getItem(PREFERENCE_KEY) === REMEMBERED;

// Unchecking removes the key rather than writing "never": the absence IS "ask", and a store
// that never held the key and one the reader cleared read the same [LAW:one-type-per-behavior].
export const writePreference = (store: PreferenceStore, remembered: boolean): void => {
  if (remembered) store.setItem(PREFERENCE_KEY, REMEMBERED);
  else store.removeItem(PREFERENCE_KEY);
};

// [LAW:types-are-the-program] What the visit grants before any tap: nothing, or a download.
// Never `play` — the standing yes warms the voice, it does not start it speaking.
export type StandingConsent = "none" | "download";

export const standingConsent = (remembered: boolean, connection: ConnectionReading | undefined): StandingConsent =>
  remembered && !downloadNeedsTap(connection) ? "download" : "none";
