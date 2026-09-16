// [LAW:decomposition] Kept audio: the units the voice has already made, kept on the reader's
// device so a replay or a resume plays them from the device instead of synthesizing them
// again. One sentence, no "and" hiding a second job: this module decides what the device keeps
// of a unit, under which key, and for how long. It packs no audio (audioCodec.ts), talks to no
// worker (keptSynthesis.ts answers requests from it) and plays nothing. Its effects — the
// store, the codec, the clock — are parameters, so scripts/kept-audio-check.ts drives every
// arm with an in-memory store and the PCM codec [LAW:effects-at-boundaries].
//
// A PROJECTION, NEVER A SOURCE [LAW:one-source-of-truth]. A kept unit is the model's audio for
// one unit's identity (`unitHash`: the fed text and its source, the voice asset, the model,
// the rules and the generation) and nothing else, so it is the same audio the worker would
// make — the seed is fixed — and the device holding it or not changes only how long a unit
// takes to arrive. An edit, a voice change or a new model is a different key and simply
// misses; nothing is ever invalidated, because nothing can go stale under its own key.
//
// WHAT IS KEPT PER UNIT: the audio in the codec's form, and the unit's record — its report
// (duration and word times) and frame count — apart from the audio, so a voice built over a
// script reads every kept unit's measurement in one small read (`restore`) and a resume
// lands on its word before any audio is decoded.
//
// THE CAP. At most KEPT_BYTES of audio stay on the device, counted in the kept form's bytes.
// Every write that crosses the cap removes the least recently played units until it holds
// again; a unit is played when it is served, when it is written, and when a voice is built
// over a script that holds it — so a paste opened for listening is recent as a whole, and a
// paste nobody has opened for longest goes first [LAW:no-ambient-temporal-coupling]. Eviction
// is by unit rather than by rendition because units are shared between renditions: a change
// of Claude's voice keeps the reader's units, and a unit evicted from a paste is one unit
// synthesized again, never a paste lost. Nothing here offers a clearing control and there is
// nothing for a reader to manage. Writes are serialized here, so each eviction counts a store
// its own writes have settled.
//
// [LAW:no-silent-failure] exception: every failure — a store the browser refuses (private
// mode, quota), an entry that no longer decodes — is the cache not holding the unit: a miss,
// synthesized as if nothing had been kept, and reported through `onFailure` so it is heard in
// the console. A kept unit is a convenience; a refused store must not take Listen down with it
// (keptPlace.ts makes the same trade for the resume position).

import { bytesOf, type AudioCodec, type EncodedAudio } from "./audioCodec";
import type { UnitReport } from "./speechManifest";
import { unitHash, unitText, type SynthesisUnit, type UnitText, type VoiceMap } from "./speechScript";
import type { VoiceId } from "./modelAssets";

// 128 MiB: about eleven hours of Opus at the codec's 24 kbps, or three quarters of an hour of
// 16-bit PCM where the browser has no Opus — beside the 239 MB model in the same origin.
export const KEPT_BYTES = 128 * 1024 * 1024;

// ── the store seam ───────────────────────────────────────────────────────────────────

// A unit's record: what the manifest is restored from, and what the cap is counted over.
export interface KeptRecord {
  readonly report: UnitReport;
  readonly frames: number;
  readonly bytes: number;
  readonly playedAt: number;
}

export interface LedgerEntry {
  readonly key: string;
  readonly bytes: number;
  readonly playedAt: number;
}

// [LAW:types-are-the-program] Exactly what the cache asks of a store, so IndexedDB and the
// check's in-memory map are the same type.
export interface KeptStore {
  // The records under these keys, index for index; undefined where there is none.
  records(keys: ReadonlyArray<string>): Promise<ReadonlyArray<KeptRecord | undefined>>;
  audio(key: string): Promise<EncodedAudio | undefined>;
  // The record and its audio, together or not at all.
  put(key: string, record: KeptRecord, audio: EncodedAudio): Promise<void>;
  touch(keys: ReadonlyArray<string>, playedAt: number): Promise<void>;
  ledger(): Promise<ReadonlyArray<LedgerEntry>>;
  remove(keys: ReadonlyArray<string>): Promise<void>;
}

