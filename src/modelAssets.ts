// [LAW:decomposition] The model-asset manifest: WHICH bytes the in-browser Pocket TTS
// runtime needs, pinned by content, and WHERE the site serves them. One sentence, no
// "and" — this module names assets and derives their addresses. It fetches nothing and
// stores nothing: fetching is modelAssetLoader.ts (browser edge) and the build-time
// mirror is scripts/fetch-model-assets.ts (deploy edge) [LAW:effects-at-boundaries].
// Both derive every path from this one table, so the bytes a build publishes and the
// bytes a browser asks for can never be addressed two different ways
// [LAW:one-source-of-truth].
//
// WHY THE SITE SERVES ITS OWN COPIES. The runtime the q35.1 spike chose (jax-js) reads a
// 236 MB fp16 safetensors build published under a personal HuggingFace account, and the
// voice embeddings and tokenizer from Kyutai's ungated repo. Pinned-commit URLs there are
// immutable today, but the site's core feature would then depend on a third party's
// hosting decisions. Mirroring the bytes we measured — and checking their SHA-256 at
// every hop — makes "the model the spike tested" a verified fact instead of a hope.
//
// WHY SHARDS. Workers Static Assets cap a single file at 25 MiB, so the weights cannot
// be one file there, and R2 would add a bucket, a binding and a second credential scope
// the epic forbids. Every asset — tiny tokenizer and 236 MB weights alike — is published
// as `<key>.part<N>` files cut by ONE rule [LAW:dataflow-not-control-flow]: no "if it is
// big, shard it" branch anywhere; the small ones simply have one part.
//
// WHY CONTENT-ADDRESSED PATHS. An asset's URL stem carries a prefix of its own SHA-256, so
// new bytes are a new URL by construction and an old cached copy is merely unused — never
// migrated, never confused with the new one [LAW:no-ambient-temporal-coupling]. Nobody has
// to remember to bump a version string when a hash changes: MODEL_VERSION is derived from
// the hashes, so it changes exactly when the bytes do [FRAMING:representation].

// [LAW:types-are-the-program] A pinned asset. `sha256` is the identity the loader verifies
// after download and the build script verifies before publishing; `source` is provenance —
// the exact upstream URL the bytes were mirrored from — never something the browser fetches.
export interface ModelAsset {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: string;
  readonly licence: "MIT" | "CC0-1.0" | "CC-BY-4.0";
  readonly attribution: string;
}

// The six voice candidates the q35.1 spike produced samples for, under CC0 or CC-BY-4.0
// only (expresso and ears voices are CC-BY-NC and are excluded). All six are hosted so the
// per-role pick — the user's, by ear — is a VALUE (the voice map in the speech script), not
// an asset redeploy.
export const VOICE_IDS = ["alba", "marius", "javert", "fantine", "eponine", "azelma"] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

const KYUTAI_VOICES =
  "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/fbf82802feb1f92664f3bcf6a0f01295a678853c";

// [LAW:types-are-the-program] What a hosted voice is declared with, each fact named: a
// catalogue of fifty voices (slopspot-voices-9p4.3d3) is fifty of these, and a positional
// list of seven would let two strings swap places without a word from the compiler.
interface VoiceEntry {
  readonly id: VoiceId;
  readonly bytes: number;
  readonly sha256: string;
  readonly licence: "CC0-1.0" | "CC-BY-4.0";
  readonly attribution: string;
  readonly sample: Pinned;
  readonly qualities: VoiceQualities;
}

const voice = ({ id, bytes, sha256, licence, attribution, sample, qualities }: VoiceEntry): VoiceAsset => ({
  name: `voice-${id}`,
  bytes,
  sha256,
  sample,
  qualities,
  source: `${KYUTAI_VOICES}/embeddings/${id}.safetensors`,
  licence,
  attribution,
});

