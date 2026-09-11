// [LAW:effects-at-boundaries] The one effectful module of the read-along pipeline: it runs
// Pocket TTS on the reader's GPU. Everything upstream of it is pure (speechScript,
// speechManifest) and everything downstream reads PCM; this module is where the model, the
// device and the verified bytes meet, and it is wrapped by synthesisHandler's runtime seam
// so nothing else in the repo imports jax-js or the vendored model [LAW:one-way-deps].
//
// WHY THIS IS THE RUNTIME. The q35.1 spike ran three browser ports on real hardware and
// chose jax-js's WebGPU path (3.45x real time on an M2 Max, identical audio to the reference
// port, source in TypeScript that Vite builds, and the attention read-out for word timing a
// few lines from where the query and KV cache are locals). Its single-threaded Wasm path
// ran at 1.03x and is not offered [LAW:no-mode-explosion].
//
// WHY THE PROBE FETCHES NOTHING. A reader whose browser lacks WebGPU — or whose device cannot
// run an f16 shader, which the fp16 weights need — must be told so before a 236 MB download
// begins, not after. `probe` asks the platform and jax-js for a device, then runs one f16 op
// on the device jax-js actually created (its shader compiler throws without shader-f16), and
// reports the first thing missing as a typed reason [LAW:no-silent-failure] [LAW:single-enforcer].
//
// WHY EVERY UNIT STARTS FROM THE VOICE. Kyutai's own generation gives each chunk a fresh copy
// of the voice state with no audio or attention state carried across; the loop below is
// upstream jax-js's inference loop (website/src/routes/tts/inference.ts at the commit the
// vendored model names) re-shaped as an async generator so the handler can stop it BETWEEN
// frames through `return()`. The overlap upstream had — reading back frame n's PCM while
// frame n+1's transformer step is issued — is kept: `pending` holds the readback of the
// previous frame and is awaited only after this frame's decode has been enqueued.
//
// The seed is fixed, so a unit's audio is a deterministic function of its text and voice:
// the rendition a listener resumes is the one they paused [LAW:one-source-of-truth].
//
// WHY THE WORD TIMES ARE READ ONE STEP LATE. The attention read-out for step n (the logits
// of the checkpoint's `readout` head over the unit's text tokens) is a fact about frame n,
// and the alignment machine (wordAlignment.ts) wants it together with whether frame n's
// PCM is voiced. That PCM is read back a step later, in `pending`, so the step's unit
// scores travel with the readback and the machine sees the pair the moment the frame is
// yielded [LAW:no-ambient-temporal-coupling]. One readback per step carries both the EOS
// bit and the logits, so the read-out adds no round trip to the device.

import { defaultDevice, init, numpy as np, random, tree } from "@jax-js/jax";
import { safetensors, tokenizers } from "@jax-js/loaders";
import { fromBinary } from "@bufbuild/protobuf";
import { ModelProtoSchema, ModelProto_SentencePiece_Type } from "sentencepiece-buf/model";
import { loadAssets, pruneStaleAssets, type AssetIo, type AssetProgress, type FetchLike } from "./modelAssetLoader";
import { FRAME_MS, MODEL_ASSETS, VOICE_IDS, allModelAssets, type ModelAsset, type VoiceId } from "./modelAssets";
import type { UnitText } from "./speechScript";
import type { GenerationEnd, LoadResult, LoadedModel, SynthesisRuntime } from "./synthesisHandler";
import type { Support } from "./synthesisProtocol";
import {
  createFlowLMState,
  createMimiDecodeState,
  fromSafetensors,
  runFlowLMStep,
  runMimiDecode,
  type PocketTTS,
} from "./vendor/pocket-tts";
import { createWordAligner, isVoiced, planAlignment, unitScores } from "./wordAlignment";

// The bound on one unit's generation loop. A unit holds at most MAX_UNIT_TOKENS (50) text
// tokens — a dozen seconds of speech, about 150 frames — so a loop still running at 500
// frames (40 s) is the model failing to find end-of-speech, not a long sentence. Upstream's
// demo caps at 1000 for whole paragraphs; the ONNX port at 500.
export const MAX_UNIT_FRAMES = 500;

