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

// [LAW:types-are-the-program] Where an asset's bytes come from, as one value that carries
// its whole provenance — so no asset can half-name a source, and the deploy edge decides
// nothing: it reads the arm it is given (scripts/modelAssetMirror.ts).
//
// `mirrored` is the ordinary case: upstream publishes these exact bytes at this URL, and
// the build fetches and hash-checks them.
//
// `exported` is the voices Kyutai now publishes ONLY as an already-prompted flow-model
// state — six layers of KV cache, 6–8 MB, a shape pocketTtsRuntime.ts has no way to speak
// from. The prompt it was made of is recovered by encoding the recording upstream also
// publishes (scripts/export-voice-prompt.py says how, and why it uses this site's own
// weights), which is the same operation Kyutai's export-voice performs. Those bytes cannot
// be fetched from anywhere, so they live in the repo under `exportedVoiceFile`; `upstream`
// is the primed state the export is proven against, which is what keeps this an act of
// recovery rather than of invention [FRAMING:representation].
export type AssetOrigin =
  | { readonly kind: "mirrored"; readonly url: string }
  | { readonly kind: "exported"; readonly recording: string; readonly upstream: string };

// [LAW:types-are-the-program] A pinned asset. `sha256` is the identity the loader verifies
// after download and the build script verifies before publishing; `source` is provenance —
// where the bytes came from — never something the browser fetches.
export interface ModelAsset {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: AssetOrigin;
  readonly licence: "MIT" | "CC0-1.0" | "CC-BY-4.0";
  readonly attribution: string;
  // The SHA-256 of each published part, in order. WHY A PART IS PINNED AND NOT ONLY THE
  // WHOLE: a device proves what it has by hashing it, and hashing is not a streaming
  // operation in any browser — so an asset whose only stated identity is the whole file can
  // only be proven by holding the whole file, which for the 236 MB checkpoint cost a phone
  // its tab (slopspot-read-along-i9a). Pinned per part, the same bytes are proven 24 MiB at
  // a time and nothing ever holds more than one.
  //
  // An asset cut into ONE part IS that part, so `asset.sha256` already IS its part's hash
  // and naming it twice would be two clocks over one fact [LAW:one-source-of-truth]. Only a
  // cut asset carries a list, and `shardPlan` is the one place that derivation is made.
  readonly parts?: readonly string[];
}

// The voices this site hosts, in the order the picker offers them: by name, so a reader
// scanning a list of eleven can find one again. Every one of them was chosen BY EAR from a
// twenty-two voice audition (slopspot-voices-9p4.3d3) — measurement described them, it did
// not pick them. Under CC0 or CC-BY-4.0 only: the expresso and ears corpora are CC-BY-NC
// and are excluded, which is also why Cosette, of Kyutai's original eight, is not here.
//
// All eleven are hosted so the per-role pick — the reader's, by ear — is a VALUE (the voice
// map in the speech script), not an asset redeploy.
export const VOICE_IDS = [
  "caro_davy",
  "charles",
  "eponine",
  "eve",
  "george",
  "jane",
  "javert",
  "michael",
  "paul",
  "peter_yearsley",
  "vera",
] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

// Kyutai's first eight voices, published as the prompt the runtime speaks with.
const KYUTAI_VOICES =
  "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/fbf82802feb1f92664f3bcf6a0f01295a678853c";

// The catalogue as it stands now: every voice added since, as a primed state only.
const KYUTAI_CATALOGUE =
  "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/e81d79e8194ad4c7ce879c87a4258ef20cbf2487/embeddings_v3";

// The recordings all of them were made of — VCTK's speakers, LibriVox's readers, and the
// donations — which is the corpus this catalogue is drawn from.
const KYUTAI_RECORDINGS = "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a";

const mirrored = (url: string): AssetOrigin => ({ kind: "mirrored", url });

