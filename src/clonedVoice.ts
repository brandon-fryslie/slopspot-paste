// [LAW:decomposition] A cloned voice: ten seconds of a reader's own recording, named, and
// kept on this device. One sentence, no "and" — this module turns a recording into a voice
// the rest of the pipeline can name, and keeps those voices in the device's storage. It
// records nothing (voiceCapture.ts is the microphone and the file edge), encodes nothing
// (the worker derives the model's prompt from the samples, pocketTtsRuntime.ts) and draws
// nothing (voicePicker.ts).
//
// STORE THE ORIGINAL, DERIVE THE PROMPT. What the device keeps is the recording — 24 kHz
// mono 16-bit PCM, the very samples the encoder is fed — never the prompt tensor the model
// makes of it. The prompt is a function of the samples and the weights: a new model build
// re-derives every clone for free, and the device never holds a prompt no build can read
// [LAW:one-source-of-truth] [LAW:no-ambient-temporal-coupling]. Cost, stated once: 16-bit at
// 24 kHz is 480 KB for ten seconds, 640 KB as the base64 localStorage holds, so a handful of
// clones fit in an origin's quota; a save the device refuses is reported, never silent.
//
// WHY 16 BITS ARE THE WHOLE TRUTH. The model runs in float16 (pocketTtsRuntime.ts), whose
// mantissa is 11 bits: a 16-bit sample carries every bit the encoder can see. The capture
// edge already resamples to the model's rate, so nothing the model could hear is lost
// between the microphone and the store.
//
// WHY THE KEY IS THE CONTENT. A clone is named by the SHA-256 of its samples, under the one
// content-hash move every derived cache keys with (contentHash.ts). So the key is the
// voice's version for the rendition cache (speechScript.ts unitHash): re-recording is a new
// key and simply misses, and two readers' identical recordings are one voice. The key is
// computed once, where the samples are made, and kept beside them — the read edge trusts
// its shape, because a record this build did not write is not a clone at all.
//
// [LAW:effects-at-boundaries] Storage is a parameter of the two edges below, so
// scripts/cloned-voice-check.ts drives them over a Map; the page hands them the device's
// storage through preferenceStore.deviceStore.

import { contentHash } from "./contentHash";
import { SAMPLE_RATE, type VoiceId } from "./modelAssets";
import type { PreferenceStore } from "./preferenceStore";

// [LAW:types-are-the-program] A cloned voice's name in the pipeline: the prefix says which
// kind of voice a key is, so a string is a hosted voice or a clone by its shape, and every
// `===` that compares two voices keeps its meaning.
export type ClonedVoiceKey = `clone:${string}`;
export type VoiceKey = VoiceId | ClonedVoiceKey;

export const isClonedKey = (voice: string): voice is ClonedVoiceKey => /^clone:[0-9a-f]{64}$/.test(voice);

// How much of a recording a clone is made of: the hosted voices are ten seconds (125 frames
// of the model's 12.5 Hz), and the generation's cost per frame grows with the prompt it
// attends over, so a clone is cut to the same length rather than upstream's thirty.
export const CLONE_SECONDS = 10;
export const CLONE_SAMPLES = CLONE_SECONDS * SAMPLE_RATE;

// The most characters a name is; longer is cut, so the picker's rows stay rows.
export const NAME_LENGTH = 40;

export interface ClonedVoice {
  readonly key: ClonedVoiceKey;
  readonly name: string;
  // 24 kHz mono, at most CLONE_SAMPLES.
  readonly samples: Int16Array<ArrayBuffer>;
}

// The name as the picker shows it: trimmed and cut; an empty name is "My voice", so a
// reader who skips the box still gets a row they can read.
export const cloneName = (raw: string): string => {
  const trimmed = raw.trim().slice(0, NAME_LENGTH).trim();
  return trimmed === "" ? "My voice" : trimmed;
};

// ── the recording as a clone ──────────────────────────────────────────────────────────

// Float samples in [-1, 1] as 16-bit: the ingest's one lossy step, sized above.
//
// [LAW:single-enforcer] It does NOT choose which part of a recording to keep. voiceCapture's
// `clonePrompt` does, and is the only thing that does. This used to cut `pcm.subarray(0,
// CLONE_SAMPLES)` — keep-the-FIRST-ten-seconds, the very defect slopspot-voices-4f5 removed — which
// was inert only for as long as every caller happened to trim first. Samples longer than a clone are
// now a caller that skipped the one enforcer, and are refused: a loud error beats silently
// reinstating the old truncation for whoever adds the next road in [LAW:no-silent-failure].
export const quantize = (pcm: Float32Array): Int16Array<ArrayBuffer> => {
  if (pcm.length > CLONE_SAMPLES) {
    // The reader sees this verbatim ("Could not make the voice: …"), so it says whose fault it is
    // before it says anything they cannot act on: a broken invariant is not a thing about their
    // recording [LAW:no-silent-failure].
    throw new Error(`that recording could not be prepared to clone from, which is a fault in this page rather than in the recording — ${(pcm.length / SAMPLE_RATE).toFixed(1)} s of samples where a clone is ${CLONE_SECONDS} s at most, so they did not come through clonePrompt`);
  }
  const samples = new Int16Array(new ArrayBuffer(pcm.length * 2));
  for (const [i, x] of pcm.entries()) samples[i] = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  return samples;
};

export const toFloat = (samples: Int16Array): Float32Array<ArrayBuffer> => Float32Array.from(samples, (x) => x / 32767);