const SEED = 0;
const TEMPERATURE = 0.7;
const LSD_DECODE_STEPS = 1;
const WEIGHT_DTYPE = np.float16;

// Upstream's rule (pocket_tts prepare_text_prompt): a very short prompt gets more frames
// after the EOS logit fires so its last word is not clipped.
const framesAfterEos = (text: string): number => (text.trim().split(/\s+/).length <= 4 ? 5 : 3);

// ── probe ───────────────────────────────────────────────────────────────────────────

const unsupported = (reason: Extract<Support, { kind: "unsupported" }>["reason"]): Support => ({
  kind: "unsupported",
  reason,
});

export const probeWebGpu = async (): Promise<Support> => {
  const gpu = navigator.gpu;
  if (gpu === undefined) return unsupported({ kind: "no-webgpu" });
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (adapter === null) return unsupported({ kind: "no-adapter" });
  // [LAW:parse-dont-validate] The adapter's own feature set is the f16 fact; it is read here,
  // not inferred from whichever error a later op happens to throw.
  if (!adapter.features.has("shader-f16")) return unsupported({ kind: "no-f16" });
  let devices: ReadonlyArray<string>;
  try {
    devices = await init("webgpu");
  } catch (e) {
    return unsupported({ kind: "no-device", message: e instanceof Error ? e.message : String(e) });
  }
  if (!devices.includes("webgpu")) {
    return unsupported({ kind: "no-device", message: "jax-js could not create a WebGPU device" });
  }
  defaultDevice("webgpu");
  // A device that advertises f16 but cannot run one f16 op is a device that failed, and the
  // reason it gives is kept [LAW:no-silent-failure].
  try {
    await np.ones([1], { dtype: np.float16 }).mul(2).data();
  } catch (e) {
    return unsupported({ kind: "no-device", message: `a float16 op failed: ${e instanceof Error ? e.message : String(e)}` });
  }
  return { kind: "supported", backend: "webgpu" };
};

// ── load ────────────────────────────────────────────────────────────────────────────

// [LAW:parse-dont-validate] The voice file's one tensor, proven present. A voice safetensors
// without `audio_prompt` is a corrupt asset — the hash matched, so this cannot happen for
// the bytes the manifest names — and is a thrown load failure, never a silent default voice.
const voicePrompt = (id: VoiceId, bytes: Uint8Array<ArrayBuffer>): np.Array => {
  const tensor = safetensors.parse(bytes).tensors["audio_prompt"];
  if (tensor === undefined || tensor.dtype !== "F32") {
    throw new Error(`voice ${id}: expected an F32 audio_prompt tensor, got ${tensor?.dtype ?? "nothing"}`);
  }
  return np
    .array(tensor.data as Float32Array<ArrayBuffer>, { shape: tensor.shape, dtype: np.float32 })
    .slice(0)
    .astype(WEIGHT_DTYPE);
};

// [LAW:parse-dont-validate] How many cache positions a voice prompt occupies: the leading
// dimension of its [frames, dim] tensor.
export const promptFrames = (id: VoiceId, prompt: np.Array): number => {
  const [frames, dim] = prompt.shape;
  if (prompt.shape.length !== 2 || frames === undefined || dim === undefined) {
    throw new Error(`voice ${id}: expected a [frames, dim] prompt, got shape [${prompt.shape.join(", ")}]`);
  }
  return frames;
};

// [LAW:one-source-of-truth] The tokenizer and the piece string of every token id, from ONE
// parse of the model file: jax-js builds its tokenizer from the proto and exposes ids only,
// and an id is an index into that proto's pieces — what `tokenSpans` walks over the text.
export interface Tokenizer {
  readonly encode: (text: string) => number[];
  readonly pieces: ReadonlyArray<string>;
}

