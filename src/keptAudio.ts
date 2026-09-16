// [LAW:decomposition] Kept audio: what the voice has already made — a paste's script and each
// unit's audio — kept on the reader's device so a replay or a resume plays from the device
// instead of waiting on the model to cut and synthesize it again. One sentence, no "and"
// hiding a second job: this module decides what the device keeps of a listen, under which
// key, and for how long. It packs no audio (audioCodec.ts), talks to no
// worker (keptSynthesis.ts answers requests from it) and plays nothing. Its effects — the
// store, the codec, the clock — are parameters, so scripts/kept-audio-check.ts drives every
// arm with an in-memory store and the PCM codec [LAW:effects-at-boundaries].
//
// A PROJECTION, NEVER A SOURCE [LAW:one-source-of-truth]. A kept unit is the model's audio for
// one unit's identity (`unitHash`: the fed text and its source, the voice asset, the model,
// the rules and the generation) and nothing else, so it is the same audio the worker would
// make — the seed is fixed — and the device holding it or not changes only how long a unit
// takes to arrive. A kept script is the same for its utterances (`scriptHash`: the text, the
// rules, the encoder, the tokenizer and the budget), cut once and read back wherever the
// paste is opened again. What is kept of it is only what the cut adds — each unit's span and
// fed text, and the position of its utterance among the ones it was cut from: the utterances
// are the page's own, derived from the stored original and already the key's input, so a
// recalled script is rebound to them rather than read back as a second copy of the paste. An
// edit, a voice change or a new model is a different key and simply misses; nothing is ever
// invalidated, because nothing can go stale under its own key.
//
// WHAT IS KEPT PER UNIT, in three parts under one key, each read alone: the audio in the
// codec's form; the unit's record — its report (duration and word times) and frame count —
// so a voice built over a script reads every kept unit's measurement in one small read
// (`restore`) and a resume lands on its word before any audio is decoded; and its ledger
// entry — its size and when it was last played — which is all the cap ever reads, so a
// write near the cap never loads thousands of word timings to count bytes. A script is kept
// as one entry with its own line in the same ledger, so it counts against the same cap and is
// forgotten by the same rule: a paste whose script is read back is played again.
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
// decodes — is the cache not holding the unit or the script: a miss,
// synthesized as if nothing had been kept, and reported through `onFailure` so it is heard in
// the console. A kept unit is a convenience; a refused store must not take Listen down with it
// (keptPlace.ts makes the same trade for the resume position).

import { bytesOf, type AudioCodec, type EncodedAudio } from "./audioCodec";
import type { UnitReport } from "./speechManifest";
import type { Utterance } from "./speech";
import { scriptHash, unitHash, unitText, type PreparedText, type SynthesisUnit, type UnitText, type VoiceMap } from "./speechScript";
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

// [LAW:one-source-of-truth] A script unit as the device keeps it: the unit less its utterance,
// which is named by its position among the utterances the script was cut from.
export interface KeptScriptUnit extends PreparedText {
  readonly utterance: number;
  readonly start: number;
  readonly end: number;
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
  script(key: string): Promise<ReadonlyArray<KeptScriptUnit> | undefined>;
  // The entry and its script, together or not at all.
  putScript(entry: LedgerEntry, units: ReadonlyArray<KeptScriptUnit>): Promise<void>;
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

// The same utterance: what a unit's utterance is matched on, since the worker's reply carries a
// copy of the page's.
const same = (a: Utterance, b: Utterance): boolean => a.index === b.index && a.anchor === b.anchor && a.voice === b.voice && a.text === b.text;

// A script as the device keeps it. Units come in their utterances' order (deriveSpeechScript),
// so each unit's utterance is the first at or after the previous unit's that matches it; a unit
// whose utterance is not among them is not a script of these utterances, and is thrown.
export const keptScript = (utterances: ReadonlyArray<Utterance>, units: ReadonlyArray<SynthesisUnit>): ReadonlyArray<KeptScriptUnit> => {
  let at = 0;
  return units.map(({ utterance, start, end, text, sourceSpans }) => {
    while (at < utterances.length && !same(utterances[at]!, utterance)) at++;
    if (at === utterances.length) throw new RangeError(`kept audio: a unit of utterance ${utterance.index} is not among the ${utterances.length} it was cut from`);
    return { utterance: at, start, end, text, sourceSpans };
  });
};

// A kept script rebound to the utterances it was cut from; a position they lack is a store
// that no longer holds what was written, and is thrown.
export const recalledScript = (utterances: ReadonlyArray<Utterance>, kept: ReadonlyArray<KeptScriptUnit>): ReadonlyArray<SynthesisUnit> =>
  kept.map(({ utterance: position, start, end, text, sourceSpans }) => {
    const utterance = utterances[position];
    if (utterance === undefined) throw new RangeError(`kept audio: a kept unit names utterance ${position} of ${utterances.length}`);
    return { utterance, start, end, text, sourceSpans };
  });

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
  // The script cut from these utterances when the device holds it; null otherwise. Never rejects.
  readonly recallScript: (utterances: ReadonlyArray<Utterance>) => Promise<ReadonlyArray<SynthesisUnit> | null>;
  // Keeps the script the worker cut from these utterances. Never rejects.
  readonly keepScript: (utterances: ReadonlyArray<Utterance>, units: ReadonlyArray<SynthesisUnit>) => Promise<void>;
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

