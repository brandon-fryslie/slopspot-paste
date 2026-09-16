// The audio codec's pure half and its PCM form: what comes back is exactly the frames asked
// for, whatever the codec did to the length (slopspot-read-along-a35.6.5zr). The Opus form
// needs WebCodecs and is verified in the browser. Run: `tsx scripts/audio-codec-check.ts`.
//
// ─── ACCEPT TABLE ────────────────────────────────────────────────────────────────
//   PCM encode, decode             -> the frames back to 16-bit precision, the bytes two per sample
//   decoded samples too many       -> cut to the frame count
//   decoded samples too few        -> the last frame padded with zeros
//   a decoder at twice the rate    -> every other sample
//   samples past full scale        -> clamped, never wrapped

import { bytesOf, createCodec, decimated, framed, fromS16, toS16 } from "../src/audioCodec";
import { MODEL_PCM } from "../src/unitPlayer";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const FS = MODEL_PCM.frameSamples;
const ramp = (length: number): Float32Array<ArrayBuffer> => Float32Array.from({ length }, (_, i) => ((i % 200) - 100) / 101);

console.log("the PCM form");
{
  const codec = createCodec("pcm-s16", MODEL_PCM);
  const frames = [ramp(FS), ramp(FS).map((x) => -x)];
  const kept = await codec.encode(frames);
  assert("two bytes a sample", kept.codec === "pcm-s16" && bytesOf(kept) === 2 * 2 * FS);
  const back = await codec.decode(kept, 2);
  assert("the same frames back, to 16-bit precision", back.length === 2 && back.every((frame, f) => frame.length === FS && frame.every((x, i) => Math.abs(x - (frames[f]?.[i] ?? Number.NaN)) <= 1 / 32767)));
  assert("past full scale is clamped, not wrapped", Array.from(fromS16(toS16(Float32Array.from([1.5, -1.5])))).join() === "1,-1");
}

console.log("framing");
{
  const long = framed(ramp(2 * FS + 37), 2, MODEL_PCM);
  assert("too many samples: cut to the frame count", long.length === 2 && long.every((frame) => frame.length === FS) && long[1]?.[FS - 1] === ramp(2 * FS)[2 * FS - 1]);
  const short = framed(ramp(FS + 10), 2, MODEL_PCM);
  assert("too few: the last frame zero after the samples", short.length === 2 && short[1]?.[9] === ramp(FS + 10)[FS + 9] && short[1]?.subarray(10).every((x) => x === 0) === true);
  assert("a decoder at twice the rate: every other sample", Array.from(decimated(Float32Array.from([1, 2, 3, 4, 5]), 2)).join() === "1,3" && decimated(ramp(4), 1).length === 4);
}
