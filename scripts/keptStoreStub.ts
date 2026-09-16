// The device's kept-audio store as two maps, keeping exactly the records and audio it is
// given: the in-memory KeptStore every kept-audio check drives in place of IndexedDB.

import type { EncodedAudio } from "../src/audioCodec";
import type { KeptRecord, KeptStore } from "../src/keptAudio";

export const memoryStore = () => {
  const records = new Map<string, KeptRecord>();
  const audio = new Map<string, EncodedAudio>();
  const store: KeptStore = {
    records: async (keys) => keys.map((key) => records.get(key)),
    audio: async (key) => audio.get(key),
    put: async (key, record, bytes) => {
      records.set(key, record);
      audio.set(key, bytes);
    },
    touch: async (keys, playedAt) => {
      for (const key of keys) {
        const record = records.get(key);
        if (record !== undefined) records.set(key, { ...record, playedAt });
      }
    },
    ledger: async () => [...records].map(([key, record]) => ({ key, bytes: record.bytes, playedAt: record.playedAt })),
    remove: async (keys) => {
      for (const key of keys) {
        records.delete(key);
        audio.delete(key);
      }
    },
  };
  return { store, records, audio };
};

