// [LAW:effects-at-boundaries] The recording edge of voice cloning: the microphone and the
// reader's file, each becoming the samples a clone is made of (clonedVoice.ts). One sentence,
// no "and": this module gets audio into the model's shape. It names no voice, keeps nothing
// and knows no picker; the cloning machine (voiceCloning.ts) drives it and turns what it
// returns into a clone.
//
// ONE ROAD IN. A microphone recording is a Blob the browser's recorder made and an uploaded
// file is a Blob the reader chose; both go through the one decode below, so the recorder
// never resamples on its own and a file the browser can play is a file it can clone from
// [LAW:one-type-per-behavior]. What differs is who bounds the length: the recording's is the
// cap's (below), and the file's is read from its metadata before it is decoded at all — one
// measure each, at the head of its own road [LAW:single-enforcer]. The decode is the browser's `decodeAudioData` on an offline
// context at the model's rate — the spec has it resample to the context's rate — then the
// channels averaged to one and the clone's own CLONE_SECONDS found in them (`clonePrompt`).
//
// TEN SECONDS OF VOICE, NOT TEN SECONDS OF CLOCK. A reader moves their eyes to the passage and
// draws breath before saying anything, so the head of a recording is room tone — and keeping the
// FIRST CLONE_SAMPLES spent the clone's length on that twice over: the tail of the passage was
// cut off to make room for it, and the prompt the encoder attends over opened on it. So the
// window is found rather than assumed to start at sample zero — `speechStart` reports where the
// voice begins and `clonePrompt` takes the clone's length from there. Both roads in get it,
// because an uploaded voice memo opens on fumbling exactly the way a live one does
// [LAW:single-enforcer].
//
// WHO STOPS THE RECORDING, AND WHO HEARS IT END. The recording ends on the reader's tap or
// at RECORDING_SECONDS, whichever is first, and the timer that ends it is the recording's own,
// cleared when the reader ends it: one owner of the end [LAW:no-ambient-temporal-coupling].
// Both ends resolve `ended`, because the machine that drew the Stop button cannot see the
// cap fire: a recording the cap ended would otherwise leave the form saying "Stop" over a
// microphone already closed [LAW:one-source-of-truth].
//
// Every browser surface is a parameter, so scripts/voice-cloning-check.ts drives a stub
// and the page hands it the window's own.

import { CLONE_SAMPLES, CLONE_SECONDS } from "./clonedVoice";
import { SAMPLE_RATE } from "./modelAssets";

// [LAW:parse-dont-validate] The longest recording a clone may be cut from. The clone is
// CLONE_SECONDS of it taken from where the voice starts, so anything past that is the reader's
// convenience — but `decodeAudioData` holds the WHOLE file as samples at the model's rate, and the
// decode is neither cut nor cancellable, so an hour of podcast picked by mistake is 690 MB on the
// thread that draws the form, which on a phone is the tab. Ten minutes is 115 MB at worst, which
// a phone survives.
//
// WHY LENGTH AND NOT BYTES. Bytes cannot tell the two apart: 16 MB of speech at 64 kbps is
// half an hour, and 16 MB of CD-quality WAV is a minute and a half. A cap on size would
// refuse the minute and a half — which this can clone from, and always could — while waving
// the half hour through [LAW:one-source-of-truth].
export const CLONE_FILE_SECONDS = 10 * 60;

