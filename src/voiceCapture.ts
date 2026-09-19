// [LAW:effects-at-boundaries] The recording edge of voice cloning: the microphone and the
// reader's file, each becoming the samples a clone is made of (clonedVoice.ts). One sentence,
// no "and": this module gets audio into the model's shape. It names no voice, keeps nothing
// and knows no picker; the cloning machine (voiceCloning.ts) drives it and turns what it
// returns into a clone.
//
// ONE ROAD IN. A microphone recording is a Blob the browser's recorder made and an uploaded
// file is a Blob the reader chose; both go through the one decode below, so the recorder
// never resamples on its own and a file the browser can play is a file it can clone from
// [LAW:one-type-per-behavior]. The decode is the browser's `decodeAudioData` on an offline
// context at the model's rate — the spec has it resample to the context's rate — then the
// channels averaged to one and the first CLONE_SECONDS kept.
//
// WHO STOPS THE RECORDING. The recording ends on the reader's tap or at CLONE_SECONDS,
// whichever is first, and the timer that ends it is the recording's own, cleared when the
// reader ends it: one owner of the end [LAW:no-ambient-temporal-coupling].
//
// Every browser surface is a parameter, so scripts/voice-cloning-check.ts drives a stub
// and the page hands it the window's own.

import { CLONE_SAMPLES, CLONE_SECONDS } from "./clonedVoice";

// A recording under way: its samples once it ends, and the reader's way to end it.
export interface Capture {
  readonly pcm: Promise<Float32Array<ArrayBuffer>>;
  readonly stop: () => void;
}

export interface VoiceCapture {
  readonly record: () => Capture;
  readonly decode: (file: Blob) => Promise<Float32Array<ArrayBuffer>>;
}

// [LAW:types-are-the-program] What the edge needs of the browser: the members it uses.
export interface DecodedAudio {
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

export interface Decoder {
  decodeAudioData(bytes: ArrayBuffer): Promise<DecodedAudio>;
}

export interface Recorder {
  start(): void;
  stop(): void;
  readonly state: "inactive" | "recording" | "paused";
  addEventListener(type: "dataavailable", listener: (event: { readonly data: Blob }) => void): void;
  addEventListener(type: "stop", listener: () => void): void;
  addEventListener(type: "error", listener: (event: { readonly error?: unknown }) => void): void;
}

export interface Stream {
  getTracks(): ReadonlyArray<{ stop(): void }>;
}

export interface CaptureConfig {
  // `new OfflineAudioContext(1, 1, SAMPLE_RATE)` in the page: the one decoder, at the model's rate.
  readonly Decoder: () => Decoder;
  // `navigator.mediaDevices.getUserMedia({ audio: true })` in the page.
  readonly microphone: () => Promise<Stream>;
  // `new MediaRecorder(stream)` in the page.
  readonly Recorder: (stream: Stream) => Recorder;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

// The decoded audio as the model's mono waveform, cut to a clone's length.
export const monoOf = (audio: DecodedAudio): Float32Array<ArrayBuffer> => {
  const length = Math.min(audio.length, CLONE_SAMPLES);
  const mono = new Float32Array(new ArrayBuffer(length * 4));
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const data = audio.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / audio.numberOfChannels;
  }
  return mono;
};

export const createVoiceCapture = (config: CaptureConfig): VoiceCapture => {
  const decode = async (file: Blob): Promise<Float32Array<ArrayBuffer>> => monoOf(await config.Decoder().decodeAudioData(await file.arrayBuffer()));

  const record = (): Capture => {
    let recorder: Recorder | null = null;
    let ended = false;
    const end = (): void => {
      ended = true;
      if (recorder !== null && recorder.state === "recording") recorder.stop();
    };
    const pcm = (async (): Promise<Float32Array<ArrayBuffer>> => {
      const stream = await config.microphone();
      const release = (): void => {
        for (const track of stream.getTracks()) track.stop();
      };
      // The reader ended it before the microphone answered: nothing was recorded.
      if (ended) {
        release();
        throw new Error("the recording was stopped before it began");
      }
      const chunks: Blob[] = [];
      // [LAW:no-silent-failure] Everything past the open microphone is guarded: a recorder
      // this browser will not build, or will not start, must still give the microphone back
      // — an unreleased track leaves the browser's recording light on for the life of the
      // page, with nothing the reader can tap to end it.
      const timer = config.setTimeout(end, CLONE_SECONDS * 1000);
      try {
        const made = config.Recorder(stream);
        recorder = made;
        const blob = new Promise<Blob>((resolve, reject) => {
          made.addEventListener("dataavailable", (event) => chunks.push(event.data));
          made.addEventListener("stop", () => resolve(new Blob(chunks)));
          made.addEventListener("error", (event) => reject(event.error instanceof Error ? event.error : new Error("the recorder failed")));
        });
        made.start();
        return await decode(await blob);
      } finally {
        config.clearTimeout(timer);
        release();
      }
    })();
    return { pcm, stop: end };
  };

  return { record, decode };
};