// TEMPORARY, until jax-js walks text by code point. Its Unigram encoder indexes the string
// by UTF-16 unit, so each half of a surrogate pair reaches the byte fallback as a lone
// surrogate and comes out as U+FFFD's bytes, where SentencePiece emits the character's own.
// So `encode` hands jax-js one U+FFFD per astral character — a character no piece contains,
// so the lattice is cut around it exactly as around the real one — and writes the real
// character's byte pieces where the stand-in's come out; a U+FFFD the text itself holds
// comes out as itself. scripts/tokenizer-check.ts proves the ids against the reference's.
const STAND_IN = "\uFFFD";
const STAND_IN_OR_ASTRAL = /\uFFFD|[\u{10000}-\u{10FFFF}]/gu;

export const parseTokenizer = (bytes: Uint8Array): Tokenizer => {
  const proto = fromBinary(ModelProtoSchema, bytes);
  // [LAW:single-enforcer] `tokenSpans` walks text the way this model's tokenizer normalises
  // it — a boundary prepended, every space a boundary, nothing else — and that assumption is
  // checked here, once, against the model file.
  const spec = proto.normalizerSpec;
  if (spec?.name !== "identity" || spec.addDummyPrefix !== true || spec.removeExtraWhitespaces !== false) {
    throw new Error(`the tokenizer normalises text (${spec?.name}, dummy prefix ${spec?.addDummyPrefix}, extra whitespace removed ${spec?.removeExtraWhitespaces}) in a way tokenSpans does not walk`);
  }
  const pieces = proto.pieces.map((piece) => piece.piece);
  if (pieces.some((piece) => piece.match(STAND_IN_OR_ASTRAL) !== null)) {
    throw new Error("the tokenizer has a piece containing U+FFFD or an astral character; the stand-in would not be exact");
  }
  const jax = new tokenizers.SentencePiece(proto);
  // [LAW:parse-dont-validate] The id of each byte's fallback piece, keyed by the value its
  // "<0xNN>" spelling names; the model file types the byte pieces, so their spelling is read,
  // not matched. A model without one piece per byte cannot spell every character, thrown.
  const byteIds = new Map(
    proto.pieces.flatMap((piece, id): [number, number][] =>
      piece.type === ModelProto_SentencePiece_Type.BYTE ? [[parseInt(piece.piece.slice(3, 5), 16), id]] : []),
  );
  if (byteIds.size !== 256 || [...byteIds.keys()].some((byte) => !(byte >= 0 && byte < 256))) {
    throw new Error(`the tokenizer has ${byteIds.size} byte pieces where one per byte 0..255 is needed`);
  }
  const bytesOf = (char: string): number[] =>
    Array.from(new TextEncoder().encode(char), (byte) => {
      const id = byteIds.get(byte);
      if (id === undefined) throw new RangeError(`byte ${byte} outside the 256 proven above`);
      return id;
    });
  const standIn = bytesOf(STAND_IN);
  const encode = (text: string): number[] => {
    const chars = Array.from(text.matchAll(STAND_IN_OR_ASTRAL), (match) => match[0]);
    const ids: number[] = [];
    let next = 0;
    for (const id of jax.encode(text.replace(STAND_IN_OR_ASTRAL, STAND_IN))) {
      ids.push(id);
      const tail = ids.length - standIn.length;
      if (tail >= 0 && standIn.every((byte, j) => ids[tail + j] === byte)) {
        const char = chars[next++];
        if (char === undefined) throw new Error(`stand-in bytes at token ${tail} of ${JSON.stringify(text)} match no character`);
        ids.splice(tail, standIn.length, ...bytesOf(char));
      }
    }
    if (next !== chars.length) throw new Error(`${chars.length - next} of the characters of ${JSON.stringify(text)} were not tokenized`);
    return ids;
  };
  return { encode, pieces };
};

interface Hydrated extends Tokenizer {
  readonly model: PocketTTS;
  readonly voices: Readonly<Record<VoiceId, np.Array>>;
}