  // [LAW:single-enforcer] Every write, a unit's or a script's: its turn in the chain, the
  // device's own limit, then the cap. `made` settles what is written — the key, its size and
  // how to put it — and runs in the write's turn; `playedAt` is read at the ask, so a write is
  // played when it was made, not when its turn comes.
  const write = (what: string, made: (store: KeptStore) => Promise<{ readonly key: string; readonly bytes: number; readonly put: (entry: LedgerEntry) => Promise<void> }>): Promise<void> => {
    const playedAt = now();
    writes = writes.then(() =>
      attempt(what, undefined, async (store) => {
        const { key, bytes, put } = await made(store);
        const entry = { key, bytes, playedAt };
        await put(entry).catch(async (error: unknown) => {
          if (!isQuota(error)) throw error;
          const ledger = await store.ledger();
          const gone = evictions(ledger, heldBytes(ledger) / 2);
          if (gone.length === 0) throw error;
          await store.remove(gone);
          await put(entry);
        });
        const gone = evictions(await store.ledger(), cap);
        if (gone.length > 0) await store.remove(gone);
      }),
    );
    return writes;
  };

  const keep = (request: UnitRequest, frames: ReadonlyArray<Float32Array<ArrayBuffer>>, report: UnitReport): Promise<void> =>
    write("keeping a unit", async (store) => {
      const audio = await (await config.codec).encode(frames);
      const record = { report, frames: frames.length };
      return { key: await keyOf(request), bytes: bytesOf(audio), put: (entry) => store.put(entry, record, audio) };
    });

  const recallScript = (utterances: ReadonlyArray<Utterance>): Promise<ReadonlyArray<SynthesisUnit> | null> =>
    attempt("reading a kept script", null, async (store) => {
      const key = await scriptHash(utterances);
      const kept = await store.script(key);
      if (kept === undefined) return null;
      const units = recalledScript(utterances, kept);
      void attempt("marking a kept script played", undefined, (held) => held.touch([key], now()));
      return units;
    });

  // A script's size is its kept form's JSON length: the measure that needs no encoder, and
  // within a small factor of what the store spends on it, since the kept form shares nothing.
  const keepScript = (utterances: ReadonlyArray<Utterance>, units: ReadonlyArray<SynthesisUnit>): Promise<void> =>
    write("keeping a script", async (store) => {
      const kept = keptScript(utterances, units);
      return { key: await scriptHash(utterances), bytes: JSON.stringify(kept).length, put: (entry) => store.putScript(entry, kept) };
    });

  const restore = (script: ReadonlyArray<SynthesisUnit>, voices: VoiceMap): Promise<ReadonlyArray<UnitReport | undefined>> =>
    attempt("restoring kept units", script.map(() => undefined), async (store) => {
      const keys = await Promise.all(script.map((unit) => keyOf({ text: unitText(unit), voice: voices[unit.utterance.voice] })));
      const records = await store.records(keys);
      const held = keys.filter((_, i) => records[i] !== undefined);
      if (held.length > 0) await store.touch(held, now());
      return records.map((record) => record?.report);
    });

  return { find, keep, restore, recallScript, keepScript };
};

// ── the browser's store ──────────────────────────────────────────────────────────────

const DATABASE = "listen-kept-audio";
const LEDGER = "ledger";
const RECORDS = "records";
const AUDIO = "audio";
const SCRIPTS = "scripts";
const STORES = [LEDGER, RECORDS, AUDIO, SCRIPTS];
// Version 1 held units alone; version 2 keeps scripts beside them. An upgrade creates the
// stores the device does not yet have, so every version before is carried forward whole.
const VERSION = 2;

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
    const opening = factory.open(DATABASE, VERSION);
    let refused = false;
    const refuse = (reason: string): void => {
      refused = true;
      clearTimeout(patience);
      reject(new Error(`kept audio: ${reason}`));
    };
    const patience = setTimeout(() => refuse(`the store did not open within ${patienceMs} ms`), patienceMs);
    opening.onupgradeneeded = () => {
      for (const name of STORES) if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name);
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

// [LAW:effects-at-boundaries] The one edge to IndexedDB: four object stores under one
// database — the ledger, the records, the audio and the scripts — each keyed by its entry's
// hash. Opened once per page.
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

  const putScript = async (entry: LedgerEntry, units: ReadonlyArray<KeptScriptUnit>): Promise<void> => {
    const transaction = db.transaction([LEDGER, SCRIPTS], "readwrite");
    transaction.objectStore(SCRIPTS).put(units, entry.key);
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
    script: (key) => settled(db.transaction(SCRIPTS, "readonly").objectStore(SCRIPTS).get(key) as IDBRequest<ReadonlyArray<KeptScriptUnit> | undefined>),
    putScript,
    touch,
    ledger,
    remove,
  };
};
