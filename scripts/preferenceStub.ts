// The in-memory PreferenceStore the checks hand the modules that read the device's
// storage: the exact surface those modules declare, plus `keys` so a check can see that
// unchecking removes the key rather than writing a second value. Not a check itself
// (run-checks.ts discovers `*-check.ts`), so it is shared rather than copied
// [LAW:one-source-of-truth].

import type { PreferenceStore } from "../src/preferenceStore";

export const memoryPreferences = (): PreferenceStore & { readonly keys: () => string[] } => {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
    keys: () => [...held.keys()],
  };
};