// [LAW:types-are-the-program] The checkpoint is the weights asset plus the facts about those
// bytes that the rest of the pipeline reads, so they live on them: a swapped checkpoint
// literal must restate each, and cannot inherit the old one. `maxUnitTokens` is the most
// text tokens one generation may be asked to say — the model is trained on single
// sentences; upstream's MAX_TOKEN_PER_CHUNK is 50 for this build and its own TODO notes
// that english_2026-04 "supports bigger chunks"; over the budget the model skips words.
// `sampleRate` and `frameSamples` are the Mimi codec this checkpoint decodes through: PCM
// rate and the samples one generation step yields; the manifest's `sampleRate` and every
// frame-time reading derive from here. `readout` is the FlowLM attention head whose per-
// frame attention over the text tokens tracks the word being said (wordAlignment.ts): a
// fact about the trained weights, so a hosted checkpoint must declare it — there is no
// "no head known" arm in the runtime, and a checkpoint without one cannot be hosted.
export interface Readout {
  readonly layer: number;
  readonly head: number;
}

export interface Checkpoint extends ModelAsset {
  readonly maxUnitTokens: number;
  readonly sampleRate: number;
  readonly frameSamples: number;
  readonly readout: Readout;
  // The checkpoint's name in Pocket TTS's own release catalogue (its `language` argument):
  // what renders a voice's sample on the same model the browser runs.
  readonly release: string;
}

// [LAW:types-are-the-program] Bytes pinned by their hash, and nothing else known of them.
export interface Pinned {
  readonly bytes: number;
  readonly sha256: string;
}

// [LAW:types-are-the-program] Whether a voice sounds like a man or a woman, as a reader
// hears it. A synthesized voice is nobody, so this is a quality of the sound and not a
// claim about a person.
export type VoiceRegister = "masculine" | "feminine";

// What a voice is like, in the plain words a reader picks by (slopspot-voices-9p4.0ya).
// `accent` stays a string because the catalogue's accents are open-ended; the register is
// two words because a row can only be one of them, and a filter over the rows is a filter
// over these [LAW:one-source-of-truth].
export interface VoiceQualities {
  // How it sounds, two words: "Deep and breathy".
  readonly character: string;
  // Where it sounds from: "American", "Scottish", "North American".
  readonly accent: string;
  readonly register: VoiceRegister;
}

// A hosted voice: its embedding, the sample rendered from it (voiceSample.ts) pinned beside
// it so a sample can never quietly stand for other bytes than the voice's own, and what it
// sounds like.
//
// HOW THE QUALITIES WERE ARRIVED AT. Not from the corpora's speaker sheets, which describe
// the person who was recorded rather than the voice this model synthesizes, and not from
// the names — Kyutai's Les Misérables names mislead, and Alba, a woman's name, is a man's
// voice. Each was measured from the voice's own donated recording and from the sample the
// reader hears: pitch and its range (median f0), pace (words over the sample's speech),
// texture (harmonics-to-noise, jitter and shimmer — Javert and Marius read low because the
// donors' voices are breathy and raspy, not because the recordings are noisy: denoising
// them moves nothing), accent by a CommonAccent classifier over the recording in chunks,
// and register by an age-and-gender classifier. A new voice is described the same way.
export interface VoiceAsset extends ModelAsset {
  readonly sample: Pinned;
  readonly qualities: VoiceQualities;
}

export interface ModelAssetManifest {
  readonly weights: Checkpoint;
  readonly tokenizer: ModelAsset;
  readonly voices: Readonly<Record<VoiceId, VoiceAsset>>;
}

