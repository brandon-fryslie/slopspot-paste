// Listen's standing consent (slopspot-read-along-a35.a4l): the remembered preference over
// an in-memory store, and the one decision that reads it with the metered rule.
// Run: `tsx scripts/listen-consent-check.ts`.

import { PREFERENCE_KEY, readPreference, standingConsent, writePreference, type PreferenceStore } from "../src/listenConsent";
import { memoryPreferences } from "./preferenceStub";

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
  store.setItem(PREFERENCE_KEY, "yes please");
  assert("a value this build did not write reads as not remembered", !readPreference(store));
}

console.log("a store that refuses — a browser that throws on site storage — reads as not remembered and takes no write");
{
  const refuse = (): never => {
    throw new Error("SecurityError: storage refused");
  };
  const refusing: PreferenceStore = { getItem: refuse, setItem: refuse, removeItem: refuse };
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
  assert("not remembered on wifi: none", standingConsent(false, { type: "wifi" }) === "none");
}

console.log(process.exitCode === 1 ? "listen-consent-check: FAILED" : "listen-consent-check: ok");
