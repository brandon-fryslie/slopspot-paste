// The device's kept-audio store as four maps, keeping exactly the entries, records, audio and
// scripts it is given: the in-memory KeptStore every kept-audio check drives in place of IndexedDB.
// `room` is the device's own limit in the ledger's bytes: a write that would pass it is
// refused as IndexedDB refuses one, with a QuotaExceededError, and nothing of it is kept.

import type { EncodedAudio } from "../src/audioCodec";
import type { KeptRecord, KeptScriptUnit, KeptStore, LedgerEntry } from "../src/keptAudio";

export const memoryStore = ({ room = Number.POSITIVE_INFINITY }: { room?: number } = {}) => {
  const ledger = new Map<string, LedgerEntry>();
  const records = new Map<string, KeptRecord>();
  const audio = new Map<string, EncodedAudio>();
  const scripts = new Map<string, ReadonlyArray<KeptScriptUnit>>();
  const refused = (entry: LedgerEntry): boolean => held() - (ledger.get(entry.key)?.bytes ?? 0) + entry.bytes > room;
  const held = (): number => [...ledger.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const store: KeptStore = {
    records: async (keys) => keys.map((key) => records.get(key)),
    audio: async (key) => audio.get(key),
    put: async (entry, record, bytes) => {
      if (refused(entry)) throw new DOMException("the device is full", "QuotaExceededError");
      ledger.set(entry.key, entry);
      records.set(entry.key, record);
      audio.set(entry.key, bytes);
    },
    script: async (key) => scripts.get(key),
    putScript: async (entry, units) => {
      if (refused(entry)) throw new DOMException("the device is full", "QuotaExceededError");
      ledger.set(entry.key, entry);
      scripts.set(entry.key, units);
    },
    touch: async (keys, playedAt) => {
      for (const key of keys) {
        const entry = ledger.get(key);
        if (entry !== undefined) ledger.set(key, { ...entry, playedAt });
      }
    },
    ledger: async () => [...ledger.values()],
    remove: async (keys) => {
      for (const key of keys) {
        ledger.delete(key);
        records.delete(key);
        audio.delete(key);
        scripts.delete(key);
      }
    },
  };
  return { store, ledger, records, audio, scripts };
};
