// [LAW:decomposition] The audio codec: a unit's PCM frames as the bytes the device keeps, and
// back. One sentence, no "and" hiding a second job: this module packs and unpacks audio. It
// decides nothing about what is kept or for how long (keptAudio.ts), stores nothing and
// plays nothing.
//
// WHICH FORM. Opus through WebCodecs where the browser can both encode and decode it, and
// 16-bit PCM otherwise — the one ordered choice, made once per device by `probeCodec`
// [LAW:no-mode-explosion]. Measured in Chrome 152 on 2026-09-16 over a 12 s unit at 24 kHz:
// Opus at 24 kbps keeps an hour of audio in about 11 MB, encodes the unit in 37 ms and decodes
// it in 16 ms; 16-bit PCM keeps the same hour in 173 MB. The kept form names its codec, so a
// device reads back whichever form it wrote, and an Opus entry on a browser that has since
// lost the decoder is a decode that throws: the caller's miss, never a silent substitute.
//
// WHAT COMES BACK IS FRAMES, EXACTLY AS MANY AS WENT IN. The unit player admits a unit only
// as frames of `frameSamples`, and the manifest's duration for the unit is `frames × FRAME_MS`
// — so `decode` returns exactly the frame count it is told, whatever the codec did to the
// length. Opus decodes at 48 kHz in Chrome (every decoder output rate is read, not assumed)
// and delays the audio by its pre-skip: taking every other sample returns the model's rate
// (Opus coded nothing above the 24 kHz input's 12 kHz, so there is nothing to alias; measured
// RMS error 0.003 against a 0.3 chirp), and the result is cut or zero-padded to the frame
// count. Cost, stated once: a decoded unit may sound up to a few milliseconds later than it
// was made, well inside one 80 ms frame of its word times.

import type { PcmFormat } from "./unitPlayer";

// [LAW:types-are-the-program] The two kept forms, each carrying exactly what reading it back
// needs. Opus keeps its packets end to end with their sizes, and the decoder description the
// encoder wrote (the OpusHead).
export type EncodedAudio =
  | {
      readonly codec: "opus";
      readonly description: Uint8Array<ArrayBuffer>;
      readonly packets: Uint8Array<ArrayBuffer>;
      readonly sizes: Uint16Array<ArrayBuffer>;
    }
  | { readonly codec: "pcm-s16"; readonly samples: Int16Array<ArrayBuffer> };

// The bytes a kept form occupies, which is what the device's cap is counted in.
export const bytesOf = (audio: EncodedAudio): number =>
  audio.codec === "opus" ? audio.description.byteLength + audio.packets.byteLength + audio.sizes.byteLength : audio.samples.byteLength;

export interface AudioCodec {
  readonly encode: (frames: ReadonlyArray<Float32Array<ArrayBuffer>>) => Promise<EncodedAudio>;
  // Exactly `frames` frames of the format's `frameSamples`; throws when the form cannot be read.
  readonly decode: (audio: EncodedAudio, frames: number) => Promise<ReadonlyArray<Float32Array<ArrayBuffer>>>;
}

// 24 kbps: the measured rate above. Speech from a 24 kHz model is not improved by more.
export const OPUS_BITRATE = 24_000;
// Opus's default packet: 20 ms. Timestamps only order the packets for the decoder.
const PACKET_US = 20_000;

// ── the pure half ─────────────────────────────────────────────────────────────────────

// The frames' samples end to end.
export const joined = (frames: ReadonlyArray<Float32Array<ArrayBuffer>>): Float32Array<ArrayBuffer> => {
  const all = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    all.set(frame, at);
    at += frame.length;
  }
  return all;
};

// The packets' bytes end to end.
const concatBytes = (parts: ReadonlyArray<Uint8Array<ArrayBuffer>>): Uint8Array<ArrayBuffer> => {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return all;
};

// A buffer source's bytes, in a buffer of their own.
const copied = (source: AllowSharedBufferSource): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source));
  return bytes;
};

// Every `factor`-th sample: a decoder's rate brought back to the model's.
export const decimated = (samples: Float32Array<ArrayBuffer>, factor: number): Float32Array<ArrayBuffer> =>
  factor === 1 ? samples : Float32Array.from({ length: Math.floor(samples.length / factor) }, (_, i) => samples[i * factor] ?? 0);

// [LAW:parse-dont-validate] Decoded samples as exactly `frames` frames: cut past the end,
// zero after it.
export const framed = (samples: Float32Array<ArrayBuffer>, frames: number, format: PcmFormat): ReadonlyArray<Float32Array<ArrayBuffer>> =>
  Array.from({ length: frames }, (_, i) => {
    const frame = new Float32Array(format.frameSamples);
    frame.set(samples.subarray(i * format.frameSamples, Math.min((i + 1) * format.frameSamples, samples.length)));
    return frame;
  });