// A recording under way: its samples once it ends, the fact that it has ended — by the
// reader's tap or by the cap — and the reader's way to end it.
export interface Capture {
  readonly pcm: Promise<Float32Array<ArrayBuffer>>;
  readonly ended: Promise<void>;
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
  // `new Audio()` over a blob URL in the page: how long the reader's file is, read from its
  // metadata, without decoding a sample of it.
  readonly duration: (file: Blob) => Promise<number>;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

// ── which CLONE_SECONDS of a recording the clone is made of ──────────────────────

// [LAW:one-source-of-truth] How long a reader may take to reach their first word. ONE constant,
// because it answers two questions that have to agree: how much longer than a clone the
// microphone runs, and how much silence at the head `speechStart` will look through. Two numbers
// could drift into a cap that stops before the lead-in it allows has even been skipped.
//
// It is a BOUND on the slowest starter, not a typical pause, and the asymmetry is the reason
// [LAW:no-silent-failure]: set it tight and a reader who hesitates is cut off mid-passage, which
// is silent and takes whichever sounds live in the tail out of the clone for good; set it
// generously and a prompt reader waits a moment with a Stop button already in front of them,
// which costs nothing. Three seconds is far longer than anyone needs to begin a sentence that is
// already on the screen in front of them.
export const LEAD_IN_SECONDS = 3;

export const LEAD_IN_SAMPLES = LEAD_IN_SECONDS * SAMPLE_RATE;

// How long the microphone runs. A clone's length PLUS the allowance, so a reader who spends all
// of the allowance still leaves CLONE_SECONDS of voice behind rather than CLONE_SECONDS of clock.
export const RECORDING_SECONDS = CLONE_SECONDS + LEAD_IN_SECONDS;

// The most of a recording that can become a clone, and so the only part of it worth looking at:
// the allowance, plus the clone's length after it. Bounding the work here is what keeps a
// ten-minute upload from being measured end to end when all but its first seconds are discarded.
export const PROMPT_SAMPLES = LEAD_IN_SAMPLES + CLONE_SAMPLES;

// The scan's frame: 20 ms — short enough that the start of a word lands inside one frame, long
// enough that a few samples of crackle cannot pass for speech.
const FRAME_SAMPLES = SAMPLE_RATE / 50;

// What counts as voice, as a fraction of the loudest frame in the recording. RELATIVE, because no
// absolute number is right twice: a phone held at the chin clips near −3 dBFS and a laptop across
// a desk peaks nearer −30, and a floor that suits either admits or refuses everything on the
// other. About −30 dB from the peak — an order of magnitude above the room tone of a quiet room,
// and far enough below a vowel to catch the fricative that opens `She`.
const VOICE_FRACTION_OF_PEAK = 0.03;

// Backed off from the frame that crossed the floor, so the attack of the first word is inside the
// clone rather than merely the thing that located it.
const PREROLL_SAMPLES = Math.round(0.05 * SAMPLE_RATE);

// The decoded audio as the model's mono waveform, bounded to the part that can become a clone.
export const monoOf = (audio: DecodedAudio): Float32Array<ArrayBuffer> => {
  const length = Math.min(audio.length, PROMPT_SAMPLES);
  const mono = new Float32Array(new ArrayBuffer(length * 4));
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const data = audio.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / audio.numberOfChannels;
  }
  return mono;
};

// Where the reader's voice begins: the first frame of the allowance whose level clears a floor
// set by the loudest frame of the whole waveform, less a moment of pre-roll.
//
// The peak is taken over everything handed in and not only over the stretch searched, because the
// speech that calibrates the floor is normally AFTER the silence being measured — a floor drawn
// from the lead-in alone would be a floor drawn from room tone [LAW:one-source-of-truth].
//
// TWO ANSWERS, EACH RIGHT FOR ITS OWN REASON. When no frame of the allowance clears the floor the
// reader really was silent throughout it, so the whole allowance was lead-in and the clone starts
// at its end. When the waveform has nothing in it anywhere its peak is zero, there is no floor to
// clear, and the clone starts at the top — which is what this did for every recording before, so
// a recording of silence is no worse than it was and `cloneVoice` still refuses one too short to
// be a voice.
export const speechStart = (mono: Float32Array): number => {
  // Bounded here rather than trusted to arrive bounded: only PROMPT_SAMPLES of a recording can
  // become a clone, so that is both the most worth scanning and the stretch the floor should be
  // calibrated on, whatever length the caller happens to hand over [LAW:parse-dont-validate].
  const frames = Math.floor(Math.min(mono.length, PROMPT_SAMPLES) / FRAME_SAMPLES);
  if (frames === 0) return 0;
  const level = new Float32Array(frames);
  let peak = 0;
  for (let frame = 0; frame < frames; frame++) {
    const at = frame * FRAME_SAMPLES;
    let square = 0;
    for (let i = at; i < at + FRAME_SAMPLES; i++) square += (mono[i] ?? 0) ** 2;
    const rms = Math.sqrt(square / FRAME_SAMPLES);
    level[frame] = rms;
    peak = Math.max(peak, rms);
  }
  const floor = peak * VOICE_FRACTION_OF_PEAK;
  if (floor <= 0) return 0;
  const searched = Math.min(frames, Math.ceil(LEAD_IN_SAMPLES / FRAME_SAMPLES));
  for (let frame = 0; frame < searched; frame++) {
    if ((level[frame] ?? 0) >= floor) return Math.max(0, frame * FRAME_SAMPLES - PREROLL_SAMPLES);
  }
  return Math.min(LEAD_IN_SAMPLES, mono.length);
};

