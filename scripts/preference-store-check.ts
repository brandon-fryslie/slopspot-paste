// The device's storage as the page holds it (slopspot-read-along-a35.2wu): a store that
// never throws, whatever the browser does. A browser that blocks site data throws from
// window.localStorage itself, before any method is called; one that allows it may still
// refuse a read or a write. Every such refusal reads as nothing kept and writes as nothing
// kept, and a store the browser allows is the browser's own.
// Run: `tsx scripts/preference-store-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what a read answers and whether a
// write is kept — never how the guard is built.

import { deviceStore, type PreferenceStore } from "../src/preferenceStore";
import { memoryPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// Whether an act runs to its end without throwing.
const survives = (act: () => void): boolean => {
  try {
    act();
    return true;
  } catch {
    return false;
  }
};

const securityError = (): never => {
  throw new DOMException("Access is denied for this document.", "SecurityError");
};

console.log("a browser that blocks site data: the getter itself throws");
{
  const store = deviceStore(securityError);
  assert("a read is nothing kept", store.getItem("listen.download") === null);
  assert("neither a write nor a removal throws", survives(() => store.setItem("listen.download", "always")) && survives(() => store.removeItem("listen.download")));
}

console.log("a browser that allows the store and refuses what is done with it");
{
  const refusing: PreferenceStore = { getItem: securityError, setItem: securityError, removeItem: securityError };
  const store = deviceStore(() => refusing);
  assert("a refused read is nothing kept", store.getItem("listen.download") === null);
  assert("a refused write or removal does not throw", survives(() => store.setItem("listen.download", "always")) && survives(() => store.removeItem("listen.download")));
  const held = memoryPreferences();
  held.setItem("listen.voices", "kept");
  const full = deviceStore(() => ({
    ...held,
    setItem: () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    },
  }));
  assert("a full store refuses the write, and what it already holds still reads", survives(() => full.setItem("listen.voices", "new")) && full.getItem("listen.voices") === "kept");
}

console.log("a browser that allows the store: the browser's own");
{
  const held = memoryPreferences();
  const store = deviceStore(() => held);
  store.setItem("listen.download", "always");
  assert("a write is kept in the browser's store, and reads back", held.getItem("listen.download") === "always" && store.getItem("listen.download") === "always");
  store.removeItem("listen.download");
  assert("a removal removes it", held.keys().length === 0 && store.getItem("listen.download") === null);
}

console.log("the browser's store is read at every access, not once");
{
  const held = memoryPreferences();
  held.setItem("listen.download", "always");
  let blocked = true;
  const store = deviceStore(() => (blocked ? securityError() : held));
  const whileBlocked = store.getItem("listen.download");
  blocked = false;
  assert("a refusal is not remembered: once the browser allows the store, it reads", whileBlocked === null && store.getItem("listen.download") === "always");
}

console.log(process.exitCode === 1 ? "preference-store-check: FAILED" : "preference-store-check: ok");
