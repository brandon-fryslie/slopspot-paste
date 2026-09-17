// [LAW:decomposition] Digests' standing consent: whether the summary model may download on
// this visit without the reader asking for it. One sentence, no "and" — this module reads
// the device's remembered preference and the connection, and answers. It creates no
// Summarizer, shows nothing, and knows no panel; digestPanel.ts asks it at mount and when
// the reader changes the box, and turns the answer into what the page does.
//
// WHY ITS OWN PREFERENCE, BESIDE LISTEN'S. A reader who wants the voice does not thereby
// want a second model downloaded, and one who wants digests may never press Play. Two
// features, two per-device answers, two keys [LAW:one-type-per-behavior] — the shape is
// Listen's (listenConsent.ts) because the question is the same shape, but the preference
// is not shared and neither read is the other's.
//
// [LAW:single-enforcer] The metered-connection rule is modelAssets.downloadNeedsTap, the one
// place that decides what a metered connection is; this module composes it exactly as
// Listen's consent does, and neither owns a second copy of the rule. A remembered yes still
// asks on save-data or cellular.
//
// THE BROWSER HOLDS A GATE THIS MODULE CANNOT OPEN. The spec's create() consumes transient
// user activation whenever it must download, so a remembered yes cannot summon the model
// out of a quiet page load — it can only mean "do not ask me again; take my next gesture as
// the yes". What this module answers is therefore whether to ASK, never whether the browser
// will allow it; the attempt and the browser's answer are digestPanel.ts's
// [LAW:no-silent-failure].
//
// [LAW:effects-at-boundaries] Storage is a parameter, so scripts/digest-consent-check.ts
// drives it over an in-memory store; the page hands it the device's storage through
// preferenceStore.deviceStore, which answers a refused store.

import { downloadNeedsTap, type ConnectionReading } from "./modelAssets";
import type { PreferenceStore } from "./preferenceStore";

// One key, one value: the preference is either remembered or absent. A value other than the
// one written is not a preference this build wrote, and reads as absent.
export const PREFERENCE_KEY = "digest.download";
const REMEMBERED = "always";

// The remembered yes, or "ask": a store that holds nothing, holds another value, or refuses
// (deviceStore reads a refused store as nothing) reads as "ask".
export const readPreference = (store: PreferenceStore): boolean => store.getItem(PREFERENCE_KEY) === REMEMBERED;

// Unchecking removes the key rather than writing "never": the absence IS "ask", and a store
// that never held the key and one the reader cleared read the same [LAW:one-type-per-behavior].
export const writePreference = (store: PreferenceStore, remembered: boolean): void => {
  if (remembered) store.setItem(PREFERENCE_KEY, REMEMBERED);
  else store.removeItem(PREFERENCE_KEY);
};

// [LAW:types-are-the-program] What the visit grants before the reader is asked anything:
// nothing, or a download on the reader's next gesture. Never "summarize" — a standing yes
// gets the model, it does not decide that digests are wanted, which the reader settled by
// remembering the yes in the first place.
export type StandingConsent = "none" | "download";

export const standingConsent = (remembered: boolean, connection: ConnectionReading | undefined): StandingConsent =>
  remembered && !downloadNeedsTap(connection) ? "download" : "none";