// The clone's prompt: CLONE_SAMPLES of the reader's voice, taken from where the voice starts.
// [LAW:single-enforcer] the one place that decides WHICH ten seconds a clone is made of, for the
// microphone and the reader's file alike.
export const clonePrompt = (mono: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> => {
  const from = speechStart(mono);
  return mono.subarray(from, from + CLONE_SAMPLES);
};

export const createVoiceCapture = (config: CaptureConfig): VoiceCapture => {
  // The one decode, for whichever road the audio came in on.
  const samplesOf = async (audio: Blob): Promise<Float32Array<ArrayBuffer>> => clonePrompt(monoOf(await config.Decoder().decodeAudioData(await audio.arrayBuffer())));

  // [LAW:parse-dont-validate] The reader's file crossing into audio this can clone from: it
  // is measured before a sample of it exists, because past that line it is held twice over,
  // raw and decoded, with nothing on the form to tap while it happens.
  const decode = async (file: Blob): Promise<Float32Array<ArrayBuffer>> => {
    const seconds = await config.duration(file);
    // A container that carries no duration — what MediaRecorder writes is commonly Infinity —
    // is refused rather than decoded to find out, which is the whole danger. The reader is
    // given the way out, because the file itself is likely fine.
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("this browser cannot tell how long that recording is — try a .wav, .mp3 or .m4a");
    if (seconds > CLONE_FILE_SECONDS) throw new Error(`that recording is ${Math.ceil(seconds / 60)} minutes — a voice is cloned from one of ${CLONE_FILE_SECONDS / 60} minutes or less`);
    return samplesOf(file);
  };

  const record = (): Capture => {
    let recorder: Recorder | null = null;
    let over = false;
    let announce: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const end = (): void => {
      over = true;
      announce();
      if (recorder !== null && recorder.state === "recording") recorder.stop();
    };
    const pcm = (async (): Promise<Float32Array<ArrayBuffer>> => {
      const stream = await config.microphone();
      const release = (): void => {
        for (const track of stream.getTracks()) track.stop();
      };
      // The reader ended it before the microphone answered: nothing was recorded.
      if (over) {
        release();
        throw new Error("the recording was stopped before it began");
      }
      const chunks: Blob[] = [];
      // [LAW:no-silent-failure] Everything past the open microphone is guarded: a recorder
      // this browser will not build, or will not start, must still give the microphone back
      // — an unreleased track leaves the browser's recording light on for the life of the
      // page, with nothing the reader can tap to end it.
      const timer = config.setTimeout(end, RECORDING_SECONDS * 1000);
      try {
        const made = config.Recorder(stream);
        recorder = made;
        const blob = new Promise<Blob>((resolve, reject) => {
          made.addEventListener("dataavailable", (event) => chunks.push(event.data));
          made.addEventListener("stop", () => resolve(new Blob(chunks)));
          made.addEventListener("error", (event) => reject(event.error instanceof Error ? event.error : new Error("the recorder failed")));
        });
        made.start();
        // The recorder's blob is NOT measured: its length is the cap's to own, and what
        // MediaRecorder writes for a duration is commonly Infinity.
        return await samplesOf(await blob);
      } finally {
        config.clearTimeout(timer);
        release();
      }
    })();
    return { pcm, ended, stop: end };
  };

  return { record, decode };
};
