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
// WHAT IS KEPT PER UNIT, in three parts under one key, each read alone: the audio in the
// codec's form; the unit's record — its report (duration and word times) and frame count —
// so a voice built over a script reads every kept unit's measurement in one small read
// (`restore`) and a resume lands on its word before any audio is decoded; and its ledger
// entry — its size and when it was last played — which is all the cap ever reads, so a
// write near the cap never loads thousands of word timings to count bytes.
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
// THE DEVICE'S OWN LIMIT. The browser may refuse a write before the cap is reached — the
// origin's quota is shared with the model and with everything else the device holds. A write
// refused for quota removes the least recently played half of what is kept and is tried once
// more, so a full device frees room on its own and the cache keeps keeping; a write refused
// again is a failure like any other.
//
// [LAW:no-silent-failure] exception: every failure — a store the browser refuses (private
// mode, quota), a store another tab holds at an older version or the browser never opens, an entry that no longer
// decodes — is the cache not holding the unit: a miss,
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

// A unit's record: what the manifest is restored from, and how many frames its audio decodes to.
export interface KeptRecord {
  readonly report: UnitReport;
  readonly frames: number;
}

// A unit's line in the ledger: what the cap is counted over.
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
  // The entry, its record and its audio, together or not at all.
  put(entry: LedgerEntry, record: KeptRecord, audio: EncodedAudio): Promise<void>;
  touch(keys: ReadonlyArray<string>, playedAt: number): Promise<void>;
  ledger(): Promise<ReadonlyArray<LedgerEntry>>;
  remove(keys: ReadonlyArray<string>): Promise<void>;
}

// ── the policy ───────────────────────────────────────────────────────────────────────

const heldBytes = (ledger: ReadonlyArray<LedgerEntry>): number => ledger.reduce((sum, entry) => sum + entry.bytes, 0);

// The browser's refusal of a write for want of room, as IndexedDB reports it on the aborted
// transaction.
const isQuota = (error: unknown): boolean => error instanceof Error && error.name === "QuotaExceededError";

// The units to remove so the store holds `cap` bytes: least recently played first, the key
// breaking a tie so the choice is a function of the ledger alone.
export const evictions = (ledger: ReadonlyArray<LedgerEntry>, cap: number): ReadonlyArray<string> => {
  let total = heldBytes(ledger);
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
        const entry = { key, bytes: bytesOf(audio), playedAt };
        const record = { report, frames: frames.length };
        await store.put(entry, record, audio).catch(async (error: unknown) => {
          if (!isQuota(error)) throw error;
          const ledger = await store.ledger();
          const gone = evictions(ledger, heldBytes(ledger) / 2);
          if (gone.length === 0) throw error;
          await store.remove(gone);
          await store.put(entry, record, audio);
        });
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
const LEDGER = "ledger";
const RECORDS = "records";
const AUDIO = "audio";
const STORES = [LEDGER, RECORDS, AUDIO];

const settled = <T,>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

// A failed request aborts its transaction, and only the abort is sure to carry the error: while
// the request's own error event bubbles through, the transaction's error is not yet set.
const done = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("kept audio: the transaction was aborted"));
  });

// How long an open may take before the store counts as refused. An open settles in
// milliseconds; some WebKit builds leave one unanswered for good.
export const OPEN_PATIENCE_MS = 5_000;

// The database, open — or refused when another tab holds it at an older version and will not
// let it go, or when the browser does not answer within `patienceMs`, so a store that will not
// open is a store that failed rather than a Listen that waits forever. An open that succeeds
// after it was refused is closed at once, so it holds nothing up either.
const opened = (factory: IDBFactory, patienceMs: number): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const opening = factory.open(DATABASE, 1);
    let refused = false;
    const refuse = (reason: string): void => {
      refused = true;
      clearTimeout(patience);
      reject(new Error(`kept audio: ${reason}`));
    };
    const patience = setTimeout(() => refuse(`the store did not open within ${patienceMs} ms`), patienceMs);
    opening.onupgradeneeded = () => {
      for (const name of STORES) opening.result.createObjectStore(name);
    };
    opening.onblocked = () => refuse("another tab holds the store at an older version");
    opening.onerror = () => {
      clearTimeout(patience);
      reject(opening.error);
    };
    opening.onsuccess = () => {
      clearTimeout(patience);
      if (refused) return opening.result.close();
      // A newer page asking for a newer version is let through: this page's store closes, and
      // every use after it fails into a miss.
      opening.result.onversionchange = () => opening.result.close();
      resolve(opening.result);
    };
  });

// [LAW:effects-at-boundaries] The one edge to IndexedDB: three object stores under one
// database — the ledger, the records and the audio — each keyed by the unit's hash. Opened
// once per page.
export const openKeptStore = async (factory: IDBFactory, patienceMs: number = OPEN_PATIENCE_MS): Promise<KeptStore> => {
  const db = await opened(factory, patienceMs);

  const records = async (keys: ReadonlyArray<string>): Promise<ReadonlyArray<KeptRecord | undefined>> => {
    const store = db.transaction(RECORDS, "readonly").objectStore(RECORDS);
    return Promise.all(keys.map((key) => settled(store.get(key) as IDBRequest<KeptRecord | undefined>)));
  };

  const touch = async (keys: ReadonlyArray<string>, playedAt: number): Promise<void> => {
    const transaction = db.transaction(LEDGER, "readwrite");
    const store = transaction.objectStore(LEDGER);
    for (const key of keys) {
      const reading = store.get(key) as IDBRequest<LedgerEntry | undefined>;
      reading.onsuccess = () => {
        if (reading.result !== undefined) store.put({ ...reading.result, playedAt }, key);
      };
    }
    await done(transaction);
  };

  const put = async (entry: LedgerEntry, record: KeptRecord, audio: EncodedAudio): Promise<void> => {
    const transaction = db.transaction(STORES, "readwrite");
    transaction.objectStore(AUDIO).put(audio, entry.key);
    transaction.objectStore(RECORDS).put(record, entry.key);
    transaction.objectStore(LEDGER).put(entry, entry.key);
    await done(transaction);
  };

  const ledger = (): Promise<ReadonlyArray<LedgerEntry>> =>
    settled(db.transaction(LEDGER, "readonly").objectStore(LEDGER).getAll() as IDBRequest<LedgerEntry[]>);

  const remove = async (keys: ReadonlyArray<string>): Promise<void> => {
    const transaction = db.transaction(STORES, "readwrite");
    for (const key of keys) {
      for (const name of STORES) transaction.objectStore(name).delete(key);
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