// [LAW:types-are-the-program] Where a voice's bytes come from, as a function OF THE VOICE
// rather than a finished value: an entry chooses the kind and says only what the id cannot
// already say, and the id is applied to it below. An entry therefore cannot name one voice
// and point at another's bytes — the slip that would ship voice B's sound under voice A's
// name is not expressible.
type VoiceOrigin = (id: VoiceId) => AssetOrigin;

// One of Kyutai's original eight, whose prompt they publish.
const kyutaiPrompt: VoiceOrigin = (id) => mirrored(`${KYUTAI_VOICES}/embeddings/${id}.safetensors`);

// A voice they publish only as a primed state: exported here from the recording it was made
// of, and proven against that state. The recording is the one fact the id does not carry.
const exportedFrom =
  (recording: string): VoiceOrigin =>
  (id) => ({
    kind: "exported",
    recording: `${KYUTAI_RECORDINGS}/${recording}`,
    upstream: `${KYUTAI_CATALOGUE}/${id}.safetensors`,
  });

// [LAW:types-are-the-program] What a hosted voice is declared with, each fact named: a
// catalogue of fifty voices (slopspot-voices-9p4.3d3) is fifty of these, and a positional
// list of seven would let two strings swap places without a word from the compiler. The id
// is NOT among them — it is the key the entry is filed under, applied by `hostedVoices`.
interface VoiceEntry {
  readonly bytes: number;
  readonly sha256: string;
  readonly from: VoiceOrigin;
  readonly licence: "CC0-1.0" | "CC-BY-4.0";
  readonly attribution: string;
  readonly sample: Pinned;
  readonly qualities: VoiceQualities;
}

const voice = (id: VoiceId, { bytes, sha256, from, licence, attribution, sample, qualities }: VoiceEntry): VoiceAsset => ({
  name: `voice-${id}`,
  bytes,
  sha256,
  sample,
  qualities,
  source: from(id),
  licence,
  attribution,
});

// [LAW:one-source-of-truth] A voice's id is written ONCE, as the key it is filed under:
// the asset's name, its published address and the upstream state it is checked against are
// all derived from that one string. `Record<VoiceId, …>` still requires every id in
// VOICE_IDS to have an entry, so the cast below asserts only what the map guarantees.
const hostedVoices = (entries: Readonly<Record<VoiceId, VoiceEntry>>): Readonly<Record<VoiceId, VoiceAsset>> =>
  Object.fromEntries(VOICE_IDS.map((id) => [id, voice(id, entries[id])])) as Readonly<Record<VoiceId, VoiceAsset>>;

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
  // Where it sounds from: "American", "English", "North American".
  readonly accent: string;
  readonly register: VoiceRegister;
}

