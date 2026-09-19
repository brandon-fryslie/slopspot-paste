// A cloned voice (slopspot-voices-9p4.8j6): a recording becomes a clone named by its content,
// the device keeps clones as the recording itself and reads them back, a refused save is
// reported, a record this build did not write reads as none, and the recording plays back as
// a WAV. Run: `tsx scripts/cloned-voice-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what a reader would find on the next
// visit and what the model would be fed — never how the string is laid out.

import { CLONES_KEY, CLONE_SAMPLES, cloneVoice, isClonedKey, readClones, toFloat, wavOf, withClone, withoutClone, writeClones, type ClonedVoice } from "../src/clonedVoice";
import { SAMPLE_RATE } from "../src/modelAssets";
import type { PreferenceStore } from "../src/preferenceStore";
import { memoryPreferences, refusedPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// A second of a 440 Hz tone at the model's rate, at half scale, `seconds` long.
const tone = (seconds: number, scale = 0.5): Float32Array => Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => scale * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));

const sameSamples = (a: Int16Array, b: Int16Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

console.log("a recording becomes a clone");
{
  const voice = await cloneVoice("  Brandon  ", tone(2));
  assert("the name is trimmed", voice.name === "Brandon");
  assert("the key is a content hash under the clone prefix", isClonedKey(voice.key));
  assert("the samples are the recording, in 16 bits, every one", voice.samples.length === 2 * SAMPLE_RATE && Math.abs(toFloat(voice.samples)[SAMPLE_RATE / 4 / 440 | 0]! - tone(2)[SAMPLE_RATE / 4 / 440 | 0]!) < 1e-3);
  const again = await cloneVoice("Someone else", tone(2));
  assert("the same recording is the same key whatever it is named", again.key === voice.key);
  const other = await cloneVoice("Brandon", tone(2, 0.4));
  assert("a different recording is another key", other.key !== voice.key);
  const long = await cloneVoice("Long", tone(14));
  assert("a recording longer than a clone is cut to a clone's length", long.samples.length === CLONE_SAMPLES);
  const named = await cloneVoice("", tone(2));
  assert("no name is 'My voice'", named.name === "My voice");
  let refused = "";
  try {
    await cloneVoice("Blip", tone(0.4));
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  assert("less than a second is refused with the length and the least a voice needs", refused.includes("0.4 s") && refused.includes("at least 1 s"));
  const loud = await cloneVoice("Loud", Float32Array.from([2, -2, 0.5, ...tone(1)]));
  assert("samples beyond full scale are clipped, not wrapped", loud.samples[0] === 32767 && loud.samples[1] === -32767);
}

console.log("the device keeps clones as the recording, and reads them back");
{
  const store = memoryPreferences();
  const a = await cloneVoice("A", tone(1.5));
  const b = await cloneVoice("B", tone(1.5, 0.3));
  assert("a device that never cloned keeps none, with nothing stored", readClones(store).length === 0 && store.keys().length === 0);
  assert("a clone kept is reported kept", writeClones(store, withClone([], a)).kind === "kept");
  const back = readClones(store);
  assert("and read back whole: its key, its name, every sample", back.length === 1 && back[0]?.key === a.key && back[0]?.name === "A" && sameSamples(back[0]!.samples, a.samples));
  writeClones(store, withClone(readClones(store), b));
  assert("a second clone joins the first, in order", readClones(store).map((c) => c.name).join() === "A,B");
  writeClones(store, withClone(readClones(store), { ...a, name: "A renamed" }));
  assert("a clone under a key already kept replaces it: one voice, the newer name, at the end", readClones(store).map((c) => c.name).join() === "B,A renamed");
  writeClones(store, withoutClone(readClones(store), b.key));
  assert("a clone removed is gone, the rest kept", readClones(store).map((c) => c.key).join() === a.key);
  writeClones(store, withoutClone(readClones(store), a.key));
  assert("the last clone removed is the key removed: a device that forgot them all and a fresh one are the same device", store.keys().length === 0 && readClones(store).length === 0);
  assert("the one key", (writeClones(store, [a]), store.keys().join() === CLONES_KEY));
}

console.log("a refused save is said, not silent");
{
  const a = await cloneVoice("A", tone(1.5));
  assert("a browser that refuses site storage: nothing kept, said so, no throw", writeClones(refusedPreferences(), [a]).kind === "refused" && readClones(refusedPreferences()).length === 0);
  // A store with room for one clone and not two: the second write is dropped, as a full
  // localStorage drops it (deviceStore swallows the QuotaExceededError).
  const held = new Map<string, string>();
  const small: PreferenceStore = {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      if (value.length < 200_000) held.set(key, value);
    },
    removeItem: (key) => void held.delete(key),
  };
  assert("a save the device has room for is kept", writeClones(small, [a]).kind === "kept");
  const crowd = await Promise.all([1, 2, 3].map((n) => cloneVoice(`C${n}`, tone(2, n / 10))));
  assert("a save the device has no room for is refused, and what it held before is still held", writeClones(small, crowd).kind === "refused" && readClones(small).map((c) => c.name).join() === "A");
}

console.log("a record this build did not write reads as none");
{
  const a = await cloneVoice("A", tone(1.5));
  const store = memoryPreferences();
  writeClones(store, [a]);
  const kept = JSON.parse(store.getItem(CLONES_KEY) ?? "[]") as Array<Record<string, unknown>>;
  const junk: unknown[] = [
    "not json",
    JSON.stringify({ key: a.key }),
    JSON.stringify([{ ...kept[0], key: "clone:nothex" }]),
    JSON.stringify([{ ...kept[0], name: 7 }]),
    JSON.stringify([{ ...kept[0], pcm: "###" }]),
    JSON.stringify([{ ...kept[0], pcm: "" }]),
    JSON.stringify([{ ...kept[0], pcm: btoa("x".repeat(2 * CLONE_SAMPLES + 2)) }]),
    JSON.stringify([7, null, "x"]),
  ];
  for (const raw of junk) {
    store.setItem(CLONES_KEY, raw as string);
    assert(`${JSON.stringify(raw).slice(0, 48)}… reads as none`, readClones(store).length === 0);
  }
  store.setItem(CLONES_KEY, JSON.stringify([kept[0], { ...kept[0], key: "clone:nothex" }]));
  assert("one good record beside a bad one: the good one is read, the bad one is not", readClones(store).length === 1 && readClones(store)[0]?.key === a.key);
}

console.log("the recording plays back as a WAV");
{
  const a = await cloneVoice("A", tone(1));
  const wav = wavOf(a.samples);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, n: number): string => String.fromCharCode(...wav.subarray(at, at + n));
  assert("RIFF/WAVE, 16-bit mono PCM at the model's rate", ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE" && view.getUint16(22, true) === 1 && view.getUint32(24, true) === SAMPLE_RATE && view.getUint16(34, true) === 16);
  assert("the data chunk is every sample, and the sizes agree", view.getUint32(40, true) === a.samples.byteLength && wav.byteLength === 44 + a.samples.byteLength && view.getUint32(4, true) === wav.byteLength - 8);
  assert("the samples follow the header unchanged", sameSamples(new Int16Array(wav.buffer.slice(44)), a.samples));
}

const voice: ClonedVoice = await cloneVoice("type", tone(1));
assert("a clone's samples are the model's rate in 16 bits, and its key its content", voice.samples instanceof Int16Array && voice.key.length === "clone:".length + 64);

console.log(process.exitCode ? "\ncloned-voice-check: FAILED" : "\ncloned-voice-check: all assertions passed");