export const toS16 = (samples: Float32Array<ArrayBuffer>): Int16Array<ArrayBuffer> =>
  Int16Array.from(samples, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767));

export const fromS16 = (samples: Int16Array<ArrayBuffer>): Float32Array<ArrayBuffer> => Float32Array.from(samples, (x) => x / 32767);

// ── the browser half ──────────────────────────────────────────────────────────────────

const opusConfig = (format: PcmFormat): AudioEncoderConfig => ({
  codec: "opus",
  sampleRate: format.sampleRate,
  numberOfChannels: 1,
  bitrate: OPUS_BITRATE,
});

const encodeOpus = (samples: Float32Array<ArrayBuffer>, format: PcmFormat): Promise<EncodedAudio> =>
  new Promise((resolve, reject) => {
    const packets: Uint8Array<ArrayBuffer>[] = [];
    let description: Uint8Array<ArrayBuffer> | null = null;
    const encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        const packet = new Uint8Array(chunk.byteLength);
        chunk.copyTo(packet);
        packets.push(packet);
        const given = metadata?.decoderConfig?.description;
        if (given !== undefined) description = copied(given);
      },
      error: reject,
    });
    encoder.configure(opusConfig(format));
    encoder.encode(new AudioData({ format: "f32", sampleRate: format.sampleRate, numberOfFrames: samples.length, numberOfChannels: 1, timestamp: 0, data: samples }));
    encoder
      .flush()
      .then(() => {
        encoder.close();
        if (description === null) throw new Error("audio codec: the Opus encoder wrote no decoder description");
        resolve({ codec: "opus", description, packets: concatBytes(packets), sizes: Uint16Array.from(packets, (p) => p.byteLength) });
      })
      .catch(reject);
  });

const decodeOpus = (audio: Extract<EncodedAudio, { codec: "opus" }>, format: PcmFormat): Promise<Float32Array<ArrayBuffer>> =>
  new Promise((resolve, reject) => {
    const outputs: Float32Array<ArrayBuffer>[] = [];
    let rate: number | null = null;
    const decoder = new AudioDecoder({
      output: (data) => {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        rate ??= data.sampleRate;
        if (data.sampleRate !== rate) reject(new Error(`audio codec: the Opus decoder changed rate from ${rate} to ${data.sampleRate}`));
        outputs.push(samples);
        data.close();
      },
      error: reject,
    });
    decoder.configure({ codec: "opus", sampleRate: format.sampleRate, numberOfChannels: 1, description: audio.description });
    let at = 0;
    audio.sizes.forEach((size, i) => {
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: i * PACKET_US, duration: PACKET_US, data: audio.packets.subarray(at, at + size) }));
      at += size;
    });
    decoder
      .flush()
      .then(() => {
        decoder.close();
        const factor = (rate ?? format.sampleRate) / format.sampleRate;
        if (!Number.isInteger(factor)) throw new Error(`audio codec: the Opus decoder's ${rate} Hz is not a multiple of ${format.sampleRate} Hz`);
        resolve(decimated(joined(outputs), factor));
      })
      .catch(reject);
  });

// [LAW:single-enforcer] The one reading of whether this browser keeps Opus: both halves, at
// the model's format. Anything short of both is PCM.
export const probeCodec = async (format: PcmFormat): Promise<"opus" | "pcm-s16"> => {
  if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") return "pcm-s16";
  try {
    const [encode, decode] = await Promise.all([
      AudioEncoder.isConfigSupported(opusConfig(format)),
      AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: format.sampleRate, numberOfChannels: 1 }),
    ]);
    return encode.supported === true && decode.supported === true ? "opus" : "pcm-s16";
  } catch {
    // A config the browser cannot even parse is a codec it does not have.
    return "pcm-s16";
  }
};

// The codec the device keeps with: `form` from `probeCodec`, taken as a value so the check
// can drive the PCM form with no WebCodecs at all.
export const createCodec = (form: "opus" | "pcm-s16", format: PcmFormat): AudioCodec => ({
  encode: (frames) => (form === "opus" ? encodeOpus(joined(frames), format) : Promise.resolve({ codec: "pcm-s16", samples: toS16(joined(frames)) })),
  decode: async (audio, frames) => framed(audio.codec === "opus" ? await decodeOpus(audio, format) : fromS16(audio.samples), frames, format),
});