// A hosted voice: its embedding, the sample rendered from it (voiceSample.ts) pinned beside
// it so a sample can never quietly stand for other bytes than the voice's own, and what it
// sounds like.
//
// HOW THE QUALITIES WERE ARRIVED AT. Not from the corpora's speaker sheets, which describe
// the person who was recorded rather than the voice this model synthesizes, and not from
// the names, which promise things they cannot keep: the catalogue used to host a voice
// called Alba — a woman's name over a man's voice — and removing that confusion is half of
// why these three words exist. Each was measured from the voice's own donated recording and
// from the sample the reader hears: pitch and its spread (median f0, and the tenth to the
// ninetieth percentile), pace (words over the sample's speech), texture (harmonics-to-noise,
// jitter and shimmer — Javert and Charles read low because the donors' voices are breathy
// and gravelly, not because the recordings are noisy: denoising them moves nothing), and
// accent by a CommonAccent classifier. A new voice is described the same way.
//
// REGISTER IS NOT MEASURED. Brandon labelled every voice masculine or feminine by ear on the
// audition board, and a classifier over a four-second sample does not overrule a person who
// listened to it [LAW:one-source-of-truth].
//
// WHERE THE RECORDING AND THE SAMPLE DISAGREE, THE SAMPLE WINS, because the sample is the
// voice: the recording says who donated it, and the reader never hears that. Caro Davy is
// the standing case. Her donated recording leads Scottish (0.45 over England's 0.31 — itself
// too thin to name), while the voice the model makes of her reads English on the sample by a
// clear 0.23. Calling her Scottish would be the same false promise as the names.
//
// AND A CLAIM IS NO FIRMER THAN ITS MARGIN. The classifier emits a score per label, not a
// distribution, so the top label is worth only the distance to its runner-up: where the two
// are neighbours within about 0.15 the region is named instead of the country. Michael is
// the extreme case — us 0.53 against canada 0.52 — and reads North American, while Paul's
// England leads by 0.45 and is named flat.
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
    // Read from the mirrored parts, which the build proves against the sha256 above before
    // it writes one of them (scripts/modelAssetMirror.ts) — so these are derived from the
    // same bytes that hash, never a second claim about them.
    parts: [
      "42512019f87e14c63c080c61c9bb042482b598538d969ba45d8fdf39470850ab",
      "8d596c9c34d540a2d99d3edaf22fb8d952500656554609a739fb5c254ed4bbce",
      "1b6019d0a8a33a8267cfa97f27fbeccd58be4c70cc7250c4db1f23d8b3a821ef",
      "78cde992ec5fedc31a95696f49d2569125fd4899ed45016a351ce7af842004d6",
      "3e91bc31883857cc71f9121d71487f3481cfd1dd7f00a53169da2427a03534c5",
      "126f7e817b4dfe9a637ee920f4cd41d443566a85eb751b9df32798531086b2bd",
      "ea2b7455b32bbeec96661a5a35b61c1ea2fb3be97ff693983cc95688394b19ff",
      "bd32eeed1db32fd90ba4ba935f0839808c9feb046c812c39c6d839c22cc51fb7",
      "9785c125ef0dba47cee07cc064ed1808cb719abb75cc8aca70bca9bf6e99f3d0",
      "2b56d541e7ee89a008b7bfa77aac8c9c9807663433e4e5de3653a33eed538608",
    ],
    source: mirrored(
      "https://huggingface.co/ekzhang/jax-js-models/resolve/2b0fc51b4f76ff56611741ab9267593decde7639/kyutai-pocket-tts_b6369a24-fp16.safetensors",
    ),
    licence: "CC-BY-4.0",
    attribution: "Kyutai Pocket TTS (b6369a24), fp16 conversion by Eric Zhang for jax-js",
  },
  tokenizer: {
    name: "tokenizer",
    bytes: 59339,
    sha256: "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6",
    source: mirrored(`${KYUTAI_VOICES}/tokenizer.model`),
    licence: "CC-BY-4.0",
    attribution: "Kyutai Pocket TTS SentencePiece tokenizer",
  },
  voices: hostedVoices({
    caro_davy: {
      bytes: 434264,
      sha256: "e2e4c81fee0f07d7cfca6dbd79d1ff37ee9956c59b9f6ddd8042bdc1b45847c2",
      from: exportedFrom("voice-zero/caro_davy.wav"),
      licence: "CC0-1.0",
      attribution: "LibriVox reader Caro Davy via Kyutai tts-voices",
      sample: { bytes: 31470, sha256: "e5fcfcb2fb28a1f4de57e07cdeaa9d83378fd086f60fa30379dee3ea56972a9d" },
      qualities: { character: "Rich and unhurried", accent: "English", register: "feminine" },
    },
    charles: {
      bytes: 512088,
      sha256: "75efd9b32a2e93379bc8f9218c9fdc9ef42b70b151c6dbdd2b26d706151a72ed",
      from: exportedFrom("vctk/p254_023_enhanced.wav"),
      licence: "CC-BY-4.0",
      attribution: "VCTK p254 via Kyutai tts-voices",
      sample: { bytes: 24608, sha256: "1a4be840adda35adcd42cd711d9c834310d12086213dc00e8825b1a1b233797a" },
      qualities: { character: "Deep and gravelly", accent: "English", register: "masculine" },
    },
    eponine: {
      bytes: 573528,
      sha256: "bb31940f62da665391de139da2e57d740757df26b73d7ec24152c78a3b8ac0c5",
      from: kyutaiPrompt,
      licence: "CC-BY-4.0",
      attribution: "VCTK p262 via Kyutai tts-voices",
      sample: { bytes: 28241, sha256: "9a1be33f7646d06fc8ac6b75cda3be47cb5a9ff8c1f12bf4d95dc76995532ef8" },
      qualities: { character: "Warm and even", accent: "North American", register: "feminine" },
    },
    eve: {
      bytes: 540760,
      sha256: "1803aec45779b118b55c314ad222ceb3ab82077b2053f436884b311ad90f8070",
      from: exportedFrom("vctk/p361_023_enhanced.wav"),
      licence: "CC-BY-4.0",
      attribution: "VCTK p361 via Kyutai tts-voices",
      sample: { bytes: 19496, sha256: "a477da95b725a6a9fbc63c5a1165c268e877f084a45745219e8560ebf0b0d082" },
      qualities: { character: "Bright and quick", accent: "American", register: "feminine" },
    },
    george: {
      bytes: 516184,
      sha256: "bbd8d7f9f72fe51c15d645a6324c58911b70f5a107d06d5f7d5398c3440da7ed",
      from: exportedFrom("vctk/p315_023_enhanced.wav"),
      licence: "CC-BY-4.0",
      attribution: "VCTK p315 via Kyutai tts-voices",
      sample: { bytes: 22295, sha256: "6556d80cc5c5dbf906626a7c14b3071f91037173382ac66bb79776bfdbe813a5" },
      qualities: { character: "Husky and quick", accent: "American", register: "masculine" },
    },
    jane: {
      bytes: 610392,
      sha256: "0db8e9923b75032161bc9aa9ae3860f4df7991679c8af97bfa47e3f1eedd80f1",
      from: exportedFrom("vctk/p339_023_enhanced.wav"),
      licence: "CC-BY-4.0",
      attribution: "VCTK p339 via Kyutai tts-voices",
      sample: { bytes: 22843, sha256: "0502098acb3c8a157f3f53f631a8e6e60559712e1ac920e8c46e418c99d1f817" },
      qualities: { character: "Crisp and clear", accent: "North American", register: "feminine" },
    },
    javert: {
      bytes: 512088,
      sha256: "2e857904ee76657e083b0e92664d21bd133e37df320af6eb04f752e679422d91",
      from: kyutaiPrompt,
      licence: "CC0-1.0",
      attribution: "voice-donations/Butter via Kyutai tts-voices",
      sample: { bytes: 39672, sha256: "db03a37eedc8df9bc6490f2ea76cf7a405b968c94e0c8b58bac2f2dc7eb5af0f" },
      qualities: { character: "Deep and breathy", accent: "American", register: "masculine" },
    },
    michael: {
      bytes: 602200,
      sha256: "065367ae2f905a7b98c797b7b5c8b0d2f61b1e5be8a533e2be1a095c22e7ebc2",
      from: exportedFrom("vctk/p360_023_enhanced.wav"),
      licence: "CC-BY-4.0",
      attribution: "VCTK p360 via Kyutai tts-voices",
      sample: { bytes: 24830, sha256: "f006d36144163b2c24ce47acf759be931e3def32baedae0ca3741fd703769884" },
      qualities: { character: "Low and steady", accent: "North American", register: "masculine" },
    },
    paul: {
      bytes: 577624,
      sha256: "94b9391c450969a43ab6528083b73c85279e99fd99d0c37c170da078d69961e0",
      from: exportedFrom("vctk/p259_023_enhanced.wav"),
      licence: "CC-BY-4.0",
      attribution: "VCTK p259 via Kyutai tts-voices",
      sample: { bytes: 24097, sha256: "e1a073089b88574fb96d82f559757cf9ee238a222e0003d956f35525682eea09" },
      qualities: { character: "Dry and even", accent: "English", register: "masculine" },
    },
    peter_yearsley: {
      bytes: 307288,
      sha256: "d9bfa20ce5817e83924f03c7de71bcbc88976f8e91421fdaa26968a209da602c",
      from: exportedFrom("voice-zero/peter_yearsley.wav"),
      licence: "CC0-1.0",
      attribution: "LibriVox reader Peter Yearsley via Kyutai tts-voices",
      sample: { bytes: 26271, sha256: "37e1052409f4764990477ac56ab986706a18aa3d94911630e0f76d549c03ccf8" },
      qualities: { character: "Low and lively", accent: "English", register: "masculine" },
    },
    vera: {
      bytes: 557144,
      sha256: "964319ff19c8f27a167f96e288f032de0d72a98cb14c7842b7f8badda2c251ee",
      from: exportedFrom("vctk/p229_023_enhanced.wav"),
      licence: "CC-BY-4.0",
      attribution: "VCTK p229 via Kyutai tts-voices",
      sample: { bytes: 22885, sha256: "fa7987240e31992d7acb2c559aaada24e4b15beacceb5d353f62535853001024" },
      qualities: { character: "Smooth and calm", accent: "English", register: "feminine" },
    },
  }),
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

