// [LAW:decomposition] Which turns' digests the narrator has to say. One sentence, no "and"
// hiding a second job — this module answers that question and stops there. It derives no
// digest (turnDigest.ts), speaks nothing and holds no panel: the page asks it for a map and
// hands that map to speech.ts's `withDigests`, which is the one thing that puts an utterance
// in front of a turn.
//
// [LAW:one-way-deps] It reads the digest service's OUTCOME and the device's storage, and
// neither reads it. Both are parameters [LAW:effects-at-boundaries], so
// scripts/digest-speech-check.ts drives every arm with a plain function and a Map.
//
// WHY THE READER'S CHOICE LIVES HERE AND NOT IN THE PANEL. Whether the narrator says a digest
// changes what the conversation SAYS — a different utterance list, a different script, a
// different rendition — and nothing about the transport that plays it. So it is composed into
// the page before the panel ever sees it, rather than carried as a mode the panel would have
// to hold and every readout answer for [LAW:no-mode-explosion].

import type { PreferenceStore } from "./preferenceStore";
import type { SpokenDigests } from "./speech";
import type { DigestService, DigestTurn } from "./turnDigest";

// One key, one value, and the ABSENCE is the default — which here is "say them", the
// opposite way round from the download preferences (listenConsent.ts, digestConsent.ts),
// because this one costs the reader nothing to leave on: no download, no model, no byte
// fetched. Only a reader who turned it off has anything written, so a store that holds
// nothing, holds another build's value, or refuses (deviceStore reads a refused store as
// nothing kept) reads as the default [LAW:one-type-per-behavior].
export const SAY_KEY = "digest.say";
const SILENT = "never";

export const readSaid = (store: PreferenceStore): boolean => store.getItem(SAY_KEY) !== SILENT;

export const writeSaid = (store: PreferenceStore, said: boolean): void => {
  if (said) store.removeItem(SAY_KEY);
  else store.setItem(SAY_KEY, SILENT);
};

// The reader's "no", and the answer before a page has a summarizer at all: a conversation
// with no turn to digest. A value the composition already handles, never a second path
// through it [LAW:dataflow-not-control-flow].
export const NOTHING_SAID: SpokenDigests = new Map();

// [LAW:dataflow-not-control-flow] One fold over the turns the page carries, asking the
// service what it holds of each. A turn still pending and one that failed differ to the CARD,
// which says each of them in its own words (digestView.ts); to the narrator they are one
// thing — a turn with nothing to say before it — so they are one absent entry here, not two
// arms. A page with no service has not derived any of them, which is that same absence for
// every turn, and so is the empty map rather than an outcome this module would have to invent
// for a turn nobody has looked at [LAW:no-silent-failure].
//
// Never waiting is the whole of this function's timing: it reads what the service holds at
// the moment it is asked and returns, so a digest still being derived costs the voice
// nothing. A digest that lands afterwards is in the next map this is asked for, which the
// page composes when the service settles.
//
// What the map does NOT carry, deliberately: that a digest was COMBINED from the parts of a
// turn too long for one summarize pass. The card marks that, where a reader can see it beside
// the digest and let their eye pass over it; said aloud it would be a syllable of provenance
// in front of the sentence it is about, before every long turn, with no way to skip it.
export const spokenDigests = (turns: ReadonlyArray<DigestTurn>, service: DigestService | null): SpokenDigests =>
  service === null
    ? NOTHING_SAID
    : new Map(
        turns.flatMap(({ index }): ReadonlyArray<readonly [number, string]> => {
          const held = service.outcome(index);
          return held.kind === "ready" ? [[index, held.text]] : [];
        }),
      );
