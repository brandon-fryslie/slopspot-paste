// Kept audio over an in-memory store and the PCM codec: what the device keeps of a unit, what
// it gives back, what it forgets under the cap, and what a failing store does to a listen
// (slopspot-read-along-a35.6.5zr). Run: `tsx scripts/kept-audio-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what `find`, `keep` and `restore`
// answer and which units survive the cap — never about how the store is laid out.
//
// ─── ACCEPT TABLE ────────────────────────────────────────────────────────────────
//   keep, then find the same request      -> the frames (to 16-bit precision) and the report
//   find in another voice or text         -> null
//   restore over a script                 -> each unit's kept report, index for index, in the voices given
//   a write past the cap                  -> the least recently played units removed until it holds
//   find or restore of a unit             -> the unit is recent again
//   two keeps at once                     -> the second counts the store the first left
//   a write the device refuses for room   -> the least recently played half removed, the write kept
//   refused again                         -> reported, nothing kept
//   a store that never opens              -> find null, keep settles, restore nothing; each failure reported
//   an open another tab blocks            -> refused, and the connection closed if it opens later
//   an entry that no longer decodes       -> null, reported
//   evictions                             -> oldest first, the key breaking a tie; nothing under the cap

import { createCodec, type AudioCodec } from "../src/audioCodec";
import { createAudioCache, evictions, openKeptStore, type KeptStore, type LedgerEntry } from "../src/keptAudio";
import type { UnitReport } from "../src/speechManifest";
import { prepareText, unitText, type SynthesisUnit, type VoiceMap } from "../src/speechScript";
import { MODEL_PCM } from "../src/unitPlayer";
import { memoryStore } from "./keptStoreStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const VOICES: VoiceMap = { user: "alba", assistant: "marius", system: "javert", narrator: "fantine" };
const unitOf = (index: number, text: string): SynthesisUnit => ({
  utterance: { index, anchor: `t${index}`, voice: index % 2 === 0 ? "assistant" : "user", text },
  start: 0,
  end: text.length,
  ...prepareText(text),
});
const script = [unitOf(0, "Hello there."), unitOf(1, "General Kenobi."), unitOf(2, "You are a bold one."), unitOf(3, "Kill him.")];
const requestOf = (unit: SynthesisUnit, voices: VoiceMap = VOICES) => ({ text: unitText(unit), voice: voices[unit.utterance.voice] });
const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });
// `count` frames of a ramp that 16 bits keeps to within one step.
const framesOf = (count: number, seed: number): Float32Array<ArrayBuffer>[] =>
  Array.from({ length: count }, (_, f) => Float32Array.from({ length: MODEL_PCM.frameSamples }, (_, i) => Math.sin(seed + f + i / 100) * 0.5));
const close = (a: ReadonlyArray<Float32Array>, b: ReadonlyArray<Float32Array>): boolean =>
  a.length === b.length && a.every((frame, f) => frame.length === b[f]?.length && frame.every((x, i) => Math.abs(x - (b[f]?.[i] ?? Number.NaN)) <= 1 / 32767));

const pcm = createCodec("pcm-s16", MODEL_PCM);
// A unit of two 16-bit PCM frames is 7 680 bytes: the caps below count in it.
const UNIT_BYTES = 2 * MODEL_PCM.frameSamples * 2;