// Where an `exported` asset's bytes are kept, relative to the repo root. Content-addressed
// like every other path here [LAW:one-source-of-truth]: re-exporting a voice writes a new
// file rather than editing one, so a stale copy is never mistaken for the current pin.
//
// These bytes are checked in — the only model bytes that are — because nobody publishes
// them (see `AssetOrigin`), and a deploy that had to run torch to get them would be a
// deploy nobody could run. They are the same kind of derived-but-committed artifact as the
// voice samples under public/voices/, made by a script from pinned inputs.
export const EXPORTED_VOICE_DIR = "assets/voices";

export const exportedVoiceFile = (asset: ModelAsset): string =>
  `${EXPORTED_VOICE_DIR}/${asset.name}-${asset.sha256.slice(0, SHA_PREFIX_CHARS)}.safetensors`;

export interface Shard {
  readonly url: string;
  readonly start: number;
  readonly end: number;
  // What these bytes must hash to. Every part carries one, so a part is provable alone.
  readonly sha256: string;
}

// [LAW:parse-dont-validate] The hash of every part of an asset, proven to be one per part
// before any of them is used. A cut asset that names no parts — or names the wrong number —
// is a manifest nobody can verify a download against, and is thrown rather than loaded past
// [LAW:no-silent-failure].
const partHashes = (asset: ModelAsset, count: number): readonly string[] => {
  const named = asset.parts ?? [asset.sha256];
  if (named.length !== count) {
    throw new Error(`${asset.name}: ${asset.bytes} bytes cut into ${count} parts, but the manifest names ${named.length} part hashes`);
  }
  return named;
};

// [LAW:dataflow-not-control-flow] The one cut rule. ceil(bytes / SHARD_BYTES) contiguous
// half-open ranges, at least one (an empty asset would still name one part; none is empty).
export const shardPlan = (asset: ModelAsset): readonly Shard[] => {
  const key = assetKey(asset);
  const count = Math.max(1, Math.ceil(asset.bytes / SHARD_BYTES));
  const hashes = partHashes(asset, count);
  return Array.from({ length: count }, (_, i) => ({
    url: `${key}.part${i}`,
    start: i * SHARD_BYTES,
    end: Math.min(asset.bytes, (i + 1) * SHARD_BYTES),
    sha256: hashes[i] as string,
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
