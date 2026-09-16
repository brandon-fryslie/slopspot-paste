// [LAW:decomposition] The exact surface of Web Storage a device preference is kept behind.
// One sentence, no "and": this module names the seam. The page hands the preference modules
// (listenConsent.ts, voiceChoice.ts, keptPlace.ts) the device's storage through
// `deviceStore`; the checks hand a Map (scripts/preferenceStub.ts) [LAW:effects-at-boundaries].
//
// [LAW:types-are-the-program] A PreferenceStore never throws: a read the device refuses is
// null, a write it refuses is not kept. The modules read and write it plainly, and a refused
// store is `deviceStore`'s to answer, nowhere else [LAW:single-enforcer].
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// The browser's storage as a store that never throws. `open` names it (window.localStorage
// in the page) and is read on every access inside the guard, because a browser that blocks
// site data throws from that getter itself, before any method is called, and one that allows
// it may still refuse a write when it is full.
// [LAW:no-silent-failure] exception: every preference kept here is a convenience, and a
// refused store must not take Listen down with it; it reads as nothing kept, and a write to
// it is not kept (the editor's draft storage makes the same trade).
export const deviceStore = (open: () => PreferenceStore): PreferenceStore => {
  const refusable = <T>(act: (store: PreferenceStore) => T, refused: T): T => {
    try {
      return act(open());
    } catch {
      return refused;
    }
  };
  return {
    getItem: (key) => refusable((store) => store.getItem(key), null),
    setItem: (key, value) => refusable((store) => store.setItem(key, value), undefined),
    removeItem: (key) => refusable((store) => store.removeItem(key), undefined),
  };
};
