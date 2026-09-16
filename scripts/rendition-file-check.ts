// The rendition file (slopspot-read-along-a35.8): a rendered paste laid out along its timeline
// and encoded as one file. The layout and the choice of form are driven directly; the WAV form
// is encoded for real (mediabunny needs no WebCodecs for PCM) and read back sample for sample.
// The M4A form needs a browser's AAC encoder and is verified in Chrome.
// Run: `tsx scripts/rendition-file-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about the file's samples, its length and its
// form — what a player would hear — never how the runs are built.

import { AAC_RATES, chooseForm, encodeFile, fileAudio } from "../src/renditionFile";
import type { RenderedUnit } from "../src/synthesisClient";
import { GAP_MS, layoutOf } from "../src/timeline";
import { MODEL_PCM } from "../src/unitPlayer";
import { FRAME_MS } from "../src/modelAssets";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const { sampleRate, frameSamples } = MODEL_PCM;
// A frame whose every sample names its unit and its frame, so a sample read back says where
// in the paste it came from.
const level = (unitId: number, frame: number): number => ((unitId + 1) * 1000 + frame) / 32767;
const made = (unitId: number, frames: number): RenderedUnit => ({
  kind: "made",
  unitId,
  frames: Array.from({ length: frames }, (_, frame) => new Float32Array(frameSamples).fill(level(unitId, frame))),
});
const unitsOf = (...units: RenderedUnit[]): ReadonlyMap<number, RenderedUnit> => new Map(units.map((unit) => [unit.unitId, unit]));

// Two turns: units 0 and 1 are the user's, units 2 and 3 the assistant's — a gap before unit 2.
const layout = layoutOf(["t0", "t0", "t1", "t1"]);
const gapSamples = (GAP_MS * sampleRate) / 1000;

console.log("the file's audio: the timeline, slot by slot");
{
  const audio = fileAudio(layout, unitsOf(made(0, 3), made(1, 2), made(2, 4), made(3, 1)), MODEL_PCM);
  assert("one run per slot, in the layout's order: four units and the gap between the turns", audio.runs.map((run) => run.length).join() === [3 * frameSamples, 2 * frameSamples, gapSamples, 4 * frameSamples, frameSamples].join());
  const total = audio.runs.reduce((sum, run) => sum + run.length, 0);
  assert("its length is the timeline's: every unit's frames and the gap", (total / sampleRate) * 1000 === (3 + 2 + 4 + 1) * FRAME_MS + GAP_MS && audio.missing.length === 0);
  assert("a unit is its frames end to end, and a gap is silence", audio.runs[0]?.[frameSamples] === Math.fround(level(0, 1)) && audio.runs[1]?.[2 * frameSamples - 1] === Math.fround(level(1, 1)) && audio.runs[2]?.every((x) => x === 0) === true);
}
{
  const failed: RenderedUnit = { kind: "failed", unitId: 1, reason: { kind: "frame-cap", frames: 500 } };
  const audio = fileAudio(layout, unitsOf(made(0, 3), failed, made(2, 4), made(3, 1)), MODEL_PCM);
  assert("a failed unit is left out as playback skips it, the gap after it kept, and it is named", audio.runs.map((run) => run.length).join() === [3 * frameSamples, gapSamples, 4 * frameSamples, frameSamples].join() && audio.missing.join() === "1");
}
{
  let thrown = "";
  try {
    fileAudio(layout, unitsOf(made(0, 3), made(1, 2), made(3, 1)), MODEL_PCM);
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  }
  assert("a unit never rendered is an unfinished render: thrown, never a silence", thrown.includes("unit 2"));
}

console.log("the form: M4A where the browser encodes AAC, WAV otherwise");
{
  const asked: number[] = [];
  const at = (rates: ReadonlyArray<number>) => (rate: number) => {
    asked.push(rate);
    return Promise.resolve(rates.includes(rate));
  };
  assert("AAC at 48 kHz: M4A at 48 kHz, nothing more asked", JSON.stringify(await chooseForm(at([48_000, 44_100]))) === JSON.stringify({ container: "m4a", sampleRate: 48_000 }) && asked.join() === "48000");
  assert("AAC at 44.1 kHz only: M4A at 44.1 kHz", JSON.stringify(await chooseForm(at([44_100]))) === JSON.stringify({ container: "m4a", sampleRate: 44_100 }));
  asked.length = 0;
  assert("no AAC at any rate: WAV, every rate asked first", JSON.stringify(await chooseForm(at([24_000]))) === JSON.stringify({ container: "wav" }) && asked.join() === AAC_RATES.join());
}

console.log("the WAV form, encoded and read back");
{
  const audio = fileAudio(layout, unitsOf(made(0, 3), made(1, 2), made(2, 4), made(3, 1)), MODEL_PCM);
  const progress: number[] = [];
  const file = await encodeFile(audio, MODEL_PCM, { container: "wav" }, (fraction) => progress.push(fraction));
  const view = new DataView(file.bytes);
  const tag = (at: number): string => String.fromCharCode(...new Uint8Array(file.bytes, at, 4));
  assert("a RIFF WAVE file, named as one", tag(0) === "RIFF" && tag(8) === "WAVE" && file.extension === ".wav" && file.mimeType === "audio/wav");
  // The fmt chunk follows the RIFF header; the data chunk is found by walking the chunks.
  let at = 12;
  const chunks = new Map<string, { offset: number; size: number }>();
  while (at + 8 <= file.bytes.byteLength) {
    const size = view.getUint32(at + 4, true);
    chunks.set(tag(at), { offset: at + 8, size });
    at += 8 + size + (size % 2);
  }
  const fmt = chunks.get("fmt ");
  const data = chunks.get("data");
  assert("mono, 16-bit, at the model's rate", fmt !== undefined && view.getUint16(fmt.offset, true) === 1 && view.getUint16(fmt.offset + 2, true) === 1 && view.getUint32(fmt.offset + 4, true) === sampleRate && view.getUint16(fmt.offset + 14, true) === 16);
  const samples = data === undefined ? new Int16Array(0) : new Int16Array(file.bytes.slice(data.offset, data.offset + data.size));
  const total = audio.runs.reduce((sum, run) => sum + run.length, 0);
  assert("exactly the timeline's length", samples.length === total && (samples.length / sampleRate) * 1000 === (3 + 2 + 4 + 1) * FRAME_MS + GAP_MS);
  const s16 = (unitId: number, frame: number): number => Math.round(level(unitId, frame) * 32767);
  const joinOf = 3 * frameSamples;
  assert("a unit join is the two units' own samples side by side, nothing between", samples[joinOf - 1] === s16(0, 2) && samples[joinOf] === s16(1, 0));
  const gapAt = 5 * frameSamples;
  assert("the gap is silence to the sample, and the next turn starts on its first", samples[gapAt - 1] === s16(1, 1) && samples.subarray(gapAt, gapAt + gapSamples).every((x) => x === 0) && samples[gapAt + gapSamples] === s16(2, 0));
  assert("progress rises to the whole", progress.length === audio.runs.length && progress.every((p, i) => i === 0 || p > progress[i - 1]!) && progress[progress.length - 1] === 1);
}

console.log(process.exitCode === 1 ? "rendition-file-check: FAILED" : "rendition-file-check: ok");
