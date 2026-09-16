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
// resampling are mediabunny's (MPL-2.0), a container's craft rather than this program's; the
// library is imported when a file is made, never with the page. Cost, stated once: an M4A runs a
// few AAC frames past the timeline — the encoder's priming at the start and its last frame's
// padding, which Chrome's encoder does not report, so no edit list trims them. Measured in Chrome
// 152 on macOS, 2026-09-16: a 9.400 s timeline made a file ffprobe reads as 9.472 s (afinfo:
// 9.428 s), and a 149.100 s one a file of 149.184 s (afinfo: 149.140 s) — a few frames whatever
// the length, since the whole paste is one continuous encode. A WAV is the timeline to the sample.

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
// Speech from a 24 kHz model, mono: 64 kbps AAC carries all of it. Measured in Chrome 152 on
// macOS, 2026-09-16: a 149.1 s paste is a 1.25 MB file.
export const AAC_BITRATE = 64_000;
// [LAW:single-enforcer] The one AAC setting, asked of the browser and encoded with alike. A bare
// number to mediabunny's Quality is a 0–1 quality level, never bits per second.
const aacQuality = (lib: Mediabunny): InstanceType<Mediabunny["Quality"]> => new lib.Quality({ bitrate: AAC_BITRATE });

// [LAW:single-enforcer] The one choice of form. `canEncodeAac` is the browser's word on AAC at
// a rate, taken as a parameter so the check drives every arm.
export const chooseForm = async (canEncodeAac: (sampleRate: number) => Promise<boolean>): Promise<FileForm> => {
  for (const sampleRate of AAC_RATES) {
    if (await canEncodeAac(sampleRate)) return { container: "m4a", sampleRate };
  }
  return { container: "wav" };
};

// ── the browser half ──────────────────────────────────────────────────────────────────

type Mediabunny = typeof import("mediabunny");

export interface AudioFile {
  readonly bytes: ArrayBuffer;
  readonly extension: string;
  readonly mimeType: string;
}

// This browser's form, asked of mediabunny.
export const browserForm = async (): Promise<FileForm> => {
  const lib = await import("mediabunny");
  return chooseForm((sampleRate) => lib.canEncodeAudio("aac", { numberOfChannels: 1, sampleRate, quality: aacQuality(lib) }));
};

const sourceFor = (lib: Mediabunny, form: FileForm): AudioSampleSource =>
  form.container === "m4a"
    ? new lib.AudioSampleSource({ codec: "aac", quality: aacQuality(lib), transform: { sampleRate: form.sampleRate } })
    : new lib.AudioSampleSource({ codec: "pcm-s16" });

// The runs encoded in the form, one sample run at a time; `onProgress` hears the fraction of
// samples handed to the encoder after each. Each run's timestamp is counted in samples, so no
// rounding accumulates across an hour of runs. An abort stops the encode at the next run: the
// output is cancelled, what it held let go, and the promise rejects with the abort's reason.
export const encodeFile = async (audio: FileAudio, format: PcmFormat, form: FileForm, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<AudioFile> => {
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
    if (signal.aborted) {
      await output.cancel();
      signal.throwIfAborted();
    }
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
  // An MP4 holding only audio is an M4A by name; the MIME type is the output's own reading of its
  // tracks.
  return { bytes, extension: form.container === "m4a" ? ".m4a" : output.format.fileExtension, mimeType: await output.getMimeType() };
};