// Pocket TTS build b6369a24 (Kyutai's english_2026-01 checkpoint) converted to fp16 for
// jax-js by its author; weights CC-BY-4.0 from Kyutai, conversion MIT. Sizes and hashes
// were read from HuggingFace's LFS metadata on 2026-09-10 and re-verified against the
// downloaded bytes.
export const MODEL_ASSETS: ModelAssetManifest = {
  weights: {
    name: "weights",
    maxUnitTokens: 50,
    sampleRate: 24000,
    frameSamples: 1920,
    // dpm63/pocket-tts-timestamped configs: timestamp_heads is layer 3 head 8 for both
    // english checkpoints (english_2026-01, which these weights are, and english_2026-04,
    // which its accuracy was measured on); the 24-layer build would be layer 14 head 10.
    readout: { layer: 3, head: 8 },
    release: "english_2026-01",
    bytes: 235738516,
    sha256: "792e653ea1604197bf6bd2a76ac355f5ec41ef88961bf1dbf729d027d6e20f6c",
    source:
      "https://huggingface.co/ekzhang/jax-js-models/resolve/2b0fc51b4f76ff56611741ab9267593decde7639/kyutai-pocket-tts_b6369a24-fp16.safetensors",
    licence: "CC-BY-4.0",
    attribution: "Kyutai Pocket TTS (b6369a24), fp16 conversion by Eric Zhang for jax-js",
  },
  tokenizer: {
    name: "tokenizer",
    bytes: 59339,
    sha256: "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6",
    source: `${KYUTAI_VOICES}/tokenizer.model`,
    licence: "CC-BY-4.0",
    attribution: "Kyutai Pocket TTS SentencePiece tokenizer",
  },
  voices: {
    alba: voice({
      id: "alba",
      bytes: 512088,
      sha256: "ad234695323e4030336b6afc8a050c97e3110603e11ecd8226d9562488300a50",
      licence: "CC-BY-4.0",
      attribution: "alba-mackenna/casual via Kyutai tts-voices",
      sample: { bytes: 24810, sha256: "8f00054d5f28fc6f57f5dd8af8b7b48348215d4f2cf0bce2bf45b252f8bfe4b6" },
      qualities: { character: "Low and lively", accent: "American", register: "masculine" },
    }),
    marius: voice({
      id: "marius",
      bytes: 512088,
      sha256: "33f75e45fac0005630671f4b1bb632d51b6a083b18417de94855bbd7596a0630",
      licence: "CC0-1.0",
      attribution: "voice-donations/Selfie via Kyutai tts-voices",
      sample: { bytes: 21820, sha256: "f8442c6bd2cb0ff95ba8aba8ccb765fc55266f51f45a3fde240e907bacb20219" },
      qualities: { character: "Raspy and quick", accent: "American", register: "masculine" },
    }),
    javert: voice({
      id: "javert",
      bytes: 512088,
      sha256: "2e857904ee76657e083b0e92664d21bd133e37df320af6eb04f752e679422d91",
      licence: "CC0-1.0",
      attribution: "voice-donations/Butter via Kyutai tts-voices",
      sample: { bytes: 39672, sha256: "db03a37eedc8df9bc6490f2ea76cf7a405b968c94e0c8b58bac2f2dc7eb5af0f" },
      qualities: { character: "Deep and breathy", accent: "American", register: "masculine" },
    }),
    fantine: voice({
      id: "fantine",
      bytes: 540760,
      sha256: "b6918a2ece002d2d9037ff53c4ea38730175e8798786658b0958443edf49d355",
      licence: "CC-BY-4.0",
      attribution: "VCTK p244 via Kyutai tts-voices",
      sample: { bytes: 21805, sha256: "004cad76ecfda9939c6a355bbba5a27de2c0dbea915d0c648875b6b8106bd592" },
      qualities: { character: "Bright and quick", accent: "English", register: "feminine" },
    }),
    eponine: voice({
      id: "eponine",
      bytes: 573528,
      sha256: "bb31940f62da665391de139da2e57d740757df26b73d7ec24152c78a3b8ac0c5",
      licence: "CC-BY-4.0",
      attribution: "VCTK p262 via Kyutai tts-voices",
      sample: { bytes: 28241, sha256: "9a1be33f7646d06fc8ac6b75cda3be47cb5a9ff8c1f12bf4d95dc76995532ef8" },
      qualities: { character: "Warm and even", accent: "Scottish", register: "feminine" },
    }),
    azelma: voice({
      id: "azelma",
      bytes: 659544,
      sha256: "ef33fad34437cb187d2702f0a946d8ba7a01efdb8efbc8088c770d49c181ba73",
      licence: "CC-BY-4.0",
      attribution: "VCTK p303 via Kyutai tts-voices",
      sample: { bytes: 37903, sha256: "5f41ad6fec65b06b99b8eb7dfa80145f1f7141e53300ffabf3b00e70dbad6c41" },
      qualities: { character: "Clear and unhurried", accent: "North American", register: "feminine" },
    }),
  },
};