// ── the policy ───────────────────────────────────────────────────────────────────────

// The units to remove so the store holds `cap` bytes: least recently played first, the key
// breaking a tie so the choice is a function of the ledger alone.
export const evictions = (ledger: ReadonlyArray<LedgerEntry>, cap: number): ReadonlyArray<string> => {
  let total = ledger.reduce((sum, entry) => sum + entry.bytes, 0);
  const gone: string[] = [];
  for (const entry of [...ledger].sort((a, b) => a.playedAt - b.playedAt || (a.key < b.key ? -1 : 1))) {
    if (total <= cap) break;
    gone.push(entry.key);
    total -= entry.bytes;
  }
  return gone;
};

// ── the cache ────────────────────────────────────────────────────────────────────────

// What a synthesize request names: the one shape a unit is kept under.
export interface UnitRequest {
  readonly text: UnitText;
  readonly voice: VoiceId;
}

// A kept unit as the port replays it: its frames and the report the worker made with them.
export interface KeptUnit {
  readonly frames: ReadonlyArray<Float32Array<ArrayBuffer>>;
  readonly report: UnitReport;
}

export interface AudioCache {
  // The unit's frames and report when the device holds it; null otherwise. Never rejects.
  readonly find: (request: UnitRequest) => Promise<KeptUnit | null>;
  // Keeps a unit the worker finished. Never rejects.
  readonly keep: (request: UnitRequest, frames: ReadonlyArray<Float32Array<ArrayBuffer>>, report: UnitReport) => Promise<void>;
  // For each unit of a script in these voices, its kept report, or undefined. Never rejects.
  readonly restore: (script: ReadonlyArray<SynthesisUnit>, voices: VoiceMap) => Promise<ReadonlyArray<UnitReport | undefined>>;
}

export interface AudioCacheConfig {
  // The store and the codec, each settled once per page: a browser that refuses the store
  // keeps nothing, and the codec waits on the probe of what this browser encodes.
  readonly store: Promise<KeptStore>;
  readonly codec: Promise<AudioCodec>;
  readonly now: () => number;
  readonly cap: number;
  readonly onFailure: (what: string, error: unknown) => void;
}

export const createAudioCache = (config: AudioCacheConfig): AudioCache => {
  const { now, cap, onFailure } = config;
  // [LAW:no-shared-mutable-globals] The tail of the write chain, owned here: each keep runs
  // after the one before it has settled.
  let writes: Promise<void> = Promise.resolve();
  // A store that never opens is reported by every use that meets it, not as an unhandled
  // rejection before the first.
  config.store.catch(() => undefined);

  const attempt = async <T,>(what: string, fallback: T, run: (store: KeptStore) => Promise<T>): Promise<T> => {
    try {
      return await run(await config.store);
    } catch (error) {
      onFailure(what, error);
      return fallback;
    }
  };

  const keyOf = (request: UnitRequest): Promise<string> => unitHash(request.text, request.voice);

  const find = (request: UnitRequest): Promise<KeptUnit | null> =>
    attempt("reading a kept unit", null, async (store) => {
      const key = await keyOf(request);
      const [record] = await store.records([key]);
      const audio = record === undefined ? undefined : await store.audio(key);
      if (record === undefined || audio === undefined) return null;
      const frames = await (await config.codec).decode(audio, record.frames);
      void attempt("marking a kept unit played", undefined, (held) => held.touch([key], now()));
      return { frames, report: record.report };
    });

  const keep = (request: UnitRequest, frames: ReadonlyArray<Float32Array<ArrayBuffer>>, report: UnitReport): Promise<void> => {
    // Played when it was made, not when its turn in the write chain comes.
    const playedAt = now();
    writes = writes.then(() =>
      attempt("keeping a unit", undefined, async (store) => {
        const key = await keyOf(request);
        const audio = await (await config.codec).encode(frames);
        await store.put(key, { report, frames: frames.length, bytes: bytesOf(audio), playedAt }, audio);
        const gone = evictions(await store.ledger(), cap);
        if (gone.length > 0) await store.remove(gone);
      }),
    );
    return writes;
  };

  const restore = (script: ReadonlyArray<SynthesisUnit>, voices: VoiceMap): Promise<ReadonlyArray<UnitReport | undefined>> =>
    attempt("restoring kept units", script.map(() => undefined), async (store) => {
      const keys = await Promise.all(script.map((unit) => keyOf({ text: unitText(unit), voice: voices[unit.utterance.voice] })));
      const records = await store.records(keys);
      const held = keys.filter((_, i) => records[i] !== undefined);
      if (held.length > 0) await store.touch(held, now());
      return records.map((record) => record?.report);
    });

  return { find, keep, restore };
};

