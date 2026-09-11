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

import { defaultDevice, init, numpy as np, random, tree } from "@jax-js/jax";
import { safetensors, tokenizers } from "@jax-js/loaders";
import { loadAssets, pruneStaleAssets, type AssetIo, type AssetProgress, type FetchLike } from "./modelAssetLoader";
import { MODEL_ASSETS, VOICE_IDS, allModelAssets, type ModelAsset, type VoiceId } from "./modelAssets";
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
  try {
    await np.ones([1], { dtype: np.float16 }).mul(2).data();
  } catch {
    return unsupported({ kind: "no-f16" });
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

interface Hydrated {
  readonly model: PocketTTS;
  readonly tokenizer: tokenizers.SentencePiece;
  readonly voices: Readonly<Record<VoiceId, np.Array>>;
}

const hydrate = (bytesOf: (asset: ModelAsset) => Uint8Array<ArrayBuffer>): Hydrated => ({
  model: fromSafetensors(safetensors.parse(bytesOf(MODEL_ASSETS.weights)), WEIGHT_DTYPE),
  tokenizer: tokenizers.SentencePiece.fromBinary(bytesOf(MODEL_ASSETS.tokenizer)),
  voices: Object.fromEntries(
    VOICE_IDS.map((id) => [id, voicePrompt(id, bytesOf(MODEL_ASSETS.voices[id]))]),
  ) as Record<VoiceId, np.Array>,
});

// ── generation ──────────────────────────────────────────────────────────────────────

const readback = async (audio: np.Array): Promise<Float32Array<ArrayBuffer>> => {
  const pcm = await np.clip(audio.slice(0), -1, 1).astype(np.float32).data();
  if (!(pcm instanceof Float32Array) || pcm.length !== MODEL_ASSETS.frameSamples) {
    throw new Error(`expected ${MODEL_ASSETS.frameSamples} float32 samples per frame, got ${pcm.length}`);
  }
  return pcm;
};

async function* generate(
  { model, tokenizer, voices }: Hydrated,
  text: string,
  voice: VoiceId,
): AsyncGenerator<Float32Array<ArrayBuffer>, GenerationEnd> {
  const modelRef = tree.ref(model);
  const tokens = np.array(tokenizer.encode(text), { dtype: np.uint32 });
  const embeds = np.concatenate([voices[voice].ref, model.flowLM.conditionerEmbed.ref.slice(tokens)]);
  const afterEos = framesAfterEos(text);

  let lastLatent = model.flowLM.bosEmb.ref.reshape([1, -1]); // [1, 32]
  let key = random.key(SEED);
  let flowLMState = createFlowLMState(model.flowLM);
  let mimiState = createMimiDecodeState(model.mimi);
  let pending: Promise<Float32Array<ArrayBuffer>> | null = null;
  let eosStep: number | null = null;

  try {
    for (let step = 0; step < MAX_UNIT_FRAMES; step++) {
      // Two keys off the current one: the first carries forward, the second seeds this step.
      const keys = random.split(key);
      key = keys.ref.slice(0);
      const stepKey = keys.slice(1);
      const { latent, isEos, state } = runFlowLMStep(
        tree.ref(modelRef.flowLM),
        flowLMState,
        stepKey,
        lastLatent.ref,
        step === 0 ? embeds.ref : null,
        flowLMState.kvCacheLen,
        LSD_DECODE_STEPS,
        TEMPERATURE,
        null,
      );
      flowLMState = state;

      const eos = await isEos.data();
      if (eos[0] && eosStep === null) eosStep = step;
      if (eosStep !== null && step >= eosStep + afterEos) {
        latent.dispose();
        if (pending !== null) yield await pending;
        return { kind: "eos", alignment: { kind: "unit" } };
      }

      const prevLatent = lastLatent;
      lastLatent = latent;
      prevLatent.dispose();

      const mimiInput = latent.ref.mul(modelRef.flowLM.embStd.ref).add(modelRef.flowLM.embMean.ref);
      const [audio, nextMimiState] = runMimiDecode(tree.ref(modelRef.mimi), mimiState, mimiInput);
      mimiState = nextMimiState;

      const previous = pending;
      pending = readback(audio);
      if (previous !== null) yield await previous;
    }
    if (pending !== null) yield await pending;
    return { kind: "frame-cap" };
  } finally {
    // A cancel lands with a frame's readback in flight; it settles before the device
    // memory it reads from is released, and its rejection is the generation's own.
    if (pending !== null) await pending;
    lastLatent.dispose();
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
      countTokens: (text) => hydrated.tokenizer.encode(text).length,
      generate: (text, voice) => generate(hydrated, text, voice),
      dispose: () => tree.dispose([hydrated.model, hydrated.voices]),
    };
    return { ok: true, model };
  },
});
