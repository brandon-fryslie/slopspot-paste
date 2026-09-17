// Digests' standing consent (slopspot-turn-digest-8xc.44n): the remembered preference over an
// in-memory store, its own key beside Listen's, and the metered rule that still asks.
// Run: `tsx scripts/digest-consent-check.ts`.

import { PREFERENCE_KEY, readPreference, standingConsent, writePreference } from "../src/digestConsent";
import { PREFERENCE_KEY as LISTEN_KEY } from "../src/listenConsent";
import { memoryPreferences, refusedPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

console.log("the preference round-trips through the store");
{
  const store = memoryPreferences();
  assert("an empty store is not remembered", !readPreference(store));
  writePreference(store, true);
  assert("remembered: one key, read back true", readPreference(store) && store.keys().join() === PREFERENCE_KEY);
  writePreference(store, false);
  assert("forgotten: the key is removed, not written as a second value", !readPreference(store) && store.keys().length === 0);
  store.setItem(PREFERENCE_KEY, "sure");
  assert("a value this build did not write reads as not remembered", !readPreference(store));
}

console.log("digests and Listen remember separately: two features, two answers");
{
  // That the two keys are different strings is a fact the compiler already holds — asserting
  // it here is dead weight. What a check can say is what a write DOES.
  const store = memoryPreferences();
  writePreference(store, true);
  assert("saying yes to digests writes nothing under Listen's key", store.getItem(LISTEN_KEY) === null);
}

console.log("a store that refuses — a browser that blocks site data — reads as not remembered and takes no write");
{
  const refusing = refusedPreferences();
  const survives = (act: () => void): boolean => {
    try {
      act();
      return true;
    } catch {
      return false;
    }
  };
  assert("a refusing store reads as not remembered", !readPreference(refusing));
  assert("neither the write nor the removal throws", survives(() => writePreference(refusing, true)) && survives(() => writePreference(refusing, false)));
}

console.log("standing consent: remembered, unless the connection is metered");
{
  assert("not remembered, no reading: none", standingConsent(false, undefined) === "none");
  assert("remembered, no reading: download — an absent reading is not a metered signal", standingConsent(true, undefined) === "download");
  assert("remembered on wifi: download", standingConsent(true, { type: "wifi" }) === "download");
  assert("remembered on cellular: none — the standing yes still asks", standingConsent(true, { type: "cellular" }) === "none");
  assert("remembered with save-data: none", standingConsent(true, { saveData: true }) === "none");
}

console.log(process.exitCode === 1 ? "digest-consent-check: FAILED" : "digest-consent-check: ok");