const hydrate = (bytesOf: (asset: ModelAsset) => Uint8Array<ArrayBuffer>): Hydrated => ({
  ...parseTokenizer(bytesOf(MODEL_ASSETS.tokenizer)),
  model: fromSafetensors(safetensors.parse(bytesOf(MODEL_ASSETS.weights)), WEIGHT_DTYPE),
  voices: Object.fromEntries(
    VOICE_IDS.map((id) => [id, voicePrompt(id, bytesOf(MODEL_ASSETS.voices[id]))]),
  ) as Record<VoiceId, np.Array>,
});

// [LAW:parse-dont-validate] An id `encode` produced is an index into its own pieces; a miss
// is thrown, never a skipped token.
export const pieceOf = (pieces: ReadonlyArray<string>, id: number): string => {
  const piece = pieces[id];
  if (piece === undefined) throw new Error(`token id ${id} is not among the tokenizer's ${pieces.length} pieces`);
  return piece;
};

// ── generation ──────────────────────────────────────────────────────────────────────

const readback = async (audio: np.Array): Promise<Float32Array<ArrayBuffer>> => {
  const pcm = await np.clip(audio.slice(0), -1, 1).astype(np.float32).data();
  if (!(pcm instanceof Float32Array) || pcm.length !== MODEL_ASSETS.weights.frameSamples) {
    throw new Error(`expected ${MODEL_ASSETS.weights.frameSamples} float32 samples per frame, got ${pcm.length}`);
  }
  return pcm;
};

// What one step says, read back from the device as one row: the EOS bit first, then the
// read-out's logit for each of the unit's `tokenCount` text tokens.
interface StepReading {
  readonly eos: boolean;
  readonly logits: Float32Array;
}

// [LAW:parse-dont-validate] The row is proven to be one bit plus one logit per token
// before either is read; a different length is a read-out over the wrong positions.
export const readStep = async (isEos: np.Array, logits: np.Array, tokenCount: number): Promise<StepReading> => {
  const row = await np.concatenate([isEos.astype(np.float32).reshape([1]), logits]).data();
  const eos = row.at(0);
  if (!(row instanceof Float32Array) || row.length !== tokenCount + 1 || eos === undefined) {
    throw new Error(`expected an EOS bit and ${tokenCount} attention logits, got ${row.length} values`);
  }
  return { eos: eos !== 0, logits: row.subarray(1) };
};

// A decoded frame on its way back from the device, with the unit scores of the step that
// produced it: the pair the alignment machine consumes.
interface PendingFrame {
  readonly pcm: Promise<Float32Array<ArrayBuffer>>;
  readonly scores: Float64Array;
}

