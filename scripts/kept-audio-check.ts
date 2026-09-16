// Kept audio over an in-memory store and the PCM codec: what the device keeps of a unit, what
// it gives back, what it forgets under the cap, and what a failing store does to a listen
// (slopspot-read-along-a35.6.5zr, slopspot-read-along-a35.6.rub). Run: `tsx scripts/kept-audio-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what `find`, `holds`, `keep` and `restore`
// answer and which units survive the cap — never about how the store is laid out.
//
// ─── ACCEPT TABLE ────────────────────────────────────────────────────────────────
//   keep, then find the same request      -> the frames (to 16-bit precision) and the report
//   find in another voice or text         -> null
//   find or holds while a keep encodes    -> waits for it: found, held
//   holds                                 -> whether the unit is kept; the unit not made recent
//   restore over a script                 -> each unit's kept report, index for index, in the voices given
//   a write past the cap                  -> the least recently played units removed until it holds
//   find or restore of a unit             -> the unit is recent again
//   two keeps at once                     -> the second counts the store the first left
//   a write the device refuses for room   -> the least recently played half removed, the write kept
//   refused again                         -> reported, nothing kept
//   keep a script, then recall it         -> the same units, over the utterances asked with; another paste's -> null
//   a script's size                       -> linear in its passage, never the passage once per unit
//   a script not cut from its utterances  -> reported, nothing kept
//   a script under the cap                -> counted and forgotten by the same ledger as units
//   a store that never opens              -> find null, keep settles, restore nothing; each failure reported
//   an open another tab blocks            -> refused, and the connection closed if it opens later
//   an open the browser never answers     -> refused once its patience runs out
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

console.log("a read after a keep");
{
  const { store, ledger } = memoryStore();
  // A codec whose encode takes several turns, as Opus through WebCodecs does.
  const slow: AudioCodec = { ...pcm, encode: async (frames) => {
    for (let i = 0; i < 5; i++) await flush();
    return pcm.encode(frames);
  } };
  const { cache, clock } = cacheOver(Promise.resolve(store), { codec: slow });
  const [zero, one] = script;
  if (zero === undefined || one === undefined) throw new Error("fixture: no units");
  clock.now = 7;
  void cache.keep(requestOf(zero), framesOf(2, 0), report(160));
  assert("asked while the keep is still encoding: found, and held", (await cache.find(requestOf(zero))) !== null && (await cache.holds(requestOf(zero))) === true);
  assert("a unit never kept: not held", (await cache.holds(requestOf(one))) === false && (await cache.holds(requestOf(zero, { ...VOICES, assistant: "azelma" }))) === false);
  await flush();
  clock.now = 9;
  await cache.holds(requestOf(zero));
  assert("asking whether a unit is held does not play it", [...ledger.values()].every((entry) => entry.playedAt === 7));
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

console.log("scripts");
{
  const { store, ledger } = memoryStore();
  const { cache, clock } = cacheOver(Promise.resolve(store), { cap: 2 * UNIT_BYTES });
  const said = script.map((unit) => unit.utterance);
  assert("nothing kept: no script", (await cache.recallScript(said)) === null);
  clock.now = 1;
  await cache.keepScript(said, script);
  const asked = said.map((u) => ({ ...u }));
  const recalled = await cache.recallScript(asked);
  assert("kept: the same units back", JSON.stringify(recalled) === JSON.stringify(script));
  assert("each over the very utterance it was asked with", recalled !== null && recalled.every((unit, i) => unit.utterance === asked[i]));
  assert("another paste's utterances: no script", (await cache.recallScript([...said, { index: 9, anchor: "t9", voice: "user", text: "More." }])) === null);
  clock.now = 2;
  await flush();
  const [zero, one] = script;
  if (zero === undefined || one === undefined) throw new Error("fixture: no units");
  clock.now = 3;
  await cache.keep(requestOf(zero), framesOf(2, 0), report(160));
  clock.now = 4;
  await cache.keep(requestOf(one), framesOf(2, 1), report(160));
  assert("the script has its line in the ledger, and is forgotten first when it was played longest ago", ledger.size === 2 && (await cache.recallScript(said)) === null && (await cache.find(requestOf(zero))) !== null);
}

console.log("a script's size");
{
  // One utterance of `sentences` sentences, a unit each: the shape a long turn is cut into.
  const passage = (sentences: number) => {
    const text = Array.from({ length: sentences }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const utterance = { index: 0, anchor: "t0", voice: "assistant" as const, text };
    let start = 0;
    const units = text.split(/(?<=\.) /).map((sentence): SynthesisUnit => {
      const unit = { utterance, start, end: start + sentence.length, ...prepareText(sentence) };
      start += sentence.length + 1;
      return unit;
    });
    return { utterances: [utterance], units };
  };
  const bytesOf = async (sentences: number): Promise<number> => {
    const { store, ledger } = memoryStore();
    const { cache } = cacheOver(Promise.resolve(store));
    const { utterances, units } = passage(sentences);
    await cache.keepScript(utterances, units);
    const recalled = await cache.recallScript(utterances);
    if (JSON.stringify(recalled) !== JSON.stringify(units)) throw new Error("fixture: the passage did not come back");
    return [...ledger.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  };
  const [short, long] = [await bytesOf(200), await bytesOf(800)];
  assert("four times the passage is about four times the bytes, not sixteen", long > 3 * short && long < 5 * short);
}

console.log("a script not cut from its utterances");
{
  const { store, ledger } = memoryStore();
  const { cache, failures } = cacheOver(Promise.resolve(store));
  await cache.keepScript([{ index: 7, anchor: "t7", voice: "user", text: "Elsewhere." }], script);
  assert("reported, nothing kept", failures.join() === "keeping a script" && ledger.size === 0);
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

// The one part of IndexedDB's open request the store listens to, fired by hand.
const handOpened = () => {
  const opening = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: { closed: false, close() { this.closed = true; } } } as unknown as {
    onsuccess: () => void;
    onblocked: () => void;
    result: { closed: boolean };
  };
  return { opening, factory: { open: () => opening } as unknown as IDBFactory };
};

console.log("an open another tab blocks");
{
  const { opening, factory } = handOpened();
  const store = openKeptStore(factory);
  opening.onblocked();
  const refused = await store.then(() => false, () => true);
  assert("a blocked open is a store that failed, not one that waits", refused);
  opening.onsuccess();
  assert("the open that succeeds after it was refused is closed at once", opening.result.closed);
}

console.log("an open the browser never answers");
{
  const { factory } = handOpened();
  const refused = await openKeptStore(factory, 10).then(() => false, () => true);
  assert("refused once its patience runs out, not waited on forever", refused);
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
