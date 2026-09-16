// [LAW:decomposition] The rendition file: a rendered paste's audio as one file a stock player
// opens. One sentence, no "and" hiding a second job: this module lays rendered units out along
// the timeline and encodes them. It makes no unit (keptSynthesis.ts renders them), saves no
// file (the page hands the bytes to the browser) and plays nothing.
//
// THE FILE IS THE TIMELINE [LAW:one-source-of-truth]. The audio runs slot by slot along the
// same layout the player plays (timeline.ts): a speech slot is its unit's frames end to end,
// a silence slot GAP_MS of zeros. A unit that failed is left out exactly as playback skips it
// — the gap beside it still sounds — and is named, so the page can say what the file lacks
// [LAW:no-silent-failure]. So the file's length is the listen's, and a unit join is two
// frames the model made laid sample against sample, with nothing between them to click.
// This is the one place the units are stitched into a single stream; playback never is.
//
// WHICH FORM [LAW:no-mode-explosion]. One ordered choice, made at the tap: M4A (AAC) where the
// browser can encode AAC — the compressed form every stock player opens — and WAV (16-bit PCM)
// otherwise. AAC has no 24 kHz encoder in Chrome (measured 2026-09-16: 44.1 kHz yes, 24 kHz
// no), so the samples are resampled to the first rate the browser encodes. Muxing and
// resampling are mediabunny's (MPL-2.0): an MP4's encoder delay needs an edit list to keep the
// file's length exact, and that is a container's craft, not this program's. The library is
// imported when a file is made, never with the page.

import type { AudioSample, AudioSampleSource } from "mediabunny";
import { joined } from "./audioCodec";
import type { RenderedUnit } from "./synthesisClient";
import type { Slot } from "./timeline";
import { silenceSamples, type PcmFormat } from "./unitPlayer";

// ── the pure half ─────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] The file's audio: one run of samples per slot that sounds, in
// the layout's order, and the units left out because they failed.
export interface FileAudio {
  readonly runs: ReadonlyArray<Float32Array<ArrayBuffer>>;
  readonly missing: ReadonlyArray<number>;
}

// The layout's slots as the file's runs, from every unit of the rendition, rendered.
// [LAW:parse-dont-validate] A slot whose unit was never rendered is a render that is not
// finished: a caller's bug, thrown, never a silence.
export const fileAudio = (layout: ReadonlyArray<Slot>, units: ReadonlyMap<number, RenderedUnit>, format: PcmFormat): FileAudio => {
  const runs: Float32Array<ArrayBuffer>[] = [];
  const missing: number[] = [];
  for (const slot of layout) {
    if (slot.kind === "silence") {
      runs.push(new Float32Array(silenceSamples(slot, format)));
      continue;
    }
    const unit = units.get(slot.span);
    if (unit === undefined) throw new RangeError(`rendition file: unit ${slot.span} was never rendered`);
    if (unit.kind === "failed") missing.push(slot.span);
    else runs.push(joined(unit.frames));
  }
  return { runs, missing };
};

// ── the form ──────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] The two forms, each with what encoding it needs.
export type FileForm = { readonly container: "m4a"; readonly sampleRate: number } | { readonly container: "wav" };

// The AAC rates worth trying, best first: 48 kHz is an exact multiple of the model's 24 kHz.
export const AAC_RATES: ReadonlyArray<number> = [48_000, 44_100];
// Speech from a 24 kHz model, mono: 64 kbps AAC carries all of it.
export const AAC_BITRATE = 64_000;

// [LAW:single-enforcer] The one choice of form. `canEncodeAac` is the browser's word on AAC at
// a rate, taken as a parameter so the check drives every arm.
export const chooseForm = async (canEncodeAac: (sampleRate: number) => Promise<boolean>): Promise<FileForm> => {
  for (const sampleRate of AAC_RATES) {
    if (await canEncodeAac(sampleRate)) return { container: "m4a", sampleRate };
  }
  return { container: "wav" };
};

// ── the browser half ──────────────────────────────────────────────────────────────────

export interface AudioFile {
  readonly bytes: ArrayBuffer;
  readonly extension: string;
  readonly mimeType: string;
}

type Mediabunny = typeof import("mediabunny");

// This browser's form, asked of mediabunny.
export const browserForm = async (): Promise<FileForm> => {
  const { canEncodeAudio, Quality } = await import("mediabunny");
  return chooseForm((sampleRate) => canEncodeAudio("aac", { numberOfChannels: 1, sampleRate, quality: new Quality(AAC_BITRATE) }));
};

const sourceFor = (lib: Mediabunny, form: FileForm): AudioSampleSource =>
  form.container === "m4a"
    ? new lib.AudioSampleSource({ codec: "aac", quality: new lib.Quality(AAC_BITRATE), transform: { sampleRate: form.sampleRate } })
    : new lib.AudioSampleSource({ codec: "pcm-s16" });

// The runs encoded in the form, one sample run at a time; `onProgress` hears the fraction of
// samples handed to the encoder after each. Each run's timestamp is counted in samples, so no
// rounding accumulates across an hour of runs.
export const encodeFile = async (audio: FileAudio, format: PcmFormat, form: FileForm, onProgress: (fraction: number) => void): Promise<AudioFile> => {
  const lib = await import("mediabunny");
  const output = new lib.Output({
    format: form.container === "m4a" ? new lib.Mp4OutputFormat() : new lib.WavOutputFormat(),
    target: new lib.BufferTarget(),
  });
  const source = sourceFor(lib, form);
  output.addAudioTrack(source);
  await output.start();
  const total = audio.runs.reduce((sum, run) => sum + run.length, 0);
  let at = 0;
  for (const run of audio.runs) {
    const sample: AudioSample = new lib.AudioSample({ data: run, format: "f32", numberOfChannels: 1, sampleRate: format.sampleRate, timestamp: at / format.sampleRate });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
    at += run.length;
    onProgress(total === 0 ? 1 : at / total);
  }
  await output.finalize();
  const bytes = output.target.buffer;
  if (bytes === null) throw new Error("rendition file: the encoder finished with no bytes");
  return { bytes, extension: output.format.fileExtension, mimeType: output.format.mimeType };
};