// ── the browser's store ──────────────────────────────────────────────────────────────

const DATABASE = "listen-kept-audio";
const RECORDS = "records";
const AUDIO = "audio";

const settled = <T,>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const done = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("kept audio: the transaction was aborted"));
  });

// [LAW:effects-at-boundaries] The one edge to IndexedDB: two object stores under one
// database, records apart from audio, both keyed by the unit's hash. Opened once per page.
export const openKeptStore = async (factory: IDBFactory): Promise<KeptStore> => {
  const opening = factory.open(DATABASE, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(RECORDS);
    opening.result.createObjectStore(AUDIO);
  };
  const db = await settled(opening);

  const records = async (keys: ReadonlyArray<string>): Promise<ReadonlyArray<KeptRecord | undefined>> => {
    const store = db.transaction(RECORDS, "readonly").objectStore(RECORDS);
    return Promise.all(keys.map((key) => settled(store.get(key) as IDBRequest<KeptRecord | undefined>)));
  };

  const touch = async (keys: ReadonlyArray<string>, playedAt: number): Promise<void> => {
    const transaction = db.transaction(RECORDS, "readwrite");
    const store = transaction.objectStore(RECORDS);
    for (const key of keys) {
      const reading = store.get(key) as IDBRequest<KeptRecord | undefined>;
      reading.onsuccess = () => {
        if (reading.result !== undefined) store.put({ ...reading.result, playedAt }, key);
      };
    }
    await done(transaction);
  };

  const put = async (key: string, record: KeptRecord, audio: EncodedAudio): Promise<void> => {
    const transaction = db.transaction([RECORDS, AUDIO], "readwrite");
    transaction.objectStore(AUDIO).put(audio, key);
    transaction.objectStore(RECORDS).put(record, key);
    await done(transaction);
  };

  const ledger = async (): Promise<ReadonlyArray<LedgerEntry>> => {
    const store = db.transaction(RECORDS, "readonly").objectStore(RECORDS);
    const [keys, values] = await Promise.all([settled(store.getAllKeys()), settled(store.getAll() as IDBRequest<KeptRecord[]>)]);
    return values.map((record, i) => ({ key: String(keys[i]), bytes: record.bytes, playedAt: record.playedAt }));
  };

  const remove = async (keys: ReadonlyArray<string>): Promise<void> => {
    const transaction = db.transaction([RECORDS, AUDIO], "readwrite");
    for (const key of keys) {
      transaction.objectStore(RECORDS).delete(key);
      transaction.objectStore(AUDIO).delete(key);
    }
    await done(transaction);
  };

  return {
    records,
    audio: (key) => settled(db.transaction(AUDIO, "readonly").objectStore(AUDIO).get(key) as IDBRequest<EncodedAudio | undefined>),
    put,
    touch,
    ledger,
    remove,
  };
};