// [LAW:parse-dont-validate] A recording with at least a second of SPEECH in it becomes a clone; a
// shorter one is not a voice — a tap that ended before anything was said, or a file whose every
// other second is room tone — and is refused with the reason a reader can act on.
//
// What arrives here has already been through `clonePrompt`, so its length is what there is to clone
// FROM and not the length of the file the reader chose. The refusal says that and no more. Telling
// someone who uploaded three and a half seconds that "the recording is 0.5 s" is a false statement
// about their file; telling them "only 0.5 s of it is speech" is false the other way round when no
// trim happened at all — which is every recording whose first frames already clear the floor. The
// wording has to hold on both branches, so it claims a length and not a measurement of speech
// [LAW:no-silent-failure].
export const MIN_SECONDS = 1;

export const cloneVoice = async (name: string, pcm: Float32Array): Promise<ClonedVoice> => {
  if (pcm.length < MIN_SECONDS * SAMPLE_RATE) {
    throw new Error(`there is only ${(pcm.length / SAMPLE_RATE).toFixed(1)} s to clone from; a voice needs at least ${MIN_SECONDS} s`);
  }
  const samples = quantize(pcm);
  return { key: `clone:${await contentHash(base64Of(samples))}`, name: cloneName(name), samples };
};

// ── the device's storage ──────────────────────────────────────────────────────────────

// One key, one value: the clones as a JSON list, or absent when there are none.
export const CLONES_KEY = "listen.clones";

interface Kept {
  readonly key: string;
  readonly name: string;
  readonly pcm: string;
}

const CHUNK = 0x8000;

export const base64Of = (samples: Int16Array<ArrayBuffer>): string => {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return btoa(binary);
};

const samplesOf = (base64: string): Int16Array<ArrayBuffer> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
};

// [LAW:parse-dont-validate] A stored record becomes a clone, or nothing: a value that is not
// what this build writes — another build's shape, a hand edit, a key that is not a content
// hash, samples longer than a clone — is not a clone, and reads as none.
// [LAW:no-silent-failure] exception: the same trade the voice pick makes (voiceChoice.ts): a
// record this build did not write is not a preference, and reads as absent.
const parseKept = (value: unknown): ClonedVoice | null => {
  if (typeof value !== "object" || value === null) return null;
  const { key, name, pcm } = value as Record<string, unknown>;
  if (typeof key !== "string" || !isClonedKey(key) || typeof name !== "string" || typeof pcm !== "string") return null;
  let samples: Int16Array<ArrayBuffer>;
  try {
    samples = samplesOf(pcm);
  } catch {
    return null;
  }
  if (samples.length === 0 || samples.length > CLONE_SAMPLES) return null;
  return { key, name: cloneName(name), samples };
};

const jsonOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseClones = (raw: string | null): ReadonlyArray<ClonedVoice> => {
  if (raw === null) return [];
  const parsed = jsonOf(raw);
  return Array.isArray(parsed) ? parsed.flatMap((item) => parseKept(item) ?? []) : [];
};

export const readClones = (store: PreferenceStore): ReadonlyArray<ClonedVoice> => parseClones(store.getItem(CLONES_KEY));

// [LAW:one-source-of-truth] The same read, deriving afresh only when the stored record is
// not the one already derived from. The store stays the authority — every call reads it —
// and the clones are the disposable projection the governing principle says they are; what
// is skipped is only the walk over every sample byte.
//
// WHY THE PANEL NEEDS IT. The readout reads the clones at every render, and a render follows
// every worker message — one per generated frame. Parsing ten seconds of base64 twice per
// frame is half a million byte writes on the thread that schedules playback, so the read a
// render makes must cost nothing when nothing changed.
export const createClonesReader = (store: PreferenceStore): (() => ReadonlyArray<ClonedVoice>) => {
  let derived: { readonly raw: string | null; readonly clones: ReadonlyArray<ClonedVoice> } | null = null;
  return () => {
    const raw = store.getItem(CLONES_KEY);
    if (derived === null || derived.raw !== raw) derived = { raw, clones: parseClones(raw) };
    return derived.clones;
  };
};

// Whether the device took the write. A PreferenceStore never throws — a refused write is
// simply not kept (preferenceStore.ts) — so the fact is read back from the store itself:
// what it holds after the write is what it kept.
export type Saving = { readonly kind: "kept" } | { readonly kind: "refused" };

export const writeClones = (store: PreferenceStore, clones: ReadonlyArray<ClonedVoice>): Saving => {
  if (clones.length === 0) {
    store.removeItem(CLONES_KEY);
    return store.getItem(CLONES_KEY) === null ? { kind: "kept" } : { kind: "refused" };
  }
  const kept: Kept[] = clones.map(({ key, name, samples }) => ({ key, name, pcm: base64Of(samples) }));
  const value = JSON.stringify(kept);
  store.setItem(CLONES_KEY, value);
  return store.getItem(CLONES_KEY) === value ? { kind: "kept" } : { kind: "refused" };
};

// A clone added to what the device holds: one under a key already held replaces it, so a
// re-recording that came out the same is still one voice, now under the newer name.
export const withClone = (clones: ReadonlyArray<ClonedVoice>, voice: ClonedVoice): ReadonlyArray<ClonedVoice> => [
  ...clones.filter((held) => held.key !== voice.key),
  voice,
];

export const withoutClone = (clones: ReadonlyArray<ClonedVoice>, key: ClonedVoiceKey): ReadonlyArray<ClonedVoice> =>
  clones.filter((held) => held.key !== key);

// ── the recording, playable ───────────────────────────────────────────────────────────

// The samples as a WAV file's bytes: what a clone's preview plays before the model is on the
// device, through the same audio element a hosted voice's sample plays through.
export const wavOf = (samples: Int16Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  const data = samples.byteLength;
  const bytes = new Uint8Array(new ArrayBuffer(44 + data));
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, data), 44);
  return bytes;
};