async function* generate(
  { model, encode, pieces, voices }: Hydrated,
  unit: UnitText,
  voice: VoiceId,
): AsyncGenerator<Float32Array<ArrayBuffer>, GenerationEnd> {
  const ids = encode(unit.text);
  const plan = planAlignment(unit, ids.map((id) => pieceOf(pieces, id)));
  const aligner = createWordAligner(plan);
  const modelRef = tree.ref(model);
  const tokens = np.array(ids, { dtype: np.uint32 });
  const embeds = np.concatenate([voices[voice].ref, model.flowLM.conditionerEmbed.ref.slice(tokens)]);
  const afterEos = framesAfterEos(unit.text);
  // The cache positions of the text tokens: right after the voice prompt's frames.
  const textStart = promptFrames(voice, voices[voice]);
  const readout = { ...MODEL_ASSETS.weights.readout, textStart, textEnd: textStart + ids.length };

  let lastLatent = model.flowLM.bosEmb.ref.reshape([1, -1]); // [1, 32]
  let key = random.key(SEED);
  let flowLMState = createFlowLMState(model.flowLM);
  let mimiState = createMimiDecodeState(model.mimi);
  let pending: PendingFrame | null = null;
  let frames = 0;
  let eosStep: number | null = null;

  // The frame in flight, once its PCM has landed: the alignment machine sees it exactly
  // when it is handed on, so a cancel between frames leaves no frame half-processed.
  const settle = async (frame: PendingFrame): Promise<Float32Array<ArrayBuffer>> => {
    const pcm = await frame.pcm;
    aligner.frame(frame.scores, isVoiced(pcm), frames * FRAME_MS);
    frames++;
    return pcm;
  };

  try {
    for (let step = 0; step < MAX_UNIT_FRAMES; step++) {
      // Two keys off the current one: the first carries forward, the second seeds this step.
      const keys = random.split(key);
      key = keys.ref.slice(0);
      const stepKey = keys.slice(1);
      const { latent, isEos, logits, state } = runFlowLMStep(
        tree.ref(modelRef.flowLM),
        flowLMState,
        stepKey,
        lastLatent.ref,
        step === 0 ? embeds.ref : null,
        flowLMState.kvCacheLen,
        readout,
        LSD_DECODE_STEPS,
        TEMPERATURE,
        null,
      );
      flowLMState = state;
      // The step's latent is owned by `lastLatent` before anything can throw, so `finally`
      // releases it on every exit.
      lastLatent.dispose();
      lastLatent = latent;

      const reading = await readStep(isEos, logits, ids.length);
      if (reading.eos && eosStep === null) eosStep = step;
      if (eosStep !== null && step >= eosStep + afterEos) {
        if (pending !== null) yield await settle(pending);
        return { kind: "eos", alignment: { kind: "words", times: aligner.finish(frames * FRAME_MS) } };
      }

      const mimiInput = lastLatent.ref.mul(modelRef.flowLM.embStd.ref).add(modelRef.flowLM.embMean.ref);
      const [audio, nextMimiState] = runMimiDecode(tree.ref(modelRef.mimi), mimiState, mimiInput);
      mimiState = nextMimiState;

      const previous = pending;
      pending = { pcm: readback(audio), scores: unitScores(plan, reading.logits) };
      if (previous !== null) yield await settle(previous);
    }
    if (pending !== null) yield await settle(pending);
    return { kind: "frame-cap" };
  } finally {
    // A cancel lands with a frame's readback in flight; it settles before the device
    // memory it reads from is released, and its rejection is the generation's own. The
    // carried-forward key is the one array the loop leaves unconsumed on every exit.
    if (pending !== null) await pending.pcm;
    lastLatent.dispose();
    key.dispose();
    tree.dispose([modelRef, embeds, flowLMState, mimiState]);
  }
}

// ── the runtime ─────────────────────────────────────────────────────────────────────

export const pocketTtsRuntime = (io: AssetIo): SynthesisRuntime => ({
  probe: probeWebGpu,
  load: async (onProgress: (progress: AssetProgress) => void, signal: AbortSignal): Promise<LoadResult> => {
    const assets = allModelAssets(MODEL_ASSETS);
    // Stale copies of an earlier model build go first, so their quota is free before the
    // new bytes land.
    await pruneStaleAssets(io.store, assets);
    // The handler's abort joins the loader's own per-asset abort on every part's fetch.
    const fetch: FetchLike = (url, init) => io.fetch(url, { signal: AbortSignal.any([init.signal, signal]) });
    const outcome = await loadAssets(assets, { ...io, fetch }, onProgress);
    if (!outcome.ok) return { ok: false, failure: outcome.failure };
    // [LAW:parse-dont-validate] loadAssets returns one LoadedAsset per asset it was given,
    // as the same asset objects; a miss here is a broken loader, not a case to skip.
    const bytesOf = (asset: ModelAsset): Uint8Array<ArrayBuffer> => {
      const loaded = outcome.loaded.find((l) => l.asset === asset);
      if (loaded === undefined) throw new Error(`loader returned no bytes for ${asset.name}`);
      return loaded.data;
    };
    const hydrated = hydrate(bytesOf);
    const model: LoadedModel = {
      backend: "webgpu",
      countTokens: (text) => hydrated.encode(text).length,
      generate: (unit, voice) => generate(hydrated, unit, voice),
      dispose: () => tree.dispose([hydrated.model, hydrated.voices]),
    };
    return { ok: true, model };
  },
});