const cacheOver = (store: Promise<KeptStore>, options: { cap?: number; codec?: AudioCodec } = {}) => {
  const clock = { now: 0 };
  const failures: string[] = [];
  const cache = createAudioCache({
    store,
    codec: Promise.resolve(options.codec ?? pcm),
    now: () => clock.now,
    cap: options.cap ?? Number.MAX_SAFE_INTEGER,
    onFailure: (what) => failures.push(what),
  });
  return { cache, clock, failures };
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── the round trip ────────────────────────────────────────────────────────────────────

console.log("keep and find");
{
  const { store } = memoryStore();
  const { cache } = cacheOver(Promise.resolve(store));
  const [first] = script;
  if (first === undefined) throw new Error("fixture: no unit");
  assert("nothing kept: a miss", (await cache.find(requestOf(first))) === null);
  const frames = framesOf(3, 1);
  await cache.keep(requestOf(first), frames, report(240));
  const found = await cache.find(requestOf(first));
  assert("kept: the same frames back, to 16-bit precision, and the report", found !== null && close(found.frames, frames) && found.report.durationMs === 240);
  assert("the same text in another voice is another unit: a miss", (await cache.find(requestOf(first, { ...VOICES, assistant: "azelma" }))) === null);
  assert("another text in the same voice: a miss", (await cache.find({ ...requestOf(first), text: { ...unitText(first), text: "Hello there!" } })) === null);
}

console.log("restore");
{
  const { store } = memoryStore();
  const { cache, clock } = cacheOver(Promise.resolve(store));
  const [zero, one, two] = script;
  if (zero === undefined || one === undefined || two === undefined) throw new Error("fixture: no units");
  await cache.keep(requestOf(zero), framesOf(2, 0), report(160));
  await cache.keep(requestOf(two), framesOf(2, 2), report(160));
  clock.now = 50;
  const restored = await cache.restore(script, VOICES);
  assert("each unit's kept report, index for index, undefined where none", restored.length === script.length && restored[0]?.durationMs === 160 && restored[1] === undefined && restored[2]?.durationMs === 160);
  const ledger = await store.ledger();
  assert("the restored units are recent again", ledger.every((entry) => entry.playedAt === 50));
  const revoiced = await cache.restore(script, { ...VOICES, assistant: "azelma" });
  assert("in another voice for their role, the same units are not kept", revoiced.every((kept) => kept === undefined));
}

// ── the cap ───────────────────────────────────────────────────────────────────────────

console.log("the cap");
{
  const { store, ledger } = memoryStore();
  const { cache, clock } = cacheOver(Promise.resolve(store), { cap: 2 * UNIT_BYTES });
  const [zero, one, two] = script;
  if (zero === undefined || one === undefined || two === undefined) throw new Error("fixture: no units");
  clock.now = 1;
  await cache.keep(requestOf(zero), framesOf(2, 0), report(160));
  clock.now = 2;
  await cache.keep(requestOf(one), framesOf(2, 1), report(160));
  assert("two units fit the cap", ledger.size === 2);
  clock.now = 3;
  assert("playing the older unit makes it recent", (await cache.find(requestOf(zero))) !== null);
  await flush();
  clock.now = 4;
  await cache.keep(requestOf(two), framesOf(2, 2), report(160));
  assert("a third unit crosses the cap: the least recently played goes, and only it", ledger.size === 2 && (await cache.find(requestOf(one))) === null && (await cache.find(requestOf(zero))) !== null && (await cache.find(requestOf(two))) !== null);
  const bytes = [...ledger.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  assert("the store holds the cap", bytes <= 2 * UNIT_BYTES);
}

console.log("keeps at once");
{
  const { store, ledger } = memoryStore();
  const { cache, clock } = cacheOver(Promise.resolve(store), { cap: UNIT_BYTES });
  const [zero, one] = script;
  if (zero === undefined || one === undefined) throw new Error("fixture: no units");
  clock.now = 1;
  const first = cache.keep(requestOf(zero), framesOf(2, 0), report(160));
  clock.now = 2;
  const second = cache.keep(requestOf(one), framesOf(2, 1), report(160));
  await Promise.all([first, second]);
  assert("the second write counts the store the first left: one unit, the later one", ledger.size === 1 && (await cache.find(requestOf(one))) !== null);
}

console.log("the device's own limit");
{
  const { store, ledger } = memoryStore({ room: 3 * UNIT_BYTES });
  const { cache, clock, failures } = cacheOver(Promise.resolve(store));
  const [zero, one, two, three] = script;
  if (zero === undefined || one === undefined || two === undefined || three === undefined) throw new Error("fixture: no units");
  for (const [at, unit] of [zero, one, two].entries()) {
    clock.now = at + 1;
    await cache.keep(requestOf(unit), framesOf(2, at), report(160));
  }
  clock.now = 4;
  await cache.keep(requestOf(three), framesOf(2, 3), report(160));
  const kept = await Promise.all(script.map(async (unit) => (await cache.find(requestOf(unit))) !== null));
  assert("a write refused under the cap: the least recently played half goes, and the write is kept", kept.join() === "false,false,true,true" && ledger.size === 2);
  assert("nothing to report: the cache kept keeping", failures.length === 0);
}
{
  const { store, ledger } = memoryStore({ room: UNIT_BYTES / 2 });
  const { cache, failures } = cacheOver(Promise.resolve(store));
  const [zero] = script;
  if (zero === undefined) throw new Error("fixture: no unit");
  await cache.keep(requestOf(zero), framesOf(2, 0), report(160));
  assert("refused with nothing left to free: reported, nothing kept", failures.join() === "keeping a unit" && ledger.size === 0);
}

// ── failure ───────────────────────────────────────────────────────────────────────────

console.log("a store that never opens");
{
  const { cache, failures } = cacheOver(Promise.reject(new Error("private mode")));
  const [zero] = script;
  if (zero === undefined) throw new Error("fixture: no unit");
  assert("find is a miss", (await cache.find(requestOf(zero))) === null);
  await cache.keep(requestOf(zero), framesOf(1, 0), report(80));
  assert("keep settles", true);
  const restored = await cache.restore(script, VOICES);
  assert("restore keeps nothing, index for index", restored.length === script.length && restored.every((kept) => kept === undefined));
  assert("each failure is reported by what it was doing", failures.join() === "reading a kept unit,keeping a unit,restoring kept units");
}

console.log("an open another tab blocks");
{
  // The one part of IndexedDB's open request the store listens to, fired by hand.
  const opening = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: { closed: false, close() { this.closed = true; } } } as unknown as {
    onsuccess: () => void;
    onblocked: () => void;
    result: { closed: boolean };
  };
  const factory = { open: () => opening } as unknown as IDBFactory;
  const store = openKeptStore(factory);
  opening.onblocked();
  const refused = await store.then(() => false, () => true);
  assert("a blocked open is a store that failed, not one that waits", refused);
  opening.onsuccess();
  assert("the open that succeeds after it was refused is closed at once", opening.result.closed);
}

console.log("an entry that no longer decodes");
{
  const { store } = memoryStore();
  const broken: AudioCodec = { encode: pcm.encode, decode: () => Promise.reject(new Error("no Opus decoder")) };
  const { cache, failures } = cacheOver(Promise.resolve(store), { codec: broken });
  const [zero] = script;
  if (zero === undefined) throw new Error("fixture: no unit");
  await cache.keep(requestOf(zero), framesOf(1, 0), report(80));
  assert("a miss, reported", (await cache.find(requestOf(zero))) === null && failures.join() === "reading a kept unit");
}

// ── the policy ────────────────────────────────────────────────────────────────────────

console.log("evictions");
{
  const ledger: LedgerEntry[] = [
    { key: "b", bytes: 10, playedAt: 5 },
    { key: "a", bytes: 10, playedAt: 5 },
    { key: "c", bytes: 10, playedAt: 1 },
    { key: "d", bytes: 10, playedAt: 9 },
  ];
  assert("under the cap: nothing", evictions(ledger, 40).length === 0);
  assert("over it: oldest first, the key breaking a tie, until it holds", evictions(ledger, 15).join() === "c,a,b");
}
