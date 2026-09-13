// [LAW:decomposition] The exact surface of Web Storage a device preference is kept behind.
// One sentence, no "and": this module names the seam. The page hands window.localStorage
// to every preference module (listenConsent.ts, voiceChoice.ts); the checks hand a Map
// (scripts/preferenceStub.ts) [LAW:effects-at-boundaries].
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