export const allModelAssets = (manifest: ModelAssetManifest): readonly ModelAsset[] => [
  manifest.weights,
  manifest.tokenizer,
  ...VOICE_IDS.map((id) => manifest.voices[id]),
];

// The site path every asset is published under; public/_headers keys its immutable
// cache and CORS rules on this same prefix, and the loader prunes stale cache entries
// under it. Three readers, one string.
export const MODEL_ASSET_PREFIX = "/models/";

// 24 MiB: the largest round size under the 25 MiB per-file ceiling of Workers Static
// Assets. The weights become ten parts; everything else one.
export const SHARD_BYTES = 24 * 1024 * 1024;

// The hash prefix that names an asset's bytes in its url — a model part's and a voice
// sample's alike (voiceSample.ts).
export const SHA_PREFIX_CHARS = 12;

// [LAW:one-source-of-truth] The asset's address stem AND its cache key — the same string,
// so a cached entry can only ever mean the bytes published at that path.
export const assetKey = (asset: ModelAsset): string =>
  `${MODEL_ASSET_PREFIX}${asset.name}-${asset.sha256.slice(0, SHA_PREFIX_CHARS)}`;

export interface Shard {
  readonly url: string;
  readonly start: number;
  readonly end: number;
}

// [LAW:dataflow-not-control-flow] The one cut rule. ceil(bytes / SHARD_BYTES) contiguous
// half-open ranges, at least one (an empty asset would still name one part; none is empty).
export const shardPlan = (asset: ModelAsset): readonly Shard[] => {
  const key = assetKey(asset);
  const count = Math.max(1, Math.ceil(asset.bytes / SHARD_BYTES));
  return Array.from({ length: count }, (_, i) => ({
    url: `${key}.part${i}`,
    start: i * SHARD_BYTES,
    end: Math.min(asset.bytes, (i + 1) * SHARD_BYTES),
  }));
};

// [FRAMING:representation] An asset's identity, redrawn by the machine from its hash
// rather than remembered by a human: it changes exactly when a published byte does.
export const assetVersion = (asset: ModelAsset): string => `${asset.name}@${asset.sha256.slice(0, SHA_PREFIX_CHARS)}`;

// The whole model's identity — what the synthesis worker reports it has loaded.
export const modelVersion = (manifest: ModelAssetManifest): string => allModelAssets(manifest).map(assetVersion).join(",");

export const MODEL_VERSION = modelVersion(MODEL_ASSETS);

// The speech script's unit budget: the same fact as the checkpoint's field, read from it.
export const MAX_UNIT_TOKENS = MODEL_ASSETS.weights.maxUnitTokens;

export const SAMPLE_RATE = MODEL_ASSETS.weights.sampleRate;

// One generation step of audio in milliseconds (80 for this codec): the grain every
// measured word time lands on.
export const FRAME_MS = (MODEL_ASSETS.weights.frameSamples / MODEL_ASSETS.weights.sampleRate) * 1000;

// A 236 MB download must not start on a metered connection without a tap. This is the
// pure fact the UI reads to decide whether Play may download implicitly; the Network
// Information API exposes it only on Chromium, so an absent reading means "unknown" and
// is honestly not a metered signal.
export interface ConnectionReading {
  readonly saveData?: boolean;
  readonly type?: string;
}

export const downloadNeedsTap = (connection: ConnectionReading | undefined): boolean =>
  connection?.saveData === true || connection?.type === "cellular";
